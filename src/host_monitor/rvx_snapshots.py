from __future__ import annotations

import asyncio
import json
import math
import os
import re
import threading
import uuid
from collections import deque
from dataclasses import dataclass
from itertools import islice
from typing import Any, Callable

from aiohttp import web

from .config import RvxSnapshotSettings
from .errors import MonitorError


MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
MAX_PAGE_BYTES = 16 * 1024 * 1024
MAX_STATE_DEPTH = 64
MAX_STATE_NODES = 100_000
MAX_HISTORY_LIMIT = 256


def _validate_json(value: Any, depth: int = 0) -> int:
    """Reject lossy or unbounded values before encoding a public state object."""
    if depth > MAX_STATE_DEPTH:
        raise MonitorError("snapshot state exceeds the nesting limit of 64")
    if value is None or isinstance(value, bool):
        return 1
    if isinstance(value, int):
        if not -(2**63) <= value < 2**64:
            raise MonitorError("snapshot integer is outside the 64-bit JSON range")
        return 1
    if isinstance(value, float):
        if not math.isfinite(value):
            raise MonitorError("snapshot numbers must be finite")
        return 1
    if isinstance(value, str):
        if len(value) > MAX_SNAPSHOT_BYTES:
            raise MonitorError("snapshot string exceeds the 4 MiB size limit")
        return 1
    if not isinstance(value, (dict, list)):
        raise MonitorError("snapshot values must be JSON objects, arrays, or scalars")
    if isinstance(value, dict):
        for key in value:
            if not isinstance(key, str):
                raise MonitorError("snapshot object keys must be strings")
            if len(key) > MAX_SNAPSHOT_BYTES:
                raise MonitorError("snapshot object key exceeds the size limit")
        children = value.values()
    else:
        children = value
    count = 1
    for child in children:
        count += _validate_json(child, depth + 1)
        if count > MAX_STATE_NODES:
            raise MonitorError("snapshot state exceeds the 100000-node limit")
    return count


def _public_collectors(
    states: dict[str, Any], metrics: dict[str, Any], now: float,
) -> dict[str, Any]:
    """Publish collector health and declared documents, never private plugin state."""
    result: dict[str, Any] = {}
    for name, envelope in states.items():
        if not isinstance(envelope, dict):
            raise MonitorError(f"collector {name!r} has an invalid state envelope")
        public = {
            key: envelope[key]
            for key in (
                "last_success_at", "last_failure_at", "last_error",
                "duration_ms", "failures_total",
            )
            if key in envelope
        }
        component = re.sub(r"[^A-Za-z0-9_]+", "_", name).strip("_") or "collector"
        prefix = f"monitor/collector/{component}"
        public["up"] = bool(metrics.get(f"{prefix}/up", 0))
        public["stale"] = bool(metrics.get(f"{prefix}/stale", 0))
        success = envelope.get("last_success_at")
        if isinstance(success, (int, float)) and not isinstance(success, bool):
            public["age_seconds"] = max(0.0, now - success)
        plugin = envelope.get("plugin_state")
        if isinstance(plugin, dict) and "report" in plugin:
            public["document"] = plugin["report"]
            public["document_schema_version"] = plugin.get("schema_version")
            public["document_observed_at"] = plugin.get("at")
        result[name] = public
    return result


@dataclass(frozen=True)
class EncodedSnapshot:
    """Own one immutable full snapshot without keeping a duplicate object tree."""

    sequence: int
    payload: bytes


