from __future__ import annotations

import hashlib
import json
import math
import re
import time
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from expr_tracker.alerts import AlertEngine, AlertRule
from expr_tracker.alerts.expr import (
    EvalContext,
    compile_condition,
    evaluate,
    explain,
    validate,
)
from expr_tracker.alerts.expr.eval import tristate
from expr_tracker.alerts.expr.functions import UNKNOWN
from expr_tracker.history import MetricSeries

from .config import atomic_write_text
from .errors import ConfigError, RuleError


DEFAULT_RULES: list[dict[str, Any]] = [
    {
        "alert": "high-cpu",
        "expr": "cpu.percent >= 90",
        "level": "warning",
        "title": "High localhost CPU usage | {host}",
        "message": "CPU usage remained above the configured threshold: {expr}",
        "for": 3,
        "mode": "level",
        "cooldown": 1800,
        "notify_recovery": True,
        "enabled": True,
    },
    {
        "alert": "high-memory",
        "expr": "memory.percent >= 90",
        "level": "warning",
        "title": "High localhost memory usage | {host}",
        "message": "Memory usage remained above the configured threshold: {expr}",
        "for": 3,
        "mode": "level",
        "cooldown": 1800,
        "notify_recovery": True,
        "enabled": True,
    },
    {
        "alert": "high-disk",
        "expr": "disk.percent >= 90",
        "level": "warning",
        "title": "High localhost disk usage | {host}",
        "message": "Disk usage remained above the configured threshold: {expr}",
        "for": 3,
        "mode": "level",
        "cooldown": 1800,
        "notify_recovery": True,
        "enabled": True,
    },
    {
        "alert": "high-network",
        "expr": "network.rx_mbps >= 1000 or network.tx_mbps >= 1000",
        "level": "warning",
        "title": "High localhost network traffic | {host}",
        "message": "Network traffic remained above the configured threshold: {expr}",
        "for": 3,
        "mode": "level",
        "cooldown": 1800,
        "notify_recovery": True,
        "enabled": True,
    },
    {
        "alert": "high-gpu-memory-or-temperature",
        "expr": "gpu.memory_percent >= 95 or gpu.temperature_c >= 85",
        "level": "warning",
        "title": "High localhost GPU memory or temperature | {host}",
        "message": "GPU memory or temperature remained above threshold: {expr}",
        "for": 3,
        "mode": "level",
        "cooldown": 1800,
        "notify_recovery": True,
        "enabled": True,
    },
    {
        "alert": "k8s-gpu-node-drop",
        "expr": (
            "k8s.occupied_gpu_nodes < k8s.quota_nodes and "
            "diff(k8s.occupied_gpu_nodes[2]) < 0"
        ),
        "level": "warning",
        "title": (
            "Kubernetes GPU nodes {k8s_occupied_gpu_nodes:.0f}/"
            "{k8s_quota_nodes:.0f} | {k8s_namespace}"
        ),
        "message": (
            "Stopped or reduced tasks: {k8s_stopped_tasks}\n"
            "Lost nodes: {k8s_stopped_task_details}\n"
            "Condition: {expr}"
        ),
        "for": 1,
        "mode": "edge",
        "cooldown": 0,
        "notify_recovery": False,
        "enabled": True,
    },
]


@dataclass
class CapturedAlert:
    message: Any
    channels: list[str] | None


@dataclass
class RuleEvaluation:
    alerts: list[CapturedAlert]
    rule_states: dict[str, dict[str, Any]]
    sample: dict[str, Any]
    stats: dict[str, Any]


class CaptureDispatcher:
    def __init__(self):
        self.alerts: list[CapturedAlert] = []

    def send(self, message: Any, channels: list[str] | None = None) -> None:
        self.alerts.append(
            CapturedAlert(message=message, channels=list(channels) if channels else None)
        )

    def close(self, timeout: float = 0) -> None:
        return None


