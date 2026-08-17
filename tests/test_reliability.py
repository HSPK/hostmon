from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from expr_tracker.alerts import AlertMessage, AlertRule

from host_monitor.collectors import CollectorBinding, CollectorManager
from host_monitor.collectors.base import CollectorResult
from host_monitor.config import AlertSettings, initialize_config, load_settings
from host_monitor.errors import AlertError, CollectorError, MonitorError, RuleError
from host_monitor.outbox import OutboxStore
from host_monitor.rules import CapturedAlert, RuleStore, evaluate_rules, write_default_rules
from host_monitor.runtime import MonitorRuntime
from host_monitor.state import StateStore


class MutableCollector:
    def __init__(self, name: str, metric: str, value: float):
        self.name = name
        self.metric = metric
        self.value = value
        self.error: Exception | None = None

    def collect(self, previous, now):
        if self.error is not None:
            raise self.error
        return CollectorResult(
            metrics={self.metric: self.value},
            fields={f"{self.name}_field": str(self.value)},
            state={"at": now},
        )


class BlockingCollector:
    name = "blocking"

    def __init__(self, release: threading.Event):
        self.release = release

    def collect(self, previous, now):
        self.release.wait()
        return CollectorResult(metrics={"blocking/value": 1}, state={"at": now})


class CollectorReliabilityTests(unittest.TestCase):
    def test_optional_failure_uses_bounded_stale_data(self):
        collector = MutableCollector("remote", "remote/value", 10)
        manager = CollectorManager(
            [
                CollectorBinding(
                    name="remote",
                    collector=collector,
                    required=False,
                    deadline_seconds=1,
                    max_stale_seconds=60,
                )
            ]
        )
        try:
            first = manager.collect({}, now=100)
            collector.error = CollectorError("remote unavailable")
            second = manager.collect(first.states, now=120)
        finally:
            manager.close()

        self.assertEqual(second.metrics["remote/value"], 10)
        self.assertEqual(second.metrics["monitor/collector/remote/up"], 0)
        self.assertEqual(second.metrics["monitor/collector/remote/stale"], 1)
        self.assertIn("using stale data", second.warnings[0])

    def test_required_failure_without_stale_data_fails_cycle(self):
        collector = MutableCollector("required", "required/value", 1)
        collector.error = CollectorError("broken")
        manager = CollectorManager(
            [
                CollectorBinding(
                    name="required",
                    collector=collector,
                    required=True,
                    deadline_seconds=1,
                    max_stale_seconds=0,
                )
            ]
        )
        try:
            with self.assertRaises(CollectorError):
                manager.collect({}, now=100)
        finally:
            manager.close()

    def test_deadline_returns_without_resubmitting_hung_collector(self):
        release = threading.Event()
        manager = CollectorManager(
            [
                CollectorBinding(
                    name="blocking",
                    collector=BlockingCollector(release),
                    required=False,
                    deadline_seconds=0.01,
                    max_stale_seconds=0,
                )
            ]
        )
        started = time.monotonic()
        try:
            first = manager.collect({}, now=100)
            second = manager.collect(first.states, now=101)
        finally:
            release.set()
            manager.close()

        self.assertLess(time.monotonic() - started, 0.2)
        self.assertEqual(first.metrics["monitor/collector/blocking/up"], 0)
        self.assertEqual(second.metrics["monitor/collector/blocking/up"], 0)


class FakeSender:
    def __init__(self):
        self.calls: list[str] = []
        self.fail_once = {"secondary"}

    def send_one(self, message, channel):
        self.calls.append(channel)
        if channel in self.fail_once:
            self.fail_once.remove(channel)
            raise AlertError("temporary failure at https://secret.invalid/hook")


class OutboxTests(unittest.TestCase):
    def test_retries_only_failed_channels_across_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "reliability.db"
            captured = CapturedAlert(
                message=AlertMessage(
                    title="test",
                    text="body",
                    level="warning",
                    source="rule:test",
                    dedup_key="rule:test:fire:0",
                ),
                channels=None,
            )
            sender = FakeSender()
            store = OutboxStore(path)
            event_id = store.enqueue(
                captured,
                ["primary", "secondary"],
                now=100,
            )
            first = store.deliver_pending(sender, now=100)
            store.close()

            reopened = OutboxStore(path)
            second = reopened.deliver_pending(sender, now=103)
            status = reopened.event_status(str(event_id))
            reopened.close()

        self.assertEqual(first.delivered, 1)
        self.assertEqual(first.failed, 1)
        self.assertEqual(first.pending, 1)
        self.assertEqual(second.delivered, 1)
        self.assertEqual(second.pending, 0)
        self.assertEqual(sender.calls, ["primary", "secondary", "secondary"])
        self.assertEqual(
            status,
            {"primary": "delivered", "secondary": "delivered"},
        )
        self.assertNotIn("secret.invalid", first.errors[0])

    def test_duplicate_enqueue_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            store = OutboxStore(Path(directory) / "reliability.db")
            captured = CapturedAlert(
                message=AlertMessage(
                    title="test",
                    text="body",
                    source="rule:test",
                    dedup_key="same",
                ),
                channels=None,
            )
            first = store.enqueue(captured, ["one"], now=1)
            second = store.enqueue(captured, ["one"], now=2)
            pending = store.pending_count()
            store.close()

        self.assertEqual(first, second)
        self.assertEqual(pending, 1)


