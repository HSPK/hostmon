from __future__ import annotations

import json
import socket
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from host_monitor.config import PrometheusSettings
from host_monitor.errors import MonitorError
from host_monitor.prometheus import (
    PrometheusExporter,
    StateSnapshot,
    prometheus_names,
    render_prometheus,
)
from host_monitor.state import StateStore


class PrometheusRenderingTests(unittest.TestCase):
    def test_renders_gauges_counters_and_sample_metadata(self):
        output = render_prometheus(
            StateSnapshot(
                host="host-a",
                updated_at=100,
                metrics={
                    "cpu/percent": 25.5,
                    "network/errors_total": 3,
                },
                fields={},
            ),
            now=105,
        )

        self.assertIn("hostmon_cpu_percent 25.5", output)
        self.assertIn("# TYPE hostmon_cpu_percent gauge", output)
        self.assertIn("# TYPE hostmon_network_errors_total counter", output)
        self.assertIn("hostmon_sample_age_seconds 5.000000", output)

    def test_name_collisions_receive_stable_hash_suffixes(self):
        names = prometheus_names(["metric/a-b", "metric/a_b"])

        self.assertNotEqual(names["metric/a-b"], names["metric/a_b"])
        self.assertTrue(names["metric/a-b"].startswith("hostmon_metric_a_b_"))
        self.assertEqual(names, prometheus_names(["metric/a_b", "metric/a-b"]))


class PrometheusHTTPTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.state_file = Path(self.directory.name) / "state.json"
        self.settings = PrometheusSettings(
            enabled=True,
            host="127.0.0.1",
            port=0,
            max_sample_age_seconds=30,
        )
        self.exporter = PrometheusExporter(self.settings, self.state_file)

    def tearDown(self):
        self.exporter.close()
        self.directory.cleanup()

    def save_state(self, updated_at: float) -> None:
        StateStore(self.state_file).save(
            {
                "samples": [],
                "rules": {},
                "collectors": {},
                "updated_at": updated_at,
                "host": "host-a",
                "last_metrics": {"cpu/percent": 42},
                "last_fields": {"task": "training-a"},
            }
        )

    def url(self, path: str) -> str:
        address = self.exporter.address
        self.assertIsNotNone(address)
        host, port = address
        return f"http://{host}:{port}{path}"

    def test_serves_metrics_health_and_json_status(self):
        self.save_state(time.time())
        self.exporter.start()

        with urllib.request.urlopen(self.url("/metrics"), timeout=5) as response:
            metrics = response.read().decode()
        with urllib.request.urlopen(self.url("/healthz"), timeout=5) as response:
            health = response.read().decode()
        with urllib.request.urlopen(self.url("/api/status"), timeout=5) as response:
            status = json.load(response)

        self.assertIn("hostmon_cpu_percent 42.0", metrics)
        self.assertEqual(health, "ok\n")
        self.assertEqual(status["host"], "host-a")
        self.assertEqual(status["fields"]["task"], "training-a")

    def test_stale_sample_returns_unhealthy(self):
        self.save_state(time.time() - 60)
        self.exporter.start()

        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(self.url("/healthz"), timeout=5)

        self.assertEqual(context.exception.code, 503)

    def test_bind_failure_is_reported(self):
        blocker = socket.socket()
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        port = blocker.getsockname()[1]
        exporter = PrometheusExporter(
            PrometheusSettings(
                enabled=True,
                host="127.0.0.1",
                port=port,
                max_sample_age_seconds=30,
            ),
            self.state_file,
        )
        try:
            with self.assertRaises(MonitorError):
                exporter.start()
        finally:
            blocker.close()
            exporter.close()


if __name__ == "__main__":
    unittest.main()