class RvxSnapshotBuffer:
    """Capture complete host observations into a bounded, process-local Pull buffer."""

    def __init__(self, settings: RvxSnapshotSettings, hostname: str):
        """Allocate a fresh Session without reusing legacy metric cursors or history."""
        if (
            isinstance(settings.capacity, bool)
            or not isinstance(settings.capacity, int)
            or not 1 <= settings.capacity <= 1_000_000
            or isinstance(settings.max_buffer_bytes, bool)
            or not isinstance(settings.max_buffer_bytes, int)
            or not 1 <= settings.max_buffer_bytes <= 1024 * 1024 * 1024
        ):
            raise MonitorError("invalid RVX snapshot buffer count or byte capacity")
        self.settings = settings
        self.hostname = hostname
        self.session_id = uuid.uuid4().hex
        self._lock = threading.Lock()
        self._snapshots: deque[EncodedSnapshot] = deque()
        self._next_sequence = 0
        self._buffer_bytes = 0
        self._capture_error: str | None = None

    def descriptor(self) -> dict[str, Any]:
        """Describe a full-state producer independently of whether it has captured."""
        return {
            "protocol_version": 1,
            "source_session_id": self.session_id,
            "project": self.settings.project,
            "experiment": self.settings.experiment or f"hostmon-{self.hostname}",
            "run_id": self.settings.run_id,
            "attempt_id": self.settings.attempt_id,
            "role": "hostmon",
            "rank": None,
            "node_id": self.hostname,
            "pid": os.getpid(),
            "labels": {"source": "hostmon"},
            "schema_version": 1,
        }

    def capture(
        self,
        timestamp: float,
        host: str,
        metrics: dict[str, Any],
        fields: dict[str, Any],
        collectors: dict[str, Any],
        alerts: list[dict[str, Any]],
        *,
        step: int,
    ) -> int:
        """Freeze a full observation; failed captures surface as HTTP 503 until recovery."""
        try:
            if (
                isinstance(timestamp, bool)
                or not math.isfinite(timestamp)
                or not 0 <= timestamp * 1_000_000_000 < 2**63
            ):
                raise MonitorError("snapshot observation time must fit signed nanoseconds")
            if isinstance(step, bool) or not isinstance(step, int) or not 0 <= step < 2**63:
                raise MonitorError("hostmon snapshot step must be a non-negative integer")
            state = {
                "host": host,
                "metrics": metrics,
                "fields": fields,
                "collectors": _public_collectors(collectors, metrics, timestamp),
                "alerts": [
                    {key: alert[key] for key in ("title", "level", "message") if key in alert}
                    for alert in alerts
                ],
            }
            try:
                _validate_json(state)
                encoded_state = json.dumps(
                    state, ensure_ascii=False, allow_nan=False, separators=(",", ":"),
                ).encode("utf-8")
            except RuntimeError as error:
                raise MonitorError("public state changed during snapshot capture") from error
            observed_at_ns = int(timestamp * 1_000_000_000)
            with self._lock:
                sequence = self._next_sequence
                if sequence >= 2**63 - 1:
                    raise MonitorError("snapshot sequence is exhausted; restart the producer")
                header = (
                    f'{{"source_session_id":"{self.session_id}",'
                    f'"sequence":{sequence},"observed_at_ns":{observed_at_ns},'
                    f'"schema_version":1,"axes":{{"hostmon_sample":{step}}},"state":'
                ).encode("ascii")
                size = len(header) + len(encoded_state) + 1
                if size > min(MAX_SNAPSHOT_BYTES, self.settings.max_buffer_bytes):
                    raise MonitorError("snapshot exceeds the 4 MiB or configured buffer byte limit")
                payload = header + encoded_state + b"}"
                self._snapshots.append(EncodedSnapshot(sequence, payload))
                self._next_sequence += 1
                self._buffer_bytes += len(payload)
                while (
                    len(self._snapshots) > self.settings.capacity
                    or self._buffer_bytes > self.settings.max_buffer_bytes
                ):
                    self._buffer_bytes -= len(self._snapshots.popleft().payload)
                self._capture_error = None
                return sequence
        except (MonitorError, ValueError, TypeError, UnicodeError, OverflowError) as error:
            with self._lock:
                self._capture_error = str(error)
            raise MonitorError(f"RVX snapshot capture failed: {error}") from error

    def latest(self) -> bytes:
        """Return the immutable latest object, not a union of earlier field values."""
        with self._lock:
            if self._capture_error:
                raise MonitorError(self._capture_error)
            if not self._snapshots:
                raise MonitorError("no completed hostmon state snapshot is available")
            return self._snapshots[-1].payload

    def history(self, *, after: int, limit: int = 64) -> bytes:
        """Return cursor pages with explicit retention gaps and bounded wire size."""
        if isinstance(after, bool) or not isinstance(after, int) or not 0 <= after < 2**63:
            raise ValueError("after must be a non-negative signed 64-bit integer")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= MAX_HISTORY_LIMIT:
            raise ValueError("limit must be 1..256")
        with self._lock:
            if self._capture_error:
                raise MonitorError(self._capture_error)
            if after > self._next_sequence:
                raise ValueError("after is beyond the producer's next sequence")
            oldest = self._snapshots[0].sequence if self._snapshots else self._next_sequence
            selected: list[EncodedSnapshot] = []
            size = 4096
            start = max(0, after - oldest)
            for snapshot in islice(self._snapshots, start, start + limit):
                if size + len(snapshot.payload) + 1 > MAX_PAGE_BYTES:
                    break
                selected.append(snapshot)
                size += len(snapshot.payload) + 1
            next_sequence = selected[-1].sequence + 1 if selected else max(after, oldest)
        envelope = json.dumps({
            "protocol_version": 1,
            "source_session_id": self.session_id,
            "oldest_sequence": oldest,
            "next_sequence": next_sequence,
            "dropped_before": oldest if after < oldest else None,
        }, separators=(",", ":")).encode("utf-8")
        return envelope[:-1] + b',"snapshots":[' + b",".join(
            snapshot.payload for snapshot in selected
        ) + b"]}"


