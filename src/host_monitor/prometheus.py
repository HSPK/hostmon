from __future__ import annotations

import hashlib
import importlib.resources
import json
import logging
import math
import queue
import re
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .config import PrometheusSettings
from .dashboard import DashboardSnapshot, DashboardStore
from .errors import MonitorError
from .state import StateStore


LOGGER = logging.getLogger("host_monitor.prometheus")
INVALID_NAME = re.compile(r"[^a-zA-Z0-9_:]")


@lru_cache(maxsize=1)
def dashboard_html() -> bytes:
    return (
        importlib.resources.files("host_monitor")
        .joinpath("static/dashboard.html")
        .read_bytes()
    )


@dataclass(frozen=True)
class StateSnapshot:
    host: str
    updated_at: float
    metrics: dict[str, float]
    fields: dict[str, Any]


def _base_metric_name(source: str) -> str:
    normalized = INVALID_NAME.sub("_", source).strip("_")
    if not normalized:
        normalized = "metric"
    return f"hostmon_{normalized}"


def prometheus_names(sources: list[str]) -> dict[str, str]:
    grouped: dict[str, list[str]] = {}
    for source in sources:
        grouped.setdefault(_base_metric_name(source), []).append(source)
    names: dict[str, str] = {}
    for base, originals in grouped.items():
        if len(originals) == 1:
            names[originals[0]] = base
            continue
        for source in sorted(originals):
            digest = hashlib.sha1(source.encode("utf-8")).hexdigest()[:8]
            names[source] = f"{base}_{digest}"
    return names


def _help_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n")


def render_prometheus(
    snapshot: StateSnapshot,
    *,
    now: float | None = None,
) -> str:
    now = time.time() if now is None else now
    lines = [
        "# HELP hostmon_build_info hostmon build information.",
        "# TYPE hostmon_build_info gauge",
        f'hostmon_build_info{{version="{__version__}"}} 1',
        "# HELP hostmon_sample_timestamp_seconds Unix timestamp of the latest sample.",
        "# TYPE hostmon_sample_timestamp_seconds gauge",
        f"hostmon_sample_timestamp_seconds {snapshot.updated_at:.6f}",
        "# HELP hostmon_sample_age_seconds Age of the latest sample.",
        "# TYPE hostmon_sample_age_seconds gauge",
        f"hostmon_sample_age_seconds {max(0.0, now - snapshot.updated_at):.6f}",
    ]
    names = prometheus_names(list(snapshot.metrics))
    for source in sorted(snapshot.metrics):
        value = float(snapshot.metrics[source])
        if not math.isfinite(value):
            continue
        name = names[source]
        metric_type = "counter" if source.endswith("_total") else "gauge"
        lines.extend(
            [
                f"# HELP {name} {_help_text(f'hostmon metric {source}.')}",
                f"# TYPE {name} {metric_type}",
                f"{name} {value!r}",
            ]
        )
    return "\n".join(lines) + "\n"


class StateSnapshotReader:
    def __init__(self, state_file: Path):
        self.store = StateStore(state_file)

    def read(self) -> StateSnapshot:
        state = self.store.load()
        updated_at = state.get("updated_at")
        metrics = state.get("last_metrics")
        fields = state.get("last_fields", {})
        if not isinstance(updated_at, (int, float)) or not isinstance(metrics, dict):
            raise MonitorError("no completed hostmon sample is available")
        if not isinstance(fields, dict):
            raise MonitorError("latest hostmon template fields are invalid")
        numeric: dict[str, float] = {}
        for name, value in metrics.items():
            if not isinstance(name, str) or not isinstance(value, (int, float)):
                raise MonitorError("latest hostmon metrics are invalid")
            number = float(value)
            if math.isfinite(number):
                numeric[name] = number
        return StateSnapshot(
            host=str(state.get("host") or "localhost"),
            updated_at=float(updated_at),
            metrics=numeric,
            fields=dict(fields),
        )


class PrometheusHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        reader: StateSnapshotReader,
        dashboard: DashboardStore,
        max_sample_age_seconds: float,
    ):
        super().__init__(address, PrometheusHandler)
        self.reader = reader
        self.dashboard = dashboard
        self.max_sample_age_seconds = max_sample_age_seconds


