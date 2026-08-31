from __future__ import annotations

import contextlib
import io
import logging
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from host_monitor.cli import configure_logging, main
from host_monitor.collectors.base import CollectorResult
from host_monitor.config import initialize_config, load_settings
from host_monitor.rules import RuleStore, write_default_rules
from host_monitor.runtime import MonitorRuntime
from host_monitor.service import render_unit


class FakeCollector:
    name = "fake"

    def collect(self, previous, now):
        return CollectorResult(
            metrics={"cpu/percent": 95},
            state={"at": now},
        )


class CLITests(unittest.TestCase):
    def invoke(self, arguments):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(arguments)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_config_and_rule_management_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            config = str(Path(directory) / "config.toml")
            code, _, _ = self.invoke(["--config", config, "config", "init"])
            self.assertEqual(code, 0)

            code, output, _ = self.invoke(
                [
                    "--config",
                    config,
                    "rules",
                    "add",
                    "test-rule",
                    "cpu.percent > 99",
                ]
            )
            self.assertEqual(code, 0)
            self.assertIn("rule added", output)

            code, _, _ = self.invoke(
                ["--config", config, "rules", "disable", "test-rule"]
            )
            self.assertEqual(code, 0)
            settings = load_settings(config)
            rules = {rule.name: rule for rule in RuleStore(settings.rules_file).load()}
            self.assertFalse(rules["test-rule"].enabled)

            code, _, _ = self.invoke(
                ["--config", config, "rules", "remove", "test-rule"]
            )
            self.assertEqual(code, 0)

    def test_start_stop_disable_commands_delegate_to_service(self):
        with (
            patch("host_monitor.cli.start_service") as start,
            patch("host_monitor.cli.stop_service") as stop,
            patch("host_monitor.cli.disable_service") as disable,
        ):
            self.assertEqual(self.invoke(["start"])[0], 0)
            self.assertEqual(self.invoke(["stop"])[0], 0)
            self.assertEqual(self.invoke(["disable", "--now"])[0], 0)

        start.assert_called_once()
        stop.assert_called_once()
        disable.assert_called_once_with(now=True)

    def test_exporter_start_and_stop_update_config_and_restart_service(self):
        with tempfile.TemporaryDirectory() as directory:
            config = str(Path(directory) / "config.toml")
            self.assertEqual(
                self.invoke(["--config", config, "config", "init"])[0],
                0,
            )
            with (
                patch("host_monitor.cli.enable_service") as enable,
                patch("host_monitor.cli.restart_service") as restart,
                patch("host_monitor.cli.wait_for_exporter") as wait,
            ):
                code, output, _ = self.invoke(
                    [
                        "--config",
                        config,
                        "exporter",
                        "start",
                        "--host",
                        "127.0.0.2",
                        "--port",
                        "9200",
                    ]
                )

            self.assertEqual(code, 0)
            self.assertIn("Dashboard started", output)
            self.assertIn("Prometheus metrics", output)
            settings = load_settings(config)
            self.assertTrue(settings.prometheus.enabled)
            self.assertEqual(settings.prometheus.port, 9200)
            enable.assert_called_once()
            restart.assert_called_once()
            wait.assert_called_once()

            with (
                patch(
                    "host_monitor.cli.service_status",
                    return_value={"ActiveState": "active"},
                ),
                patch("host_monitor.cli.restart_service") as restart,
            ):
                code, output, _ = self.invoke(
                    ["--config", config, "exporter", "stop"]
                )

            self.assertEqual(code, 0)
            self.assertIn("host monitoring remains active", output)
            self.assertFalse(load_settings(config).prometheus.enabled)
            restart.assert_called_once()

    def test_http_client_logs_are_suppressed(self):
        configure_logging()

        self.assertEqual(logging.getLogger("httpx").level, logging.WARNING)
        self.assertEqual(logging.getLogger("httpcore").level, logging.WARNING)

    def test_version_flag_uses_short_cli_name(self):
        with self.assertRaises(SystemExit) as exit_context:
            self.invoke(["--version"])

        self.assertEqual(exit_context.exception.code, 0)


class RuntimeTests(unittest.TestCase):
    def test_cycle_evaluates_rules_and_persists_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)
            settings = replace(
                load_settings(path),
                state_file=Path(directory) / "state.json",
            )
            settings = replace(
                settings,
                history=replace(
                    settings.history,
                    directory=Path(directory) / "history",
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
            with patch(
                "host_monitor.runtime.build_collectors",
                return_value=[FakeCollector()],
            ):
                runtime = MonitorRuntime(
                    settings,
                    clock=lambda: 100,
                    monotonic=lambda: 10,
                )
                try:
                    result = runtime.cycle(send_alerts=False)
                finally:
                    runtime.close()

            state = runtime.state_store.load()
            self.assertEqual(len(result.alerts), 1)
            self.assertEqual(state["last_metrics"]["cpu/percent"], 95)
            self.assertEqual(state["step"], 0)


class ServiceTests(unittest.TestCase):
    def test_unit_runs_installed_module_with_selected_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)
            settings = load_settings(path)
            unit = render_unit(settings)

        self.assertIn("-m host_monitor", unit)
        self.assertIn(f"--config {path}", unit)
        self.assertIn("Restart=on-failure", unit)
        self.assertIn("Environment=OPENBLAS_NUM_THREADS=1", unit)
        self.assertIn("Environment=MALLOC_ARENA_MAX=2", unit)
        self.assertIn("WantedBy=default.target", unit)


if __name__ == "__main__":
    unittest.main()
