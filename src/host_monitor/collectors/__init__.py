from __future__ import annotations

import math
import re
import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from dataclasses import dataclass
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


ENVELOPE_VERSION = 1
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


@dataclass(frozen=True)
class CollectorBinding:
    name: str
    collector: Collector
    required: bool
    deadline_seconds: float
    max_stale_seconds: float


@dataclass
class InflightCollection:
    future: Future
    submitted_at: float


def _external_entry_points() -> dict[str, Any]:
    try:
        entries = metadata.entry_points(group="host_monitor.collectors")
    except TypeError:  # pragma: no cover - Python 3.9 compatibility for plugins
        entries = metadata.entry_points().get("host_monitor.collectors", [])
    discovered: dict[str, Any] = {}
    for entry in entries:
        if entry.name in BUILTIN_COLLECTORS:
            continue
        if entry.name in discovered:
            raise ConfigError(f"duplicate collector entry point: {entry.name}")
        discovered[entry.name] = entry
    return discovered


def external_collectors() -> dict[str, type[Collector]]:
    discovered: dict[str, type[Collector]] = {}
    for name, entry in _external_entry_points().items():
        try:
            discovered[name] = entry.load()
        except (ImportError, AttributeError, TypeError) as error:
            raise ConfigError(f"cannot load collector plugin {name!r}: {error}") from error
    return discovered


def build_collectors(
    settings: tuple[CollectorSettings, ...],
) -> list[CollectorBinding]:
    external = _external_entry_points()
    available_names = set(BUILTIN_COLLECTORS) | set(external)
    bindings: list[CollectorBinding] = []
    for item in settings:
        if not item.enabled:
            continue
        collector_type = BUILTIN_COLLECTORS.get(item.name)
        if collector_type is None:
            entry = external.get(item.name)
            if entry is None:
                raise ConfigError(
                    f"unknown collector {item.name!r}; available: "
                    f"{', '.join(sorted(available_names))}"
                )
            try:
                collector_type = entry.load()
            except (ImportError, AttributeError, TypeError) as error:
                raise ConfigError(
                    f"cannot load collector plugin {item.name!r}: {error}"
                ) from error
        try:
            collector = collector_type(dict(item.options))
        except (TypeError, ValueError, CollectorError) as error:
            raise ConfigError(
                f"invalid configuration for collector {item.name!r}: {error}"
            ) from error
        if getattr(collector, "name", None) != item.name:
            raise ConfigError(
                f"collector entry point {item.name!r} returned collector named "
                f"{getattr(collector, 'name', None)!r}"
            )
        bindings.append(
            CollectorBinding(
                name=item.name,
                collector=collector,
                required=item.required,
                deadline_seconds=item.deadline_seconds,
                max_stale_seconds=item.max_stale_seconds,
            )
        )
    return bindings


