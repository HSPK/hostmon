from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from expr_tracker.alerts import AlertMessage, AlertRule

from host_monitor.alerts import (
    AlertSender,
    LightweightLarkBackend,
    read_dotenv,
)
from host_monitor.config import AlertSettings
from host_monitor.errors import AlertError, RuleError
from host_monitor.rules import RuleStore, evaluate_rules


def next_state(previous, evaluation):
    return {
        "step": evaluation.sample["_step"],
        "samples": list(previous.get("samples", [])) + [evaluation.sample],
        "rules": evaluation.rule_states,
    }


def lark_sender(
    *, options: dict | None = None, policy: dict | None = None
) -> AlertSender:
    return AlertSender(
        AlertSettings(
            enabled=True,
            env_file=None,
            env={},
            channels=(
                {
                    "type": "lark",
                    "name": "lark",
                    "url": "https://example.invalid/webhook",
                    "min_level": "info",
                    "options": options or {},
                },
            ),
            policy=policy
            or {
                "max_retries": 0,
                "rate_limit_per_minute": None,
                "dedup_window": 0,
            },
        )
    )


class RuleEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.rule = AlertRule.from_dict(
            {
                "alert": "high-cpu",
                "expr": "cpu.percent >= 80",
                "level": "warning",
                "title": "CPU high | {host}",
                "message": "{expr}",
                "for": 2,
                "mode": "level",
                "cooldown": 3600,
                "notify_recovery": True,
            }
        )

    def test_persists_for_cooldown_and_recovery(self):
        state = {}
        first = evaluate_rules(
            [self.rule],
            {"cpu/percent": 90},
            state,
            hostname="localhost",
            history_size=10,
            now=100,
        )
        self.assertEqual(first.alerts, [])
        state = next_state(state, first)

        second = evaluate_rules(
            [self.rule],
            {"cpu/percent": 91},
            state,
            hostname="localhost",
            history_size=10,
            now=101,
        )
        self.assertEqual(len(second.alerts), 1)
        state = next_state(state, second)

        third = evaluate_rules(
            [self.rule],
            {"cpu/percent": 92},
            state,
            hostname="localhost",
            history_size=10,
            now=102,
        )
        self.assertEqual(third.alerts, [])
        state = next_state(state, third)

        recovered = evaluate_rules(
            [self.rule],
            {"cpu/percent": 20},
            state,
            hostname="localhost",
            history_size=10,
            now=103,
        )
        self.assertEqual(len(recovered.alerts), 1)
        self.assertEqual(recovered.alerts[0].message.level.value, "info")

    def test_missing_dotted_metric_does_not_shadow_later_slash_metric(self):
        immediate = AlertRule.from_dict(
            {"alert": "network", "expr": "network.rx_mbps > 1", "for": 1}
        )
        state = {}
        missing = evaluate_rules(
            [immediate],
            {},
            state,
            hostname="localhost",
            history_size=10,
            now=1,
        )
        state = next_state(state, missing)
        present = evaluate_rules(
            [immediate],
            {"network/rx_mbps": 2},
            state,
            hostname="localhost",
            history_size=10,
            now=2,
        )

        self.assertEqual(len(present.alerts), 1)

    def test_k8s_alert_only_fires_on_stopped_task_edge(self):
        rule = AlertRule.from_dict(
            {
                "alert": "k8s-task-drop",
                "expr": "k8s.stopped_task_count > 0",
                "title": "K8s 任务停止或缩容",
                "message": "停止的任务：{k8s_stopped_tasks}",
                "for": 1,
                "mode": "edge",
                "notify_recovery": False,
            }
        )

        state = {}
        initial = evaluate_rules(
            [rule],
            {
                "k8s/failed_task_count": 0,
                "k8s/stopped_task_count": 0,
            },
            state,
            fields={"k8s_stopped_tasks": "(none)"},
            hostname="localhost",
            history_size=10,
            now=1,
        )
        self.assertEqual(initial.alerts, [])
        state = next_state(state, initial)

        failed_only = evaluate_rules(
            [rule],
            {
                "k8s/failed_task_count": 1,
                "k8s/stopped_task_count": 0,
            },
            state,
            fields={"k8s_stopped_tasks": "(none)"},
            hostname="localhost",
            history_size=10,
            now=2,
        )
        self.assertEqual(failed_only.alerts, [])
        state = next_state(state, failed_only)

        dropped = evaluate_rules(
            [rule],
            {
                "k8s/failed_task_count": 1,
                "k8s/stopped_task_count": 1,
            },
            state,
            fields={"k8s_stopped_tasks": "job-a"},
            hostname="localhost",
            history_size=10,
            now=3,
        )

        self.assertEqual(dropped.alerts[0].message.title, "K8s 任务停止或缩容")
        self.assertEqual(dropped.alerts[0].message.text, "停止的任务：job-a")
        state = next_state(state, dropped)

        steady = evaluate_rules(
            [rule],
            {
                "k8s/failed_task_count": 1,
                "k8s/stopped_task_count": 1,
            },
            state,
            fields={"k8s_stopped_tasks": "(none)"},
            hostname="localhost",
            history_size=10,
            now=4,
        )
        self.assertEqual(steady.alerts, [])

    def test_permission_alert_only_fires_on_false_to_true_edge(self):
        rule = AlertRule.from_dict(
            {
                "alert": "volcano-access",
                "expr": "permission.team_volcano_jobs.allowed == 1",
                "title": "Volcano Job 权限已开通",
                "message": "权限：{permission_team_volcano_jobs_granted_verbs}",
                "for": 1,
                "mode": "edge",
            }
        )
        state = {}
        denied = evaluate_rules(
            [rule],
            {"permission/team_volcano_jobs/allowed": 0},
            state,
            fields={
                "permission_team_volcano_jobs_granted_verbs": "(无)"
            },
            hostname="localhost",
            history_size=10,
            now=1,
        )
        self.assertEqual(denied.alerts, [])
        state = next_state(state, denied)

        allowed = evaluate_rules(
            [rule],
            {"permission/team_volcano_jobs/allowed": 1},
            state,
            fields={
                "permission_team_volcano_jobs_granted_verbs": (
                    "create, get, list, watch"
                )
            },
            hostname="localhost",
            history_size=10,
            now=2,
        )
        self.assertEqual(len(allowed.alerts), 1)
        self.assertEqual(
            allowed.alerts[0].message.title,
            "Volcano Job 权限已开通",
        )
        state = next_state(state, allowed)

        still_allowed = evaluate_rules(
            [rule],
            {"permission/team_volcano_jobs/allowed": 1},
            state,
            fields={
                "permission_team_volcano_jobs_granted_verbs": (
                    "create, get, list, watch"
                )
            },
            hostname="localhost",
            history_size=10,
            now=3,
        )
        self.assertEqual(still_allowed.alerts, [])


