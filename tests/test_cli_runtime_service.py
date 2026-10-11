from __future__ import annotations

import contextlib
import io
import json
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
    def test_snapshot_server_has_fresh_sessions_without_loading_rvx_engine(self):
        """Each process publishes new full-state versions, never reused metric cursors."""
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)
            settings = load_settings(path)
            settings = replace(
                settings,
                state_file=Path(directory) / "state.json",
                rvx_snapshots=replace(settings.rvx_snapshots, enabled=True, run_id="run-1"),
                prometheus=replace(settings.prometheus, enabled=True, port=0),
                history=replace(settings.history, directory=Path(directory) / "history"),
            )
            with patch("host_monitor.runtime.build_collectors", return_value=[]):
                runtime = MonitorRuntime(settings)
                try:
                    session = runtime.prometheus.rvx_snapshots.session_id
                    self.assertTrue(session)
                    self.assertFalse(hasattr(runtime, "rvx"))
                    self.assertNotIn("rvx_source_session_id", runtime.state)
                finally:
                    runtime.close()
                restored = MonitorRuntime(settings)
                try:
                    self.assertNotEqual(restored.prometheus.rvx_snapshots.session_id, session)
                    self.assertEqual(
                        json.loads(restored.prometheus.rvx_snapshots.history(after=0))["snapshots"],
                        [],
                    )
                finally:
                    restored.close()

    def test_cycle_captures_public_state_independently_of_original_history(self):
        """The completed cycle publishes full state without moving private internals."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "config.toml"
            initialize_config(path)
            settings = load_settings(path)
            settings = replace(
                settings,
                state_file=root / "state.json",
                history=replace(settings.history, directory=root / "history"),
                prometheus=replace(settings.prometheus, enabled=True, port=0),
                rvx_snapshots=replace(settings.rvx_snapshots, enabled=True, run_id="run-1"),
            )
            write_default_rules(settings.rules_file)
            with patch("host_monitor.runtime.build_collectors", return_value=[FakeCollector()]):
                runtime = MonitorRuntime(settings, clock=lambda: 100, monotonic=lambda: 10)
                try:
                    result = runtime.cycle(send_alerts=False)
                    snapshot = json.loads(runtime.prometheus.rvx_snapshots.latest())
                    self.assertEqual(snapshot["sequence"], 0)
                    self.assertEqual(snapshot["observed_at_ns"], 100_000_000_000)
                    self.assertEqual(snapshot["state"]["metrics"], result.metrics)
                    self.assertIn("last_success_at", snapshot["state"]["collectors"]["fake"])
                    self.assertNotIn("plugin_state", snapshot["state"]["collectors"]["fake"])
                    self.assertNotIn("rules", snapshot["state"])
                    self.assertNotIn("samples", snapshot["state"])
                    self.assertEqual(snapshot["axes"]["hostmon_sample"], runtime.state["step"])
                    original = json.loads(Path(result.history_file).read_text().splitlines()[-1])
                    self.assertEqual(original["metrics"], result.metrics)
                    self.assertNotIn("source_session_id", original)
                finally:
                    runtime.close()

    def test_snapshot_failure_does_not_abort_original_monitoring(self):
        """An oversized optional snapshot becomes a warning, not a lost monitoring cycle."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "config.toml"
            initialize_config(path)
            settings = load_settings(path)
            settings = replace(
                settings,
                state_file=root / "state.json",
                history=replace(settings.history, directory=root / "history"),
                prometheus=replace(settings.prometheus, enabled=True, port=0),
                rvx_snapshots=replace(
                    settings.rvx_snapshots, enabled=True, run_id="run-1", max_buffer_bytes=100,
                ),
            )
            write_default_rules(settings.rules_file)
            with patch("host_monitor.runtime.build_collectors", return_value=[FakeCollector()]):
                runtime = MonitorRuntime(settings, clock=lambda: 100, monotonic=lambda: 10)
                try:
                    result = runtime.cycle(send_alerts=False)
                    self.assertEqual(result.metrics["cpu/percent"], 95)
                    self.assertTrue(any("RVX snapshot capture failed" in item for item in result.warnings))
                    self.assertEqual(runtime.state_store.load()["last_metrics"]["cpu/percent"], 95)
                    self.assertEqual(runtime.prometheus.dashboard.latest().metrics["cpu/percent"], 95)
                    self.assertTrue(Path(result.history_file).is_file())
                finally:
                    runtime.close()

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