def _metric_component(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_") or "collector"


def _safe_error(error: Exception) -> str:
    text = f"{type(error).__name__}: {error}"
    return re.sub(r"https?://\S+", "<redacted-url>", text)[:1000]


def _previous_state(value: Any) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if isinstance(value, dict) and value.get("_hostmon_envelope") == ENVELOPE_VERSION:
        plugin_state = value.get("plugin_state")
        return (
            plugin_state if isinstance(plugin_state, dict) else None,
            value,
        )
    return (value if isinstance(value, dict) else None, None)


def _validate_result(name: str, result: Any) -> CollectorResult:
    if not isinstance(result, CollectorResult):
        raise CollectorError(f"collector {name!r} returned an invalid result")
    return result


def _collect_timed(
    collector: Collector,
    previous: dict[str, Any] | None,
    now: float,
) -> tuple[CollectorResult, float]:
    started = time.monotonic()
    result = collector.collect(previous, now)
    return result, (time.monotonic() - started) * 1000


class CollectorManager:
    def __init__(self, collectors: list[CollectorBinding | Collector]):
        self.collectors: list[CollectorBinding] = []
        for item in collectors:
            if isinstance(item, CollectorBinding):
                self.collectors.append(item)
            else:
                self.collectors.append(
                    CollectorBinding(
                        name=item.name,
                        collector=item,
                        required=True,
                        deadline_seconds=30,
                        max_stale_seconds=0,
                    )
                )
        self._executor = ThreadPoolExecutor(
            max_workers=max(1, len(self.collectors)),
            thread_name_prefix="hostmon-collector",
        )
        self._inflight: dict[str, InflightCollection] = {}

    def close(self) -> None:
        for binding in self.collectors:
            close = getattr(binding.collector, "close", None)
            if callable(close):
                close()
        self._executor.shutdown(wait=False, cancel_futures=True)

    @staticmethod
    def _merge_result(
        name: str,
        result: CollectorResult,
        metrics: dict[str, float],
        fields: dict[str, Any],
    ) -> None:
        for metric_name, raw_value in result.metrics.items():
            try:
                value = float(raw_value)
            except (TypeError, ValueError) as error:
                raise CollectorError(
                    f"collector {name!r} returned a non-numeric "
                    f"metric {metric_name!r}"
                ) from error
            if not math.isfinite(value):
                raise CollectorError(
                    f"collector {name!r} returned a non-finite "
                    f"metric {metric_name!r}"
                )
            if metric_name in metrics:
                raise CollectorError(f"duplicate metric name: {metric_name}")
            metrics[metric_name] = value
        for field_name, value in result.fields.items():
            if field_name in fields:
                raise CollectorError(f"duplicate template field name: {field_name}")
            if not isinstance(value, (str, int, float, bool)) and value is not None:
                raise CollectorError(
                    f"collector {name!r} returned an invalid "
                    f"template field {field_name!r}"
                )
            fields[field_name] = value

    @staticmethod
    def _health_metrics(
        binding: CollectorBinding,
        metrics: dict[str, float],
        *,
        up: bool,
        stale: bool,
        duration_ms: float | None,
        last_success_at: float | None,
        failures_total: int,
        now: float,
    ) -> None:
        prefix = f"monitor/collector/{_metric_component(binding.name)}"
        metrics[f"{prefix}/up"] = float(up)
        metrics[f"{prefix}/stale"] = float(stale)
        metrics[f"{prefix}/failures_total"] = float(failures_total)
        if duration_ms is not None:
            metrics[f"{prefix}/duration_ms"] = duration_ms
        if last_success_at is not None:
            metrics[f"{prefix}/last_success_age_seconds"] = max(
                0.0, now - last_success_at
            )

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
        required_errors: list[str] = []

        for binding in self.collectors:
            if binding.name in self._inflight:
                continue
            plugin_previous, _ = _previous_state(previous.get(binding.name))
            self._inflight[binding.name] = InflightCollection(
                future=self._executor.submit(
                    _collect_timed,
                    binding.collector,
                    plugin_previous,
                    now,
                ),
                submitted_at=time.monotonic(),
            )

        for binding in self.collectors:
            _, prior_envelope = _previous_state(previous.get(binding.name))
            inflight = self._inflight[binding.name]
            remaining = max(
                0.0,
                inflight.submitted_at
                + binding.deadline_seconds
                - time.monotonic(),
            )
            result: CollectorResult | None = None
            duration_ms: float | None = None
            error_text: str | None = None
            try:
                raw_result, duration_ms = inflight.future.result(timeout=remaining)
                result = _validate_result(binding.name, raw_result)
            except TimeoutError:
                error_text = (
                    f"deadline exceeded after {binding.deadline_seconds:g}s"
                )
            # Third-party collectors are an isolation boundary: surface failures
            # as health state without letting plugin exceptions abort other work.
            except Exception as error:
                error_text = _safe_error(error)
                del self._inflight[binding.name]
            else:
                del self._inflight[binding.name]

            prior_failures = (
                int(prior_envelope.get("failures_total", 0))
                if prior_envelope is not None
                else 0
            )
            if result is not None:
                self._merge_result(binding.name, result, metrics, fields)
                envelope = {
                    "_hostmon_envelope": ENVELOPE_VERSION,
                    "plugin_state": result.state,
                    "last_success_at": now,
                    "metrics": result.metrics,
                    "fields": result.fields,
                    "failures_total": prior_failures,
                }
                states[binding.name] = envelope
                warnings.extend(result.warnings)
                self._health_metrics(
                    binding,
                    metrics,
                    up=True,
                    stale=False,
                    duration_ms=duration_ms,
                    last_success_at=now,
                    failures_total=prior_failures,
                    now=now,
                )
                continue

            failures_total = prior_failures + 1
            last_success_at = (
                float(prior_envelope["last_success_at"])
                if prior_envelope is not None
                and isinstance(prior_envelope.get("last_success_at"), (int, float))
                else None
            )
            stale_age = (
                now - last_success_at if last_success_at is not None else None
            )
            use_stale = bool(
                prior_envelope is not None
                and stale_age is not None
                and stale_age <= binding.max_stale_seconds
                and isinstance(prior_envelope.get("metrics"), dict)
                and isinstance(prior_envelope.get("fields"), dict)
            )
            envelope = {
                **(prior_envelope or {}),
                "_hostmon_envelope": ENVELOPE_VERSION,
                "failures_total": failures_total,
                "last_failure_at": now,
                "last_error": error_text,
            }
            states[binding.name] = envelope
            if use_stale:
                stale_result = CollectorResult(
                    metrics=dict(prior_envelope["metrics"]),
                    fields=dict(prior_envelope["fields"]),
                )
                self._merge_result(binding.name, stale_result, metrics, fields)
            warning = (
                f"collector {binding.name!r} failed: {error_text}; "
                + (
                    f"using stale data age={stale_age:.1f}s"
                    if use_stale
                    else "no usable stale data"
                )
            )
            warnings.append(warning)
            self._health_metrics(
                binding,
                metrics,
                up=False,
                stale=use_stale,
                duration_ms=None,
                last_success_at=last_success_at,
                failures_total=failures_total,
                now=now,
            )
            if binding.required and not use_stale:
                required_errors.append(warning)

        if required_errors:
            raise CollectorError("; ".join(required_errors))
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
    "CollectorBinding",
    "CollectorManager",
    "CollectorResult",
    "build_collectors",
]
