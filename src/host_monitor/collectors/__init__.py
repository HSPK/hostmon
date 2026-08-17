from __future__ import annotations

import math
from importlib import metadata
from typing import Any

from ..config import CollectorSettings
from ..errors import CollectorError, ConfigError
from .base import Collection, Collector, CollectorResult
from .cpu import CPUCollector
from .disk import DiskCollector
from .gpu import GPUCollector
from .kubernetes import KubernetesCollector
from .memory import MemoryCollector
from .network import NetworkCollector
from .permissions import KubernetesPermissionCollector
from .pressure import PressureCollector


BUILTIN_COLLECTORS: dict[str, type[Collector]] = {
    "cpu": CPUCollector,
    "memory": MemoryCollector,
    "disk": DiskCollector,
    "network": NetworkCollector,
    "gpu": GPUCollector,
    "pressure": PressureCollector,
    "kubernetes": KubernetesCollector,
    "kubernetes_permissions": KubernetesPermissionCollector,
}


def external_collectors() -> dict[str, type[Collector]]:
    discovered: dict[str, type[Collector]] = {}
    try:
        entries = metadata.entry_points(group="host_monitor.collectors")
    except TypeError:  # pragma: no cover - Python 3.9 compatibility for plugins
        entries = metadata.entry_points().get("host_monitor.collectors", [])
    for entry in entries:
        if entry.name not in BUILTIN_COLLECTORS:
            discovered[entry.name] = entry.load()
    return discovered


def build_collectors(settings: tuple[CollectorSettings, ...]) -> list[Collector]:
    available = {**BUILTIN_COLLECTORS, **external_collectors()}
    collectors: list[Collector] = []
    for item in settings:
        if not item.enabled:
            continue
        collector_type = available.get(item.name)
        if collector_type is None:
            raise ConfigError(
                f"unknown collector {item.name!r}; available: "
                f"{', '.join(sorted(available))}"
            )
        try:
            collector = collector_type(dict(item.options))
        except (TypeError, ValueError, CollectorError) as error:
            raise ConfigError(
                f"invalid configuration for collector {item.name!r}: {error}"
            ) from error
        collectors.append(collector)
    return collectors


class CollectorManager:
    def __init__(self, collectors: list[Collector]):
        self.collectors = collectors

    def collect(
        self,
        previous: dict[str, Any] | None = None,
        *,
        now: float,
    ) -> Collection:
        previous = previous or {}
        metrics: dict[str, float] = {}
        fields: dict[str, Any] = {}
        states: dict[str, Any] = {}
        warnings: list[str] = []
        for collector in self.collectors:
            result = collector.collect(previous.get(collector.name), now)
            if not isinstance(result, CollectorResult):
                raise CollectorError(
                    f"collector {collector.name!r} returned an invalid result"
                )
            for name, raw_value in result.metrics.items():
                try:
                    value = float(raw_value)
                except (TypeError, ValueError) as error:
                    raise CollectorError(
                        f"collector {collector.name!r} returned a non-numeric "
                        f"metric {name!r}"
                    ) from error
                if not math.isfinite(value):
                    raise CollectorError(
                        f"collector {collector.name!r} returned a non-finite "
                        f"metric {name!r}"
                    )
                if name in metrics:
                    raise CollectorError(f"duplicate metric name: {name}")
                metrics[name] = value
            for name, value in result.fields.items():
                if name in fields:
                    raise CollectorError(f"duplicate template field name: {name}")
                if not isinstance(value, (str, int, float, bool)) and value is not None:
                    raise CollectorError(
                        f"collector {collector.name!r} returned an invalid "
                        f"template field {name!r}"
                    )
                fields[name] = value
            states[collector.name] = result.state
            warnings.extend(result.warnings)
        return Collection(
            metrics=metrics,
            fields=fields,
            states=states,
            warnings=warnings,
        )


__all__ = [
    "BUILTIN_COLLECTORS",
    "Collection",
    "Collector",
    "CollectorManager",
    "CollectorResult",
    "build_collectors",
]
