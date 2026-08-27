from __future__ import annotations

import math
import json
import threading
from bisect import bisect_left
from collections import deque
from colorsys import hls_to_rgb
from dataclasses import dataclass
from hashlib import sha1
from typing import Any
from pathlib import Path


DASHBOARD_CAPACITY = 2160
MAX_DASHBOARD_METRICS = 512
DEFAULT_DASHBOARD_SERIES: dict[str, dict[str, str]] = {
    "cpu/percent": {"label": "CPU", "unit": "%", "color": "#66d9ef"},
    "memory/percent": {"label": "Memory", "unit": "%", "color": "#a6e22e"},
    "disk/percent": {"label": "Disk", "unit": "%", "color": "#fd971f"},
    "network/rx_mbps": {
        "label": "Network RX",
        "unit": "Mbps",
        "color": "#ae81ff",
    },
    "network/tx_mbps": {
        "label": "Network TX",
        "unit": "Mbps",
        "color": "#f92672",
    },
    "gpu/percent": {"label": "GPU", "unit": "%", "color": "#00d4aa"},
    "gpu/memory_percent": {
        "label": "GPU memory",
        "unit": "%",
        "color": "#ffd866",
    },
    "gpu/temperature_c": {
        "label": "GPU temperature",
        "unit": "C",
        "color": "#ff6188",
    },
    "k8s/occupied_gpu_nodes": {
        "label": "Occupied GPU nodes",
        "unit": "nodes",
        "color": "#78dce8",
    },
    "k8s/quota_nodes": {
        "label": "GPU node quota",
        "unit": "nodes",
        "color": "#fc9867",
    },
}


@dataclass(frozen=True)
class DashboardSnapshot:
    timestamp: float
    host: str
    metrics: dict[str, float]
    fields: dict[str, Any]


def _uniform_indices(length: int, maximum: int) -> list[int]:
    if length <= maximum:
        return list(range(length))
    if maximum < 2:
        return [length - 1]
    scale = (length - 1) / (maximum - 1)
    indices = [round(index * scale) for index in range(maximum)]
    indices[0], indices[-1] = 0, length - 1
    return indices


def infer_metric_metadata(name: str) -> dict[str, str]:
    if name in DEFAULT_DASHBOARD_SERIES:
        return dict(DEFAULT_DASHBOARD_SERIES[name])
    final = name.rsplit("/", 1)[-1]
    business_labels = {
        "capacity_gpus": "GPU capacity",
        "allocated_gpus": "Allocated GPUs",
        "pending_gpus": "Pending GPUs",
        "unallocated_gpus": "Free GPUs",
        "no_job_gpus": "No-job GPUs",
        "no_job_node_equivalents": "No-job nodes",
        "capacity_cpus": "CPU capacity",
        "allocated_cpus": "Allocated CPUs",
        "free_cpus": "Free CPUs",
    }
    unit = ""
    for suffix, candidate in (
        ("_percent", "%"),
        ("_bytes", "bytes"),
        ("_mbps", "Mbps"),
        ("_seconds", "s"),
        ("_ms", "ms"),
        ("_c", "C"),
        ("_watts", "W"),
        ("_cores", "cores"),
        ("_count", "count"),
        ("_gpus", "GPUs"),
        ("_cpus", "CPUs"),
        ("_nodes", "nodes"),
        ("_pods", "pods"),
    ):
        if final.endswith(suffix):
            unit = candidate
            break
    if name.startswith("cluster_gpu/queue/") and final in business_labels:
        queue = name.split("/")[2]
        base_label = business_labels[final]
        label = base_label if queue == "total" else f"{queue}: {base_label}"
    else:
        label = name.replace("/", " / ").replace("_", " ")
    hue = int(sha1(name.encode("utf-8")).hexdigest()[:6], 16) % 360
    red, green, blue = hls_to_rgb(hue / 360, 0.64, 0.72)
    color = f"#{round(red * 255):02x}{round(green * 255):02x}{round(blue * 255):02x}"
    return {"label": label, "unit": unit, "color": color}


