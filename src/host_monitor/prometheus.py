from __future__ import annotations

import asyncio
import contextlib
import hashlib
import importlib.resources
import json
import logging
import math
import mimetypes
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

from . import __version__
from .config import CollectorSettings, PrometheusSettings
from .dashboard import (
    DASHBOARD_CAPACITY,
    DEFAULT_DASHBOARD_SERIES,
    MAX_HISTORY_SECONDS,
    DashboardSnapshot,
    DashboardStore,
    load_history_window,
    load_recent_history,
)
from .errors import MonitorError, RuleError
from .rules import RuleStore
from .state import StateStore


LOGGER = logging.getLogger("host_monitor.prometheus")
INVALID_NAME = re.compile(r"[^a-zA-Z0-9_:]")
PLUGIN_NAME = re.compile(r"^[a-zA-Z0-9_]+$")
WEB_EXECUTOR_WORKERS = 4


@dataclass(frozen=True)
class StateSnapshot:
    host: str
    updated_at: float
    metrics: dict[str, float]
    fields: dict[str, Any]


def _base_metric_name(source: str) -> str:
    normalized = INVALID_NAME.sub("_", source).strip("_")
    return f"hostmon_{normalized or 'metric'}"


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
    websocket_clients: int = 0,
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
        "# HELP hostmon_dashboard_websocket_clients Connected dashboard clients.",
        "# TYPE hostmon_dashboard_websocket_clients gauge",
        f"hostmon_dashboard_websocket_clients {websocket_clients}",
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


