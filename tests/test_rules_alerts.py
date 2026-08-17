from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from expr_tracker.alerts import AlertRule

from host_monitor.alerts import AlertSender, read_dotenv
from host_monitor.config import AlertSettings
from host_monitor.errors import AlertError, RuleError
from host_monitor.rules import RuleStore, evaluate_rules


def next_state(previous, evaluation):
    return {
        "step": evaluation.sample["_step"],
        "samples": list(previous.get("samples", [])) + [evaluation.sample],
        "rules": evaluation.rule_states,
    }


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

    def test_k8s_alert_renders_node_ratio_and_failed_task_names(self):
        rule = AlertRule.from_dict(
            {
                "alert": "k8s",
                "expr": "k8s.failed_task_count > 0",
                "title": (
                    "K8s 节点 {k8s_occupied_gpu_nodes:.0f}/"
                    "{k8s_quota_nodes:.0f}"
                ),
                "message": "挂掉的任务：{k8s_failed_tasks}",
                "for": 1,
            }
        )

        result = evaluate_rules(
            [rule],
            {
                "k8s/failed_task_count": 1,
                "k8s/occupied_gpu_nodes": 6,
                "k8s/quota_nodes": 7,
            },
            {},
            fields={"k8s_failed_tasks": "job-a"},
            hostname="localhost",
            history_size=10,
            now=1,
        )

        self.assertEqual(result.alerts[0].message.title, "K8s 节点 6/7")
        self.assertEqual(result.alerts[0].message.text, "挂掉的任务：job-a")

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
