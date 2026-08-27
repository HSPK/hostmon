from __future__ import annotations

import math
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any


DASHBOARD_CAPACITY = 2160
DASHBOARD_SERIES: dict[str, dict[str, str]] = {
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


class DashboardStore:
    def __init__(self, capacity: int = DASHBOARD_CAPACITY):
        self.capacity = max(2, int(capacity))
        self._timestamps: deque[float] = deque(maxlen=self.capacity)
        self._series: dict[str, deque[float | None]] = {
            name: deque(maxlen=self.capacity) for name in DASHBOARD_SERIES
        }
        self._latest: DashboardSnapshot | None = None
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

    def _append(self, timestamp: float, metrics: dict[str, Any]) -> None:
        if self._timestamps and timestamp <= self._timestamps[-1]:
            return
        self._timestamps.append(timestamp)
        for name, values in self._series.items():
            raw = metrics.get(name)
            if isinstance(raw, (int, float)) and math.isfinite(float(raw)):
                values.append(float(raw))
            else:
                values.append(None)

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
            self._append(snapshot.timestamp, numeric)
            self._latest = snapshot

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
        selected = metrics or list(DASHBOARD_SERIES)
        unknown = sorted(set(selected) - set(DASHBOARD_SERIES))
        if unknown:
            raise ValueError(f"unknown dashboard metrics: {unknown}")
        with self._lock:
            timestamps = list(self._timestamps)
            values = {name: list(self._series[name]) for name in selected}
        cutoff = now - seconds
        first = 0
        while first < len(timestamps) and timestamps[first] < cutoff:
            first += 1
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
            "metadata": {
                name: DASHBOARD_SERIES[name] for name in selected
            },
        }
