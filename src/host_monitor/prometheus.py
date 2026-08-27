from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import __version__
from .config import PrometheusSettings
from .errors import MonitorError
from .state import StateStore


LOGGER = logging.getLogger("host_monitor.prometheus")
INVALID_NAME = re.compile(r"[^a-zA-Z0-9_:]")


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
        max_sample_age_seconds: float,
    ):
        super().__init__(address, PrometheusHandler)
        self.reader = reader
        self.max_sample_age_seconds = max_sample_age_seconds


class PrometheusHandler(BaseHTTPRequestHandler):
    server: PrometheusHTTPServer

    def _write(
        self,
        status: HTTPStatus,
        body: bytes,
        content_type: str,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _snapshot(self) -> StateSnapshot | None:
        try:
            return self.server.reader.read()
        except MonitorError as error:
            self._write(
                HTTPStatus.SERVICE_UNAVAILABLE,
                f"{error}\n".encode("utf-8"),
                "text/plain; charset=utf-8",
            )
            return None

    def do_GET(self) -> None:
        snapshot = self._snapshot()
        if snapshot is None:
            return
        if self.path == "/metrics":
            body = render_prometheus(snapshot).encode("utf-8")
            self._write(
                HTTPStatus.OK,
                body,
                "text/plain; version=0.0.4; charset=utf-8",
            )
            return
        if self.path == "/healthz":
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
        if self.path == "/api/status":
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
            self.server = PrometheusHTTPServer(
                (self.settings.host, self.settings.port),
                StateSnapshotReader(self.state_file),
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

    def close(self) -> None:
        if self.server is None:
            return
        self.server.shutdown()
        self.server.server_close()
        if self.thread is not None:
            self.thread.join(timeout=2)
        self.thread = None
        self.server = None