class RuleStoreTests(unittest.TestCase):
    def test_add_enable_disable_and_remove(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RuleStore(Path(directory) / "rules.json")
            store.write([])
            store.add({"alert": "memory", "expr": "memory.percent > 90"})
            self.assertEqual(len(store.load()), 1)

            store.set_enabled("memory", False)
            self.assertFalse(store.load()[0].enabled)
            store.set_enabled("memory", True)
            self.assertTrue(store.load()[0].enabled)
            store.remove("memory")
            self.assertEqual(store.load(), [])

    def test_rejects_duplicate_names_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            store = RuleStore(Path(directory) / "rules.json")
            with self.assertRaises(RuleError):
                store.write(
                    [
                        {"alert": "same", "expr": "cpu.percent > 1"},
                        {"alert": "same", "expr": "cpu.percent > 2"},
                    ]
                )
            self.assertFalse(store.path.exists())


class AlertSenderTests(unittest.TestCase):
    def test_dotenv_only_parses_requested_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text(
                'UNRELATED="unterminated\nnot dotenv syntax\n'
                'WEBHOOK_URL="https://example.invalid"\n',
                encoding="utf-8",
            )

            values = read_dotenv(path, {"WEBHOOK_URL"})

        self.assertEqual(values["WEBHOOK_URL"], "https://example.invalid")

    def test_manual_alert_uses_expr_tracker_dispatcher(self):
        sink = []
        settings = AlertSettings(
            enabled=True,
            env_file=None,
            env={},
            channels=(
                {
                    "type": "callable",
                    "name": "test",
                    "options": {"handler": sink.append},
                    "min_level": "info",
                },
            ),
            policy={
                "max_retries": 0,
                "rate_limit_per_minute": None,
                "dedup_window": 0,
            },
        )
        sender = AlertSender(settings)
        try:
            sender.send_manual(
                title="test",
                text="message",
                level="warning",
            )
        finally:
            sender.close()

        self.assertEqual(len(sink), 1)
        self.assertEqual(sink[0].title, "test")

    @patch(
        "host_monitor.alerts.post_json",
        return_value='{"code": 0, "msg": "success"}',
    )
    def test_lark_alert_uses_lightweight_interactive_card(self, post):
        sender = lark_sender()
        message = AlertMessage(
            title="GPU capacity",
            subtitle="2026-08-30 18:00:00",
            text="No free GPUs",
            level="warning",
        )
        try:
            sender.send_one(message, "lark")
            backend = sender.dispatcher.channels["lark"].backend
        finally:
            sender.close()

        self.assertIsInstance(backend, LightweightLarkBackend)
        url, payload, timeout, headers = post.call_args.args
        self.assertEqual(url, "https://example.invalid/webhook")
        self.assertEqual(timeout, 10)
        self.assertIsNone(headers)
        self.assertEqual(payload["msg_type"], "interactive")
        self.assertEqual(
            payload["card"]["header"],
            {
                "title": {
                    "tag": "plain_text",
                    "content": "\u26a0\ufe0f GPU capacity",
                },
                "subtitle": {
                    "tag": "plain_text",
                    "content": "2026-08-30 18:00:00",
                },
                "template": "green",
                "ud_icon": {"token": "yes_filled"},
            },
        )
        self.assertEqual(
            payload["card"]["elements"][1]["content"],
            "```txt\n2026-08-30 18:00:00\nNo free GPUs\n```",
        )

    @patch(
        "host_monitor.alerts.post_json",
        return_value='{"code": 0, "msg": "success"}',
    )
    def test_lark_error_card_preserves_existing_shape(self, post):
        sender = lark_sender(policy={"max_retries": 0})
        message = AlertMessage(
            title="Collector failed",
            subtitle="2026-08-30 18:00:00",
            text="GPU data unavailable",
            level="error",
            traceback="CollectorError: timeout",
        )
        try:
            sender.send_one(message, "lark")
        finally:
            sender.close()

        payload = post.call_args.args[1]
        self.assertEqual(payload["card"]["header"]["template"], "red")
        self.assertEqual(
            payload["card"]["header"]["ud_icon"],
            {"token": "error_filled"},
        )
        self.assertEqual(
            payload["card"]["elements"][1]["content"],
            (
                "```txt\n2026-08-30 18:00:00\nGPU data unavailable\n\n"
                "CollectorError: timeout\n```"
            ),
        )
        self.assertEqual(
            payload["card"]["elements"][3]["content"],
            "```\nCollectorError: timeout\n```",
        )

    @patch(
        "host_monitor.alerts.post_json",
        return_value='{"code": 19001, "msg": "denied"}',
    )
    def test_lark_alert_rejects_application_error(self, post):
        sender = lark_sender(policy={"max_retries": 0})
        try:
            with self.assertRaisesRegex(AlertError, "code=19001"):
                sender.send_manual(
                    title="test",
                    text="message",
                    level="warning",
                )
        finally:
            sender.close()

        post.assert_called_once()

    @patch("host_monitor.alerts.ExprTrackerLarkBackend.send")
    def test_lark_advanced_options_use_expr_tracker_backend(self, send):
        sender = lark_sender(
            options={"max_retries": 1},
            policy={"max_retries": 0},
        )
        try:
            sender.send_manual(
                title="test",
                text="message",
                level="warning",
            )
            backend = sender.dispatcher.channels["lark"].backend
        finally:
            sender.close()

        self.assertIsInstance(backend, LightweightLarkBackend)
        self.assertIsNotNone(backend.fallback)
        send.assert_called_once()

    def test_manual_alert_rejects_disabled_configuration(self):
        sender = AlertSender(
            AlertSettings(
                enabled=False,
                env_file=None,
                env={},
                channels=(),
                policy={},
            )
        )
        with self.assertRaises(AlertError):
            sender.send_manual(title="test", text="x", level="warning")


if __name__ == "__main__":
    unittest.main()