class RvxSnapshotsAPI:
    """Mount only the structured-state Pull protocol on hostmon's existing server."""

    def __init__(
        self,
        buffer: RvxSnapshotBuffer | None,
        respond: Callable[..., web.Response],
    ):
        """Bind immutable snapshot reads without importing the RVX engine or SDK."""
        self.buffer = buffer
        self.respond = respond

    def routes(self) -> list[web.RouteDef]:
        """Declare the three read-only full-state protocol routes."""
        return [
            web.get("/v1/snapshots/descriptor", self.descriptor),
            web.get("/v1/snapshots/latest", self.latest),
            web.get("/v1/snapshots/history", self.history),
        ]

    def _enabled(self) -> RvxSnapshotBuffer:
        """Reject disabled production rather than presenting empty successful state."""
        if self.buffer is None:
            raise web.HTTPNotFound(text="hostmon RVX snapshot server is disabled\n")
        return self.buffer

    @staticmethod
    def _encoded(payload: bytes) -> web.Response:
        """Send cached full-state bytes without decoding or serializing on the HTTP loop."""
        return web.Response(
            body=payload,
            content_type="application/json",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    async def descriptor(self, request: web.Request) -> web.Response:
        """Expose Source identity and the state schema, not metric definitions."""
        return self.respond(self._enabled().descriptor())

    async def latest(self, request: web.Request) -> web.Response:
        """Serve exactly the last completed capture or an explicit unavailable response."""
        buffer = self._enabled()
        try:
            return self._encoded(buffer.latest())
        except MonitorError as error:
            return self.respond({"error": str(error)}, status=503)

    async def history(self, request: web.Request) -> web.Response:
        """Serve retained full snapshots without reconstructing the original JSONL log."""
        buffer = self._enabled()
        try:
            after = int(request.query.get("after", "0"))
            limit = int(request.query.get("limit", "64"))
            payload = await asyncio.to_thread(
                buffer.history, after=after, limit=limit,
            )
            return self._encoded(payload)
        except ValueError as error:
            return self.respond({"error": str(error)}, status=400)
        except MonitorError as error:
            return self.respond({"error": str(error)}, status=503)