class PrometheusHandler(BaseHTTPRequestHandler):
    server: PrometheusHTTPServer
    protocol_version = "HTTP/1.1"

    def _write(
        self,
        status: HTTPStatus,
        body: bytes,
        content_type: str,
        cache_control: str = "no-store",
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _snapshot(self) -> StateSnapshot | None:
        latest = self.server.dashboard.latest()
        if latest is not None:
            return StateSnapshot(
                host=latest.host,
                updated_at=latest.timestamp,
                metrics=latest.metrics,
                fields=latest.fields,
            )
        try:
            return self.server.reader.read()
        except MonitorError as error:
            self._write(
                HTTPStatus.SERVICE_UNAVAILABLE,
                f"{error}\n".encode("utf-8"),
                "text/plain; charset=utf-8",
            )
            return None

    @staticmethod
    def _event_payload(snapshot: DashboardSnapshot) -> bytes:
        return json.dumps(
            {
                "timestamp": snapshot.timestamp,
                "host": snapshot.host,
                "metrics": snapshot.metrics,
                "fields": snapshot.fields,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")

    def _stream(self) -> None:
        subscriber = self.server.dashboard.subscribe()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            while True:
                try:
                    snapshot = subscriber.get(timeout=15)
                    payload = self._event_payload(snapshot)
                    self.wfile.write(b"data: " + payload + b"\n\n")
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            return
        finally:
            self.server.dashboard.unsubscribe(subscriber)

    def _history(self, query: str) -> None:
        parameters = parse_qs(query)
        try:
            seconds = float(parameters.get("seconds", ["3600"])[0])
            maximum = int(parameters.get("max_points", ["1800"])[0])
        except ValueError:
            self._write(
                HTTPStatus.BAD_REQUEST,
                b"seconds and max_points must be numeric\n",
                "text/plain; charset=utf-8",
            )
            return
        if not 10 <= seconds <= 21600 or not 2 <= maximum <= 5000:
            self._write(
                HTTPStatus.BAD_REQUEST,
                b"seconds must be 10..21600 and max_points must be 2..5000\n",
                "text/plain; charset=utf-8",
            )
            return
        raw_metrics = parameters.get("metrics", [None])[0]
        metrics = (
            [item for item in raw_metrics.split(",") if item]
            if raw_metrics
            else None
        )
        try:
            payload = self.server.dashboard.history(
                now=time.time(),
                seconds=seconds,
                maximum_points=maximum,
                metrics=metrics,
            )
        except ValueError as error:
            self._write(
                HTTPStatus.BAD_REQUEST,
                f"{error}\n".encode("utf-8"),
                "text/plain; charset=utf-8",
            )
            return
        self._write(
            HTTPStatus.OK,
            json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        if parsed.path in {"/", "/dashboard"}:
            self._write(
                HTTPStatus.OK,
                dashboard_html(),
                "text/html; charset=utf-8",
                "public, max-age=3600",
            )
            return
        if parsed.path == "/api/stream":
            self._stream()
            return
        if parsed.path == "/api/history":
            self._history(parsed.query)
            return
        snapshot = self._snapshot()
        if snapshot is None:
            return
        if parsed.path == "/metrics":
            body = render_prometheus(snapshot).encode("utf-8")
            self._write(
                HTTPStatus.OK,
                body,
                "text/plain; version=0.0.4; charset=utf-8",
            )
            return
        if parsed.path == "/healthz":
            age = max(0.0, time.time() - snapshot.updated_at)
            healthy = age <= self.server.max_sample_age_seconds
            self._write(
                HTTPStatus.OK if healthy else HTTPStatus.SERVICE_UNAVAILABLE,
                ("ok\n" if healthy else f"stale sample age={age:.3f}s\n").encode(
                    "utf-8"
                ),
                "text/plain; charset=utf-8",
            )
            return
        if parsed.path == "/api/status":
            body = json.dumps(
                {
                    "host": snapshot.host,
                    "updated_at": snapshot.updated_at,
                    "metrics": snapshot.metrics,
                    "fields": snapshot.fields,
                },
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
            self._write(
                HTTPStatus.OK,
                body,
                "application/json; charset=utf-8",
            )
            return
        self._write(
            HTTPStatus.NOT_FOUND,
            b"not found\n",
            "text/plain; charset=utf-8",
        )

    def do_HEAD(self) -> None:
        if urlsplit(self.path).path == "/api/stream":
            self._write(
                HTTPStatus.METHOD_NOT_ALLOWED,
                b"",
                "text/plain; charset=utf-8",
            )
            return
        self.do_GET()

    def log_message(self, format: str, *args: Any) -> None:
        LOGGER.debug("%s - %s", self.client_address[0], format % args)


class PrometheusExporter:
    def __init__(
        self,
        settings: PrometheusSettings,
        state_file: Path,
    ):
        self.settings = settings
        self.state_file = state_file
        self.reader = StateSnapshotReader(state_file)
        self.dashboard = DashboardStore()
        self.server: PrometheusHTTPServer | None = None
        self.thread: threading.Thread | None = None

    @property
    def address(self) -> tuple[str, int] | None:
        if self.server is None:
            return None
        host, port = self.server.server_address[:2]
        return str(host), int(port)

    def start(self) -> None:
        if not self.settings.enabled:
            return
        try:
            self.dashboard.seed(self.reader.store.load())
        except MonitorError as error:
            LOGGER.warning("could not seed dashboard history: %s", error)
        try:
            self.server = PrometheusHTTPServer(
                (self.settings.host, self.settings.port),
                self.reader,
                self.dashboard,
                self.settings.max_sample_age_seconds,
            )
        except OSError as error:
            raise MonitorError(
                f"cannot listen on Prometheus endpoint "
                f"{self.settings.host}:{self.settings.port}: {error}"
            ) from error
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            name="hostmon-prometheus",
            daemon=True,
        )
        self.thread.start()
        LOGGER.info(
            "Prometheus exporter listening on http://%s:%s",
            *self.address,
        )

    def publish(
        self,
        timestamp: float,
        host: str,
        metrics: dict[str, Any],
        fields: dict[str, Any],
    ) -> None:
        if self.settings.enabled:
            self.dashboard.publish(timestamp, host, metrics, fields)

    def close(self) -> None:
        if self.server is None:
            return
        self.server.shutdown()
        self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=2)
        self.thread = None
        self.server = None