class RuleStore:
    def __init__(self, path: Path):
        self.path = path
        self._cached_signature: tuple[int, int] | None = None
        self._cached_rules: list[AlertRule] | None = None
        self.last_error: str | None = None

    def _signature(self) -> tuple[int, int]:
        try:
            stat = self.path.stat()
        except OSError as error:
            raise RuleError(f"cannot stat rules {self.path}: {error}") from error
        return stat.st_mtime_ns, stat.st_size

    def _read_raw(self) -> list[dict[str, Any]]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise RuleError(
                f"rules not found: {self.path}; run `hmon config init`"
            ) from error
        except (OSError, json.JSONDecodeError) as error:
            raise RuleError(f"cannot read rules {self.path}: {error}") from error
        entries = payload.get("rules") if isinstance(payload, dict) else payload
        if not isinstance(entries, list):
            raise RuleError("rules file must contain a JSON array or a `rules` array")
        if not all(isinstance(item, dict) for item in entries):
            raise RuleError("every rule must be a JSON object")
        return [dict(item) for item in entries]

    @staticmethod
    def _parse_entries(entries: Sequence[dict[str, Any]]) -> list[AlertRule]:
        rules: list[AlertRule] = []
        names: set[str] = set()
        for index, raw in enumerate(entries, start=1):
            try:
                rule = AlertRule.from_dict(raw)
                node = compile_condition(rule.condition)
                validate(node)
            except (TypeError, ValueError) as error:
                raise RuleError(f"invalid rule #{index}: {error}") from error
            if rule.name in names:
                raise RuleError(f"duplicate rule name: {rule.name}")
            names.add(str(rule.name))
            rules.append(rule)
        return rules

    def load(self) -> list[AlertRule]:
        try:
            signature = self._signature()
            if (
                signature == self._cached_signature
                and self._cached_rules is not None
            ):
                return deepcopy(self._cached_rules)
            rules = self._parse_entries(self._read_raw())
        except RuleError as error:
            if self._cached_rules is None:
                raise
            self.last_error = str(error)
            return deepcopy(self._cached_rules)
        self._cached_signature = signature
        self._cached_rules = deepcopy(rules)
        self.last_error = None
        return rules

    def write(self, entries: Sequence[dict[str, Any]]) -> None:
        self._parse_entries(entries)
        content = json.dumps(
            {"rules": list(entries)},
            ensure_ascii=False,
            indent=2,
        )
        try:
            atomic_write_text(self.path, content + "\n")
        except ConfigError as error:
            raise RuleError(f"cannot write rules {self.path}: {error}") from error
        self._cached_signature = None
        self._cached_rules = None
        self.last_error = None

    def add(self, entry: dict[str, Any]) -> AlertRule:
        try:
            candidate = AlertRule.from_dict(entry)
            validate(compile_condition(candidate.condition))
        except (TypeError, ValueError) as error:
            raise RuleError(f"invalid rule: {error}") from error
        entries = self._read_raw()
        self._parse_entries(entries)
        existing = {AlertRule.from_dict(item).name for item in entries}
        if candidate.name in existing:
            raise RuleError(f"rule already exists: {candidate.name}")
        entries.append(entry)
        self.write(entries)
        return candidate

    def remove(self, name: str) -> None:
        entries = self._read_raw()
        self._parse_entries(entries)
        remaining = [
            item for item in entries if AlertRule.from_dict(item).name != name
        ]
        if len(remaining) == len(entries):
            raise RuleError(f"rule not found: {name}")
        self.write(remaining)

    def set_enabled(self, name: str, enabled: bool) -> None:
        entries = self._read_raw()
        self._parse_entries(entries)
        found = False
        for item in entries:
            if AlertRule.from_dict(item).name == name:
                item["enabled"] = enabled
                found = True
                break
        if not found:
            raise RuleError(f"rule not found: {name}")
        self.write(entries)


def write_default_rules(path: Path, *, force: bool = False) -> None:
    if path.exists() and not force:
        raise RuleError(f"rules already exist: {path}")
    RuleStore(path).write(DEFAULT_RULES)