class StateMigrationTests(unittest.TestCase):
    def test_v1_state_is_backed_up_and_migrated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "samples": [],
                        "rules": {},
                        "collectors": {},
                        "step": 4,
                    }
                ),
                encoding="utf-8",
            )
            store = StateStore(path)

            state = store.load()

            self.assertEqual(state["version"], 2)
            self.assertEqual(state["step"], 4)
            self.assertTrue(path.with_name("state.json.v1.bak").exists())

    def test_v1_backup_is_refreshed_until_primary_is_migrated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            base = {
                "version": 1,
                "samples": [],
                "rules": {},
                "collectors": {},
                "step": 1,
            }
            path.write_text(json.dumps(base), encoding="utf-8")
            store = StateStore(path)
            store.load()
            base["step"] = 2
            path.write_text(json.dumps(base), encoding="utf-8")

            store.load()
            backup = json.loads(
                path.with_name("state.json.v1.bak").read_text(encoding="utf-8")
            )

        self.assertEqual(backup["step"], 2)

    def test_future_state_version_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            path.write_text(
                json.dumps(
                    {
                        "version": 99,
                        "samples": [],
                        "rules": {},
                        "collectors": {},
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaises(MonitorError):
                StateStore(path).load()


class RuleCacheTests(unittest.TestCase):
    def test_invalid_rule_reload_uses_last_known_good_rules(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            store = RuleStore(path)
            store.write(
                [{"alert": "cpu", "expr": "cpu.percent > 90"}]
            )
            first = store.load()
            path.write_text("{invalid", encoding="utf-8")

            fallback = store.load()

        self.assertEqual(first[0].name, "cpu")
        self.assertEqual(fallback[0].name, "cpu")
        self.assertIsNotNone(store.last_error)

    def test_invalid_initial_rule_file_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rules.json"
            path.write_text("{invalid", encoding="utf-8")

            with self.assertRaises(RuleError):
                RuleStore(path).load()


class RuntimeReliabilityTests(unittest.TestCase):
    def test_history_failure_does_not_block_alert_delivery(self):
        sink = []
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)
            settings = load_settings(path)
            settings = replace(
                settings,
                state_file=Path(directory) / "state.json",
                history=replace(
                    settings.history,
                    directory=Path(directory) / "history",
                ),
                alerts=AlertSettings(
                    enabled=True,
                    env_file=None,
                    env={},
                    channels=(
                        {
                            "type": "callable",
                            "name": "test",
                            "options": {"handler": sink.append},
                        },
                    ),
                    policy={
                        "max_retries": 0,
                        "dedup_window": 0,
                        "rate_limit_per_minute": None,
                    },
                ),
            )
            write_default_rules(settings.rules_file)
            RuleStore(settings.rules_file).write(
                [
                    {
                        "alert": "high-cpu",
                        "expr": "cpu.percent > 90",
                        "for": 1,
                    }
                ]
            )
            collector = MutableCollector("fake", "cpu/percent", 95)
            with patch(
                "host_monitor.runtime.build_collectors",
                return_value=[collector],
            ):
                runtime = MonitorRuntime(
                    settings,
                    clock=lambda: 100,
                    monotonic=lambda: 10,
                )
                with patch.object(
                    runtime.history,
                    "append",
                    side_effect=MonitorError("disk full"),
                ):
                    try:
                        result = runtime.cycle()
                    finally:
                        runtime.close()

        self.assertEqual(len(sink), 1)
        self.assertTrue(
            any("history write failed" in warning for warning in result.warnings)
        )
        self.assertEqual(result.metrics["monitor/outbox/pending"], 0)


class TimeRuleTests(unittest.TestCase):
    def test_elapsed_uses_runtime_start(self):
        rule = AlertRule.from_dict(
            {"alert": "elapsed", "expr": "elapsed() >= 60", "for": 1}
        )

        result = evaluate_rules(
            [rule],
            {},
            {},
            hostname="localhost",
            history_size=10,
            now=100,
            started_at=0,
            last_commit_time=100,
        )

        self.assertEqual(len(result.alerts), 1)

    def test_no_data_detects_gap_since_previous_commit(self):
        rule = AlertRule.from_dict(
            {"alert": "gap", "expr": "no_data(30)", "for": 1}
        )

        result = evaluate_rules(
            [rule],
            {},
            {},
            hostname="localhost",
            history_size=10,
            now=100,
            started_at=0,
            last_commit_time=50,
        )

        self.assertEqual(len(result.alerts), 1)


if __name__ == "__main__":
    unittest.main()