def _event_payload(snapshot: DashboardSnapshot) -> str:
    return json.dumps(
        {
            "timestamp": snapshot.timestamp,
            "host": snapshot.host,
            "metrics": snapshot.metrics,
            "fields": snapshot.fields,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


class PrometheusExporter:
    def __init__(
        self,
        settings: PrometheusSettings,
        state_file: Path,
        history_directory: Path | None = None,
        rules_file: Path | None = None,
        collector_settings: tuple[CollectorSettings, ...] = (),
        interval_seconds: float = 10.0,
    ):
        self.settings = settings
        self.state_file = state_file
        self.history_directory = history_directory
        self.rules = RuleStore(rules_file) if rules_file is not None else None
        self.collector_settings = collector_settings
        self.interval_seconds = interval_seconds
        self.reader = StateSnapshotReader(state_file)
        self.dashboard = DashboardStore()
        self.thread: threading.Thread | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self._stop_event: asyncio.Event | None = None
        self._ready = threading.Event()
        self._startup_error: BaseException | None = None
        self._address: tuple[str, int] | None = None
        self._clients: dict[
            web.WebSocketResponse, asyncio.Queue[str]
        ] = {}
        self._runner: web.AppRunner | None = None
        self._catalog_responses: dict[
            float, tuple[int, bytes]
        ] = {}

    @property
    def address(self) -> tuple[str, int] | None:
        return self._address

    def _snapshot(self) -> StateSnapshot:
        latest = self.dashboard.latest()
        if latest is not None:
            return StateSnapshot(
                host=latest.host,
                updated_at=latest.timestamp,
                metrics=latest.metrics,
                fields=latest.fields,
            )
        return self.reader.read()

    @staticmethod
    def _json_response(payload: Any, status: int = 200) -> web.Response:
        response = web.Response(
            text=json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            status=status,
            content_type="application/json",
            charset="utf-8",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )
        return response

    @staticmethod
    def _error(error: MonitorError) -> web.Response:
        return web.Response(
            text=f"{error}\n",
            status=503,
            content_type="text/plain",
            charset="utf-8",
            headers={"Cache-Control": "no-store"},
        )

    async def _metrics(self, request: web.Request) -> web.Response:
        try:
            snapshot = self._snapshot()
        except MonitorError as error:
            return self._error(error)
        return web.Response(
            text=render_prometheus(
                snapshot,
                websocket_clients=len(self._clients),
            ),
            content_type="text/plain",
            charset="utf-8",
            headers={"Cache-Control": "no-store"},
        )

    async def _health(self, request: web.Request) -> web.Response:
        try:
            snapshot = self._snapshot()
        except MonitorError as error:
            return self._error(error)
        age = max(0.0, time.time() - snapshot.updated_at)
        healthy = age <= self.settings.max_sample_age_seconds
        return web.Response(
            text="ok\n" if healthy else f"stale sample age={age:.3f}s\n",
            status=200 if healthy else 503,
            content_type="text/plain",
            charset="utf-8",
            headers={"Cache-Control": "no-store"},
        )

    async def _status(self, request: web.Request) -> web.Response:
        try:
            snapshot = self._snapshot()
        except MonitorError as error:
            return self._error(error)
        return self._json_response(
            {
                "host": snapshot.host,
                "version": __version__,
                "updated_at": snapshot.updated_at,
                "metrics": snapshot.metrics,
                "fields": snapshot.fields,
                "websocket_clients": len(self._clients),
            }
        )

    async def _history(self, request: web.Request) -> web.Response:
        try:
            seconds = float(request.query.get("seconds", "3600"))
            maximum = int(request.query.get("max_points", "1800"))
        except ValueError:
            return web.Response(
                text="seconds and max_points must be numeric\n",
                status=400,
                content_type="text/plain",
            )
        if not 10 <= seconds <= MAX_HISTORY_SECONDS or not 2 <= maximum <= 5000:
            return web.Response(
                text=(
                    f"seconds must be 10..{MAX_HISTORY_SECONDS} "
                    "and max_points must be 2..5000\n"
                ),
                status=400,
                content_type="text/plain",
            )
        raw_metrics = request.query.get("metrics")
        metrics = (
            [item for item in raw_metrics.split(",") if item]
            if raw_metrics
            else None
        )
        if seconds > 21600 and self.history_directory is not None:
            payload = await asyncio.to_thread(
                load_history_window,
                self.history_directory,
                now=time.time(),
                seconds=seconds,
                maximum_points=maximum,
                metrics=metrics or list(DEFAULT_DASHBOARD_SERIES),
            )
        else:
            try:
                payload = self.dashboard.history(
                    now=time.time(),
                    seconds=seconds,
                    maximum_points=maximum,
                    metrics=metrics,
                )
            except ValueError as error:
                return web.Response(
                    text=f"{error}\n",
                    status=400,
                    content_type="text/plain",
                )
        return self._json_response(payload)

    async def _catalog(self, request: web.Request) -> web.Response:
        try:
            seconds = float(request.query.get("seconds", "3600"))
        except ValueError:
            return web.Response(
                text="seconds must be numeric\n",
                status=400,
                content_type="text/plain",
            )
        if not 10 <= seconds <= 21600:
            return web.Response(
                text="seconds must be 10..21600\n",
                status=400,
                content_type="text/plain",
            )
        revision, entries = self.dashboard.catalog_snapshot(
            now=time.time(),
            seconds=seconds,
        )
        cache_key = round(seconds, 3)
        cached = self._catalog_responses.get(cache_key)
        if cached is None or cached[0] != revision:
            body = json.dumps(
                {"seconds": seconds, "metrics": entries},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
            if len(self._catalog_responses) >= 16:
                self._catalog_responses.clear()
            self._catalog_responses[cache_key] = (revision, body)
        else:
            body = cached[1]
        return web.Response(
            body=body,
            content_type="application/json",
            charset="utf-8",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    async def _plugin_document(self, request: web.Request) -> web.Response:
        name = request.match_info["name"]
        if not PLUGIN_NAME.fullmatch(name):
            raise web.HTTPNotFound()
        try:
            state = self.reader.store.load()
        except MonitorError as error:
            return self._error(error)
        envelope = (state.get("collectors") or {}).get(name)
        plugin_state = (
            envelope.get("plugin_state")
            if isinstance(envelope, dict)
            else None
        )
        document = (
            plugin_state.get("report")
            if isinstance(plugin_state, dict)
            else None
        )
        if document is None:
            raise web.HTTPNotFound(text=f"plugin document not found: {name}\n")
        return self._json_response(
            {
                "name": name,
                "updated_at": plugin_state.get("at"),
                "document": document,
            }
        )

    def _require_same_origin(self, request: web.Request) -> None:
        origin = request.headers.get("Origin")
        if origin and urlsplit(origin).netloc != request.host:
            raise web.HTTPForbidden(text="Origin is not allowed\n")

    def _rule_store(self) -> RuleStore:
        if self.rules is None:
            raise web.HTTPNotFound(text="Rule management is not configured\n")
        return self.rules

    async def _rules_list(self, request: web.Request) -> web.Response:
        try:
            return self._json_response({"rules": self._rule_store().entries()})
        except RuleError as error:
            return self._json_response({"error": str(error)}, status=400)

    async def _rules_add(self, request: web.Request) -> web.Response:
        self._require_same_origin(request)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise RuleError("rule must be a JSON object")
            self._rule_store().add(payload)
            return self._json_response(payload, status=201)
        except (json.JSONDecodeError, RuleError) as error:
            return self._json_response({"error": str(error)}, status=400)

    async def _rules_replace(self, request: web.Request) -> web.Response:
        self._require_same_origin(request)
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise RuleError("rule must be a JSON object")
            self._rule_store().replace(request.match_info["name"], payload)
            return self._json_response(payload)
        except (json.JSONDecodeError, RuleError) as error:
            return self._json_response({"error": str(error)}, status=400)

    async def _rules_delete(self, request: web.Request) -> web.Response:
        self._require_same_origin(request)
        try:
            self._rule_store().remove(request.match_info["name"])
            return web.Response(status=204)
        except RuleError as error:
            return self._json_response({"error": str(error)}, status=404)

    async def _collector_diagnostics(
        self,
        request: web.Request,
    ) -> web.Response:
        try:
            state = self.reader.store.load()
        except MonitorError as error:
            return self._error(error)
        envelopes = state.get("collectors", {})
        diagnostics = []
        for setting in self.collector_settings:
            envelope = (
                envelopes.get(setting.name, {})
                if isinstance(envelopes, dict)
                else {}
            )
            if not isinstance(envelope, dict):
                envelope = {}
            refresh = setting.options.get(
                "poll_interval_seconds",
                self.interval_seconds,
            )
            diagnostics.append(
                {
                    "name": setting.name,
                    "enabled": setting.enabled,
                    "required": setting.required,
                    "refresh_seconds": float(refresh),
                    "deadline_seconds": setting.deadline_seconds,
                    "max_stale_seconds": setting.max_stale_seconds,
                    "last_success_at": envelope.get("last_success_at"),
                    "last_failure_at": envelope.get("last_failure_at"),
                    "last_error": envelope.get("last_error"),
                    "options": setting.options,
                }
            )
        return self._json_response({"collectors": diagnostics})

    async def _websocket(self, request: web.Request) -> web.StreamResponse:
        origin = request.headers.get("Origin")
        if origin and urlsplit(origin).netloc != request.host:
            raise web.HTTPForbidden(text="WebSocket origin is not allowed\n")
        socket = web.WebSocketResponse(
            heartbeat=20,
            receive_timeout=None,
            max_msg_size=64 * 1024,
            compress=True,
        )
        await socket.prepare(request)
        messages: asyncio.Queue[str] = asyncio.Queue(maxsize=1)
        self._clients[socket] = messages
        sender = asyncio.create_task(self._websocket_sender(socket, messages))
        latest = self.dashboard.latest()
        if latest is not None:
            messages.put_nowait(_event_payload(latest))
        try:
            async for message in socket:
                if message.type == WSMsgType.TEXT and message.data == "ping":
                    self._enqueue_latest(messages, '{"type":"pong"}')
                elif message.type in {
                    WSMsgType.ERROR,
                    WSMsgType.CLOSE,
                    WSMsgType.CLOSED,
                }:
                    break
        finally:
            self._clients.pop(socket, None)
            sender.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await sender
        return socket

    @staticmethod
    async def _websocket_sender(
        socket: web.WebSocketResponse,
        messages: asyncio.Queue[str],
    ) -> None:
        try:
            while not socket.closed:
                await socket.send_str(await messages.get())
        except (ConnectionError, RuntimeError):
            return

    @staticmethod
    def _static_root() -> Any:
        return importlib.resources.files("host_monitor").joinpath("static/dashboard")

    async def _asset(self, request: web.Request) -> web.Response:
        requested = request.match_info.get("path", "") or "index.html"
        if requested.startswith("api/"):
            raise web.HTTPNotFound()
        path = PurePosixPath(requested)
        if path.is_absolute() or ".." in path.parts:
            raise web.HTTPNotFound()
        root = self._static_root()
        asset = root.joinpath(*path.parts)
        if not asset.is_file():
            asset = root.joinpath("index.html")
        try:
            body = asset.read_bytes()
        except OSError as error:
            raise web.HTTPNotFound() from error
        content_type, _ = mimetypes.guess_type(asset.name)
        immutable = "/assets/" in f"/{requested}"
        response = web.Response(
            body=body,
            content_type=content_type or "application/octet-stream",
            headers={
                "Cache-Control": (
                    "public, max-age=31536000, immutable"
                    if immutable
                    else "no-cache"
                ),
                "X-Content-Type-Options": "nosniff",
            },
        )
        if (content_type or "").startswith(("text/", "application/javascript")):
            response.enable_compression()
        return response

    @web.middleware
    async def _security_headers(
        self,
        request: web.Request,
        handler: Callable[[web.Request], Awaitable[web.StreamResponse]],
    ) -> web.StreamResponse:
        response = await handler(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; connect-src 'self' ws: wss:; "
            "script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; frame-ancestors 'none'"
        )
        return response

    def _application(self) -> web.Application:
        application = web.Application(
            client_max_size=128 * 1024,
            middlewares=[self._security_headers],
        )
        application.add_routes(
            [
                web.get("/metrics", self._metrics),
                web.get("/healthz", self._health),
                web.get("/api/status", self._status),
                web.get("/api/history", self._history),
                web.get("/api/catalog", self._catalog),
                web.get("/api/rules", self._rules_list),
                web.post("/api/rules", self._rules_add),
                web.put("/api/rules/{name}", self._rules_replace),
                web.delete("/api/rules/{name}", self._rules_delete),
                web.get("/api/collectors", self._collector_diagnostics),
                web.get("/api/plugins/{name}", self._plugin_document),
                web.get("/api/ws", self._websocket),
                web.get("/{path:.*}", self._asset),
            ]
        )
        return application

    async def _serve(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.loop.set_default_executor(
            ThreadPoolExecutor(
                max_workers=WEB_EXECUTOR_WORKERS,
                thread_name_prefix="hostmon-web",
            )
        )
        self._stop_event = asyncio.Event()
        self._runner = web.AppRunner(
            self._application(),
            access_log=None,
            keepalive_timeout=75,
            shutdown_timeout=2,
        )
        try:
            await self._runner.setup()
            site = web.TCPSite(
                self._runner,
                self.settings.host,
                self.settings.port,
            )
            await site.start()
            addresses = self._runner.addresses
            if not addresses:
                raise MonitorError("Prometheus server did not expose an address")
            host, port = addresses[0][:2]
            self._address = str(host), int(port)
            self._ready.set()
            await self._stop_event.wait()
        except Exception as error:
            self._startup_error = error
            if self._ready.is_set():
                LOGGER.exception("hostmon web server stopped unexpectedly")
            self._ready.set()
        finally:
            for socket in tuple(self._clients):
                await socket.close(code=1001, message=b"server shutdown")
            self._clients.clear()
            if self._runner is not None:
                await self._runner.cleanup()
            self._runner = None

    def _thread_main(self) -> None:
        asyncio.run(self._serve())

    def start(self) -> None:
        if not self.settings.enabled:
            return
        try:
            if self.history_directory is not None:
                self.dashboard.seed_records(
                    load_recent_history(
                        self.history_directory,
                        DASHBOARD_CAPACITY,
                    )
                )
            self.dashboard.seed(self.reader.store.load())
        except MonitorError as error:
            LOGGER.warning("could not seed dashboard history: %s", error)
        self._ready.clear()
        self._startup_error = None
        self.thread = threading.Thread(
            target=self._thread_main,
            name="hostmon-web",
            daemon=True,
        )
        self.thread.start()
        if not self._ready.wait(timeout=10):
            self.close()
            raise MonitorError("timed out while starting the hostmon HTTP server")
        if self._startup_error is not None:
            error = self._startup_error
            self.close()
            raise MonitorError(
                f"cannot listen on Prometheus endpoint "
                f"{self.settings.host}:{self.settings.port}: {error}"
            ) from error
        LOGGER.info(
            "hostmon web server listening on http://%s:%s",
            *self.address,
        )

    def _schedule_broadcast(self, snapshot: DashboardSnapshot) -> None:
        payload = _event_payload(snapshot)
        for messages in tuple(self._clients.values()):
            self._enqueue_latest(messages, payload)

    @staticmethod
    def _enqueue_latest(messages: asyncio.Queue[str], payload: str) -> None:
        if messages.full():
            with contextlib.suppress(asyncio.QueueEmpty):
                messages.get_nowait()
        with contextlib.suppress(asyncio.QueueFull):
            messages.put_nowait(payload)

    def publish(
        self,
        timestamp: float,
        host: str,
        metrics: dict[str, Any],
        fields: dict[str, Any],
    ) -> None:
        if not self.settings.enabled:
            return
        self.dashboard.publish(timestamp, host, metrics, fields)
        snapshot = self.dashboard.latest()
        loop = self.loop
        if snapshot is not None and loop is not None and loop.is_running():
            try:
                loop.call_soon_threadsafe(self._schedule_broadcast, snapshot)
            except RuntimeError:
                LOGGER.warning("dashboard WebSocket loop stopped before publish")

    def close(self) -> None:
        loop = self.loop
        stop_event = self._stop_event
        if loop is not None and stop_event is not None and loop.is_running():
            loop.call_soon_threadsafe(stop_event.set)
        if self.thread is not None:
            self.thread.join(timeout=5)
            if self.thread.is_alive():
                LOGGER.error("hostmon web server did not stop within 5 seconds")
        self.thread = None
        self.loop = None
        self._stop_event = None
        self._address = None
