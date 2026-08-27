from __future__ import annotations

import json
import logging
import signal
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from .alerts import AlertSender
from .collectors import Collection, CollectorManager, build_collectors
from .config import Settings
from .errors import MonitorError
from .history import HistoryWriter
from .outbox import OutboxStore
from .prometheus import PrometheusExporter
from .rules import RuleEvaluation, RuleStore, evaluate_rules
from .state import StateStore


LOGGER = logging.getLogger("host_monitor")


@dataclass
class CycleResult:
    metrics: dict[str, float]
    fields: dict[str, Any]
    warnings: list[str]
    alerts: list[dict[str, str]]
    collected_at: float
    rule_stats: dict[str, Any]
    history_file: str | None


def local_hostname(settings: Settings) -> str:
    return settings.hostname or socket.gethostname()


class MonitorRuntime:
    def __init__(
        self,
        settings: Settings,
        *,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        self.settings = settings
        self.clock = clock
        self.monotonic = monotonic
        self.started_at = self.clock()
        self.collectors = CollectorManager(build_collectors(settings.collectors))
        self.rules = RuleStore(settings.rules_file)
        self.state_store = StateStore(settings.state_file)
        self.alerts = AlertSender(settings.alerts)
        self.history = HistoryWriter(settings.history)
        self.outbox = OutboxStore(
            settings.state_file.with_name("reliability.db")
        )
        self.state = self.state_store.load()
        self.hostname = local_hostname(settings)
        self.prometheus = PrometheusExporter(
            settings.prometheus,
            settings.state_file,
        )
        try:
            self.prometheus.start()
        except MonitorError:
            self.outbox.close()
            self.alerts.close()
            self.collectors.close()
            raise

    def close(self) -> None:
        self.prometheus.close()
        self.collectors.close()
        self.alerts.close()
        self.outbox.close()

    def cycle(self, *, send_alerts: bool = True, persist: bool = True) -> CycleResult:
        started = self.monotonic()
        now = self.clock()
        collection = self.collectors.collect(
            self.state.get("collectors"),
            now=now,
        )
        collection.metrics["monitor/collection_duration_ms"] = (
            self.monotonic() - started
        ) * 1000
        rules = self.rules.load()
        if self.rules.last_error:
            collection.warnings.append(
                f"using last-known-good rules: {self.rules.last_error}"
            )
        evaluation = evaluate_rules(
            rules,
            collection.metrics,
            self.state,
            fields=collection.fields,
            hostname=self.hostname,
            history_size=self.settings.history_size,
            now=now,
            started_at=self.started_at,
            last_commit_time=float(self.state.get("updated_at") or now),
        )
        rendered_alerts: list[dict[str, Any]] = []
        if send_alerts:
            for captured in evaluation.alerts:
                channels = self.alerts.targets(captured)
                event_id = self.outbox.enqueue(captured, channels, now=now)
                rendered_alerts.append(
                    {
                        "event_id": event_id,
                        "title": str(captured.message.title),
                        "level": captured.message.level.value,
                        "message": str(captured.message.text),
                        "channels": channels,
                    }
                )
        else:
            rendered_alerts = [
                {
                    "event_id": None,
                    "title": str(item.message.title),
                    "level": item.message.level.value,
                    "message": str(item.message.text),
                    "channels": [],
                }
                for item in evaluation.alerts
            ]

        samples = list(self.state.get("samples", []))
        samples.append(evaluation.sample)
        next_state = {
            **self.state,
            "version": 2,
            "step": evaluation.sample["_step"],
            "updated_at": now,
            "host": self.hostname,
            "samples": samples[-self.settings.history_size :],
            "rules": evaluation.rule_states,
            "collectors": collection.states,
            "last_metrics": collection.metrics,
            "last_fields": collection.fields,
        }

        delivery = None
        if send_alerts:
            delivery = self.outbox.deliver_pending(self.alerts, now=now)
            collection.metrics["monitor/outbox/delivered"] = float(
                delivery.delivered
            )
            collection.metrics["monitor/outbox/failed"] = float(delivery.failed)
            collection.metrics["monitor/outbox/pending"] = float(delivery.pending)
            collection.warnings.extend(delivery.errors)
            for alert in rendered_alerts:
                event_id = alert["event_id"]
                alert["delivery"] = (
                    self.outbox.event_status(event_id) if event_id else {}
                )

        history_path = None
        try:
            history_path = self.history.append(
                timestamp=now,
                host=self.hostname,
                metrics=collection.metrics,
                fields=collection.fields,
                alerts=rendered_alerts,
            )
        except MonitorError as error:
            collection.warnings.append(f"history write failed: {error}")

        next_state["last_metrics"] = collection.metrics
        next_state["last_fields"] = collection.fields
        if history_path is not None:
            next_state["last_history_file"] = str(history_path)
        if persist:
            self.state_store.save(next_state)
        self.state = next_state
        if send_alerts:
            self.outbox.prune_delivered(before=now - 7 * 86400)
        return CycleResult(
            metrics=collection.metrics,
            fields=collection.fields,
            warnings=collection.warnings,
            alerts=rendered_alerts,
            collected_at=now,
            rule_stats=evaluation.stats,
            history_file=str(history_path) if history_path else None,
        )

    def run_forever(self, stop_event: threading.Event | None = None) -> None:
        stop_event = stop_event or threading.Event()
        next_run = self.monotonic()
        while not stop_event.is_set():
            try:
                result = self.cycle()
            except MonitorError as error:
                LOGGER.error("monitor cycle failed: %s", error)
            else:
                for warning in result.warnings:
                    LOGGER.warning("%s", warning)
                summary_names = (
                    "cpu/percent",
                    "memory/percent",
                    "disk/percent",
                    "network/rx_mbps",
                    "network/tx_mbps",
                    "gpu/percent",
                    "gpu/memory_percent",
                    "gpu/temperature_c",
                    "k8s/failed_task_count",
                    "k8s/occupied_gpu_nodes",
                    "k8s/quota_nodes",
                )
                summary = {
                    name: result.metrics[name]
                    for name in summary_names
                    if name in result.metrics
                }
                summary.update(
                    {
                        name: value
                        for name, value in result.metrics.items()
                        if name.startswith("permission/")
                        and name.endswith("/allowed")
                    }
                )
                LOGGER.info(
                    "sample %s",
                    json.dumps(
                        {
                            "host": self.hostname,
                            "collected_at": result.collected_at,
                            "metrics": summary,
                            "alert_count": len(result.alerts),
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                )
                for alert in result.alerts:
                    LOGGER.info(
                        "alert generated level=%s title=%s",
                        alert["level"],
                        alert["title"],
                    )
                LOGGER.debug(
                    "full sample %s",
                    json.dumps(
                        result.metrics,
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                )
            current = self.monotonic()
            next_run = advance_deadline(
                next_run,
                current,
                self.settings.interval_seconds,
            )
            delay = max(0.0, next_run - current)
            if stop_event.wait(delay):
                break


def install_signal_handlers(stop_event: threading.Event) -> None:
    def stop(signum: int, frame: Any) -> None:
        LOGGER.info("received signal %s; stopping", signum)
        stop_event.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)


def advance_deadline(previous: float, current: float, interval: float) -> float:
    target = previous + interval
    if target < current - interval:
        return current
    return target


def run_daemon(settings: Settings) -> None:
    store = StateStore(settings.state_file)
    stop_event = threading.Event()
    install_signal_handlers(stop_event)
    with store.process_lock():
        runtime = MonitorRuntime(settings)
        try:
            LOGGER.info(
                "starting host monitor host=%s interval_seconds=%s",
                runtime.hostname,
                settings.interval_seconds,
            )
            runtime.run_forever(stop_event)
        finally:
            runtime.close()
            LOGGER.info("host monitor stopped")


def capture_snapshot(
    settings: Settings,
    *,
    sleeper: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.time,
    monotonic: Callable[[], float] = time.monotonic,
) -> Collection:
    manager = CollectorManager(build_collectors(settings.collectors))
    try:
        first = manager.collect({}, now=clock())
        sleeper(settings.snapshot_seconds)
        started = monotonic()
        second = manager.collect(first.states, now=clock())
        second.metrics["monitor/collection_duration_ms"] = (
            monotonic() - started
        ) * 1000
        second.warnings = list(dict.fromkeys(first.warnings + second.warnings))
        return second
    finally:
        manager.close()