class DashboardStore:
    def __init__(
        self,
        capacity: int = DASHBOARD_CAPACITY,
        metric_limit: int = MAX_DASHBOARD_METRICS,
    ):
        self.capacity = max(2, int(capacity))
        self.metric_limit = max(1, int(metric_limit))
        self._timestamps: deque[float] = deque(maxlen=self.capacity)
        self._series: dict[str, deque[float | None]] = {}
        self._metadata: dict[str, dict[str, str]] = {}
        self._latest: DashboardSnapshot | None = None
        self._revision = 0
        self._catalog_cache: dict[
            float, tuple[int, list[dict[str, Any]]]
        ] = {}
        self._lock = threading.RLock()

    def seed(self, state: dict[str, Any]) -> None:
        samples = state.get("samples", [])
        if isinstance(samples, list):
            for sample in samples[-self.capacity :]:
                if not isinstance(sample, dict):
                    continue
                timestamp = sample.get("_time")
                if isinstance(timestamp, (int, float)):
                    self._append(float(timestamp), sample)
        updated_at = state.get("updated_at")
        metrics = state.get("last_metrics")
        fields = state.get("last_fields", {})
        if (
            isinstance(updated_at, (int, float))
            and isinstance(metrics, dict)
            and isinstance(fields, dict)
        ):
            self.publish(
                float(updated_at),
                str(state.get("host") or "localhost"),
                metrics,
                fields,
            )

    def seed_records(self, records: list[dict[str, Any]]) -> None:
        with self._lock:
            for record in sorted(
                records,
                key=lambda item: float(item.get("_time", 0)),
            ):
                timestamp = record.get("_time")
                metrics = record.get("metrics")
                if isinstance(timestamp, (int, float)) and isinstance(metrics, dict):
                    self._append(float(timestamp), metrics)

    def _append(self, timestamp: float, metrics: dict[str, Any]) -> bool:
        if self._timestamps and timestamp <= self._timestamps[-1]:
            return False
        self._ensure_metrics(metrics)
        self._timestamps.append(timestamp)
        for name, values in self._series.items():
            raw = metrics.get(name)
            if isinstance(raw, (int, float)) and math.isfinite(float(raw)):
                values.append(float(raw))
            else:
                values.append(None)
        return True

    def _ensure_metrics(self, metrics: dict[str, Any]) -> None:
        previous_length = len(self._timestamps)
        available = self.metric_limit - len(self._series)
        if available <= 0:
            return
        new_names = [
            name
            for name, value in sorted(metrics.items())
            if name not in self._series
            and isinstance(value, (int, float))
            and math.isfinite(float(value))
        ][:available]
        for name in new_names:
            values: deque[float | None] = deque(maxlen=self.capacity)
            values.extend([None] * previous_length)
            self._series[name] = values
            self._metadata[name] = infer_metric_metadata(name)

    def publish(
        self,
        timestamp: float,
        host: str,
        metrics: dict[str, Any],
        fields: dict[str, Any],
    ) -> None:
        numeric = {
            str(name): float(value)
            for name, value in metrics.items()
            if isinstance(value, (int, float)) and math.isfinite(float(value))
        }
        snapshot = DashboardSnapshot(
            timestamp=float(timestamp),
            host=host,
            metrics=numeric,
            fields=dict(fields),
        )
        with self._lock:
            appended = self._append(snapshot.timestamp, numeric)
            self._latest = snapshot
            if appended:
                self._revision += 1
                self._catalog_cache.clear()

    def latest(self) -> DashboardSnapshot | None:
        with self._lock:
            snapshot = self._latest
            if snapshot is None:
                return None
            return DashboardSnapshot(
                timestamp=snapshot.timestamp,
                host=snapshot.host,
                metrics=dict(snapshot.metrics),
                fields=dict(snapshot.fields),
            )

    def history(
        self,
        *,
        now: float,
        seconds: float,
        maximum_points: int,
        metrics: list[str] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            selected = metrics or [
                name
                for name in DEFAULT_DASHBOARD_SERIES
                if name in self._series
            ]
            unknown = sorted(set(selected) - set(self._series))
            if unknown:
                raise ValueError(f"unknown dashboard metrics: {unknown}")
            timestamps = list(self._timestamps)
            values = {name: list(self._series[name]) for name in selected}
            metadata = {name: dict(self._metadata[name]) for name in selected}
        cutoff = now - seconds
        first = bisect_left(timestamps, cutoff)
        timestamps = timestamps[first:]
        values = {name: points[first:] for name, points in values.items()}
        indices = _uniform_indices(len(timestamps), maximum_points)
        return {
            "from": timestamps[0] if timestamps else None,
            "to": timestamps[-1] if timestamps else None,
            "timestamps": [timestamps[index] for index in indices],
            "series": {
                name: [points[index] for index in indices]
                for name, points in values.items()
            },
            "metadata": metadata,
        }

    def catalog(self, *, now: float, seconds: float) -> list[dict[str, Any]]:
        return self.catalog_snapshot(now=now, seconds=seconds)[1]

    def catalog_snapshot(
        self,
        *,
        now: float,
        seconds: float,
    ) -> tuple[int, list[dict[str, Any]]]:
        cache_key = round(seconds, 3)
        cutoff = now - seconds
        with self._lock:
            cached = self._catalog_cache.get(cache_key)
            if cached is not None and cached[0] == self._revision:
                return cached
            timestamps = list(self._timestamps)
            first = bisect_left(timestamps, cutoff)
            current = self._latest.metrics if self._latest is not None else {}
            entries: list[dict[str, Any]] = []
            for name in sorted(self._series):
                values = [
                    value
                    for value in list(self._series[name])[first:]
                    if value is not None
                ]
                if not values:
                    continue
                ordered = sorted(values)
                p95_index = min(
                    len(ordered) - 1,
                    max(0, math.ceil(len(ordered) * 0.95) - 1),
                )
                entries.append(
                    {
                        "name": name,
                        "metadata": dict(self._metadata[name]),
                        "current": current.get(name, values[-1]),
                        "minimum": min(values),
                        "maximum": max(values),
                        "average": math.fsum(values) / len(values),
                        "p95": ordered[p95_index],
                        "samples": len(values),
                    }
                )
            if len(self._catalog_cache) >= 16:
                self._catalog_cache.clear()
            self._catalog_cache[cache_key] = (self._revision, entries)
            return self._revision, entries


def _reverse_lines(path: Path, block_size: int = 64 * 1024):
    with path.open("rb") as handle:
        handle.seek(0, 2)
        position = handle.tell()
        buffer = b""
        while position:
            size = min(block_size, position)
            position -= size
            handle.seek(position)
            buffer = handle.read(size) + buffer
            lines = buffer.split(b"\n")
            buffer = lines[0]
            for line in reversed(lines[1:]):
                if line:
                    yield line
        if buffer:
            yield buffer


def load_recent_history(directory: Path, count: int) -> list[dict[str, Any]]:
    if count < 1 or not directory.exists():
        return []
    records: list[dict[str, Any]] = []
    for path in reversed(sorted(directory.glob("metrics-*.jsonl"))):
        try:
            lines = _reverse_lines(path)
            for line in lines:
                try:
                    record = json.loads(line)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if isinstance(record, dict):
                    records.append(record)
                if len(records) >= count:
                    return list(reversed(records))
        except OSError:
            continue
    return list(reversed(records))