def rule_signature(rule: AlertRule) -> str:
    values = {
        "condition": rule.condition,
        "level": rule.level.value,
        "title": rule.title,
        "message": rule.message,
        "mode": rule.mode,
        "for_steps": rule.for_steps,
        "cooldown": rule.cooldown,
        "max_fires": rule.max_fires,
        "notify_recovery": rule.notify_recovery,
        "channels": rule.channels,
        "enabled": rule.enabled,
    }
    raw = json.dumps(values, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _restore_state(compiled: Any, saved: Any, signature: str) -> None:
    if not isinstance(saved, dict) or saved.get("signature") != signature:
        return
    try:
        consecutive = max(0, int(saved.get("consecutive", 0)))
        fires = max(0, int(saved.get("fires", 0)))
        last_fire = saved.get("last_fire")
        if last_fire is not None:
            last_fire = float(last_fire)
    except (TypeError, ValueError) as error:
        raise RuleError(f"invalid saved state for rule {compiled.rule.name}") from error
    compiled.state.consecutive = consecutive
    compiled.state.firing = bool(saved.get("firing", False))
    compiled.state.last_fire = last_fire
    compiled.state.fires = fires


def metric_alias(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", name).strip("_")


class ContextFactory:
    def __init__(
        self,
        series: MetricSeries,
        record: dict[str, Any],
        step: int,
        now: float,
        started_at: float,
        last_commit_time: float,
    ):
        self.series = series
        self.record = record
        self.step = step
        self.now = now
        self.started_at = started_at
        self.last_commit_time = last_commit_time

    def __call__(self, record: dict[str, Any] | None) -> EvalContext:
        current = record or self.record
        return EvalContext(
            self.series,
            step=self.step,
            now=self.now,
            started_at=self.started_at,
            last_commit_time=self.last_commit_time,
            record=current,
        )


def evaluate_rules(
    rules: Sequence[AlertRule],
    metrics: dict[str, float],
    state: dict[str, Any],
    *,
    fields: dict[str, Any] | None = None,
    hostname: str,
    history_size: int,
    now: float | None = None,
    started_at: float | None = None,
    last_commit_time: float | None = None,
) -> RuleEvaluation:
    now = time.time() if now is None else now
    started_at = now if started_at is None else started_at
    last_commit_time = now if last_commit_time is None else last_commit_time
    samples = state.get("samples", [])
    if not isinstance(samples, list):
        raise RuleError("state samples must be a list")
    step = max(-1, int(state.get("step", -1))) + 1
    series = MetricSeries(window=history_size)
    for sample in samples[-history_size:]:
        if not isinstance(sample, dict):
            continue
        sample_step = sample.get("_step")
        sample_time = sample.get("_time")
        if isinstance(sample_step, int) and isinstance(sample_time, (int, float)):
            series.add(sample_step, float(sample_time), sample)

    record: dict[str, Any] = {
        **metrics,
        **{metric_alias(name): value for name, value in metrics.items()},
        **(fields or {}),
        "_step": step,
        "_time": now,
        "host": hostname,
    }
    referenced: set[str] = set()
    for rule in rules:
        referenced.update(compile_condition(rule.condition).metrics())
    for name in referenced:
        slash_name = name.replace(".", "/")
        if name not in record and slash_name not in record:
            record[slash_name] = math.nan
    series.add(step, now, record)

    capture = CaptureDispatcher()
    context = ContextFactory(
        series,
        record,
        step,
        now,
        started_at,
        last_commit_time,
    )
    engine = AlertEngine(
        capture,
        context,
        rules=rules,
        run_info={"project": "hostmon", "run": hostname},
        watchdog_interval=0,
    )
    saved_rules = state.get("rules", {})
    if not isinstance(saved_rules, dict):
        raise RuleError("state rules must be an object")
    for name, compiled in engine.rules.items():
        _restore_state(
            compiled,
            saved_rules.get(name),
            rule_signature(compiled.rule),
        )
    engine.on_step(record)
    rule_states = {
        name: {
            "signature": rule_signature(compiled.rule),
            "consecutive": compiled.state.consecutive,
            "firing": compiled.state.firing,
            "last_fire": compiled.state.last_fire,
            "fires": compiled.state.fires,
        }
        for name, compiled in engine.rules.items()
    }
    stats = engine.stats()
    engine.close()
    persisted_metrics: dict[str, float] = {}
    for name in referenced:
        slash_name = name.replace(".", "/")
        resolved_name = name if name in record else slash_name
        value = record.get(resolved_name)
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            persisted_metrics[resolved_name] = float(value)
    sample = {
        "_step": step,
        "_time": now,
        **persisted_metrics,
    }
    return RuleEvaluation(
        alerts=capture.alerts,
        rule_states=rule_states,
        sample=sample,
        stats=stats,
    )


def inspect_rules(
    rules: Sequence[AlertRule],
    metrics: dict[str, float],
    *,
    now: float | None = None,
) -> list[dict[str, Any]]:
    now = time.time() if now is None else now
    series = MetricSeries(window=2)
    record = {**metrics, **{metric_alias(k): v for k, v in metrics.items()}}
    series.add(0, now, record)
    context = EvalContext(
        series,
        step=0,
        now=now,
        started_at=now,
        last_commit_time=now,
        record=record,
    )
    results: list[dict[str, Any]] = []
    for rule in rules:
        node = compile_condition(rule.condition)
        value = tristate(evaluate(node, context))
        state = "unknown" if value is UNKNOWN else "true" if value else "false"
        results.append(
            {
                "name": rule.name,
                "enabled": rule.enabled,
                "result": state,
                "expression": explain(node, context),
            }
        )
    return results
