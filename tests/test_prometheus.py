from __future__ import annotations

import json
import asyncio
import re
import socket
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from aiohttp import ClientSession, WSMsgType, WSServerHandshakeError

from host_monitor.config import CollectorSettings, PrometheusSettings
from host_monitor.dashboard import DashboardStore, infer_metric_metadata
from host_monitor.dashboard import load_history_window, load_recent_history
from host_monitor.errors import MonitorError
from host_monitor.prometheus import (
    PrometheusExporter,
    StateSnapshot,
    prometheus_names,
    render_prometheus,
)
from host_monitor.preferences import validate_dashboard_preferences
from host_monitor.rules import DEFAULT_RULES, RuleStore
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

    def test_metric_metadata_uses_generic_labels_and_units(self):
        metadata = infer_metric_metadata(
            "cluster_gpu/queue/total/allocated_gpus"
        )

        self.assertEqual(
            metadata["label"],
            "cluster gpu / queue / total / allocated gpus",
        )
        self.assertEqual(metadata["unit"], "GPUs")

    def test_dashboard_history_is_bounded_and_columnar(self):
        store = DashboardStore(capacity=20)
        for index in range(30):
            store.publish(
                float(index),
                "host-a",
                {"cpu/percent": float(index)},
                {},
            )

        history = store.history(
            now=29,
            seconds=20,
            maximum_points=5,
            metrics=["cpu/percent"],
        )

        self.assertEqual(len(history["timestamps"]), 5)
        self.assertEqual(history["timestamps"][-1], 29)
        self.assertEqual(history["series"]["cpu/percent"][-1], 29)

    def test_dashboard_supports_custom_metrics_and_catalog_statistics(self):
        store = DashboardStore(capacity=20)
        for index in range(1, 6):
            store.publish(
                float(index),
                "host-a",
                {"custom/latency_ms": float(index * 10)},
                {},
            )

        history = store.history(
            now=5,
            seconds=10,
            maximum_points=20,
            metrics=["custom/latency_ms"],
        )
        catalog = store.catalog(now=5, seconds=10)

        self.assertEqual(
            history["series"]["custom/latency_ms"],
            [10, 20, 30, 40, 50],
        )
        self.assertEqual(catalog[0]["average"], 30)
        self.assertEqual(catalog[0]["p95"], 50)
        self.assertEqual(catalog[0]["metadata"]["unit"], "ms")

    def test_catalog_cache_is_invalidated_by_new_sample(self):
        store = DashboardStore()
        store.publish(1, "host-a", {"cpu/percent": 10}, {})

        first = store.catalog(now=1, seconds=60)
        second = store.catalog(now=2, seconds=60)
        store.publish(3, "host-a", {"cpu/percent": 20}, {})
        third = store.catalog(now=3, seconds=60)

        self.assertIs(first, second)
        self.assertIsNot(first, third)
        self.assertEqual(third[0]["current"], 20)
        revision, snapshot = store.catalog_snapshot(now=3, seconds=60)
        self.assertGreater(revision, 0)
        self.assertIs(snapshot, third)

    def test_loads_recent_history_from_end_of_segmented_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for part, values in enumerate(([1, 2], [3, 4]), start=1):
                path = root / f"metrics-2026-08-27-{part:04d}.jsonl"
                path.write_text(
                    "".join(
                        json.dumps(
                            {"_time": value, "metrics": {"custom/value": value}}
                        )
                        + "\n"
                        for value in values
                    ),
                    encoding="utf-8",
                )

            records = load_recent_history(root, 3)

        self.assertEqual([record["_time"] for record in records], [2, 3, 4])

    def test_long_history_is_aggregated_to_requested_point_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "metrics-2026-08-27-0001.jsonl"
            path.write_text(
                "".join(
                    json.dumps(
                        {
                            "_time": float(index),
                            "metrics": {"cpu/percent": float(index)},
                        }
                    )
                    + "\n"
                    for index in range(100)
                ),
                encoding="utf-8",
            )

            history = load_history_window(
                root,
                now=100,
                seconds=100,
                maximum_points=10,
                metrics=["cpu/percent"],
            )

        self.assertLessEqual(len(history["timestamps"]), 10)
        self.assertEqual(history["series"]["cpu/percent"][0], 9)
        self.assertEqual(history["series"]["cpu/percent"][-1], 99)
        self.assertEqual(history["resolution_seconds"], 10)


class PrometheusHTTPTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.state_file = Path(self.directory.name) / "state.json"
        self.rules_file = Path(self.directory.name) / "rules.json"
        RuleStore(self.rules_file).write([DEFAULT_RULES[0]])
        self.settings = PrometheusSettings(
            enabled=True,
            host="127.0.0.1",
            port=0,
            max_sample_age_seconds=30,
        )
        self.exporter = PrometheusExporter(
            self.settings,
            self.state_file,
            rules_file=self.rules_file,
            collector_settings=(
                CollectorSettings(
                    name="cpu",
                    enabled=True,
                    required=True,
                    deadline_seconds=2,
                    max_stale_seconds=0,
                    options={},
                ),
            ),
            interval_seconds=10,
        )

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
        with urllib.request.urlopen(
            self.url("/api/catalog?seconds=3600"),
            timeout=5,
        ) as response:
            catalog = json.load(response)

        self.assertIn("hostmon_cpu_percent 42.0", metrics)
        self.assertEqual(health, "ok\n")
        self.assertEqual(status["host"], "host-a")
        self.assertEqual(status["version"], "0.1.1.dev0")
        self.assertEqual(status["fields"]["task"], "training-a")
        self.assertEqual(catalog["metrics"][0]["name"], "cpu/percent")

    def test_serves_dashboard_history_and_websocket(self):
        self.save_state(time.time())
        self.exporter.start()
        self.exporter.publish(
            time.time() + 1,
            "host-a",
            {"cpu/percent": 43},
            {"task": "training-b"},
        )

        with urllib.request.urlopen(self.url("/"), timeout=5) as response:
            dashboard = response.read().decode()
        with urllib.request.urlopen(
            self.url("/dashboard.json"),
            timeout=5,
        ) as response:
            dashboard_config = json.load(response)
        with urllib.request.urlopen(
            self.url("/api/history?seconds=3600&max_points=100"),
            timeout=5,
        ) as response:
            history = json.load(response)
        script_path = re.search(r'src="([^"]+\.js)"', dashboard)
        self.assertIsNotNone(script_path)
        with urllib.request.urlopen(
            self.url(script_path.group(1)),
            timeout=5,
        ) as response:
            script = response.read().decode()
        event = asyncio.run(self.websocket_event())

        self.assertIn("hostmon operations dashboard", dashboard)
        self.assertTrue(dashboard_config["navigation"])
        self.assertTrue(dashboard_config["panels"])
        self.assertIn("requestAnimationFrame", script)
        self.assertIn("WebSocket", script)
        self.assertNotIn("https://", dashboard)
        self.assertEqual(history["series"]["cpu/percent"][-1], 43)
        self.assertEqual(event["metrics"]["cpu/percent"], 43)

    async def websocket_event(self):
        address = self.exporter.address
        self.assertIsNotNone(address)
        host, port = address
        async with ClientSession() as session:
            async with session.ws_connect(f"http://{host}:{port}/api/ws") as socket:
                message = await socket.receive(timeout=5)
                self.assertEqual(message.type, WSMsgType.TEXT)
                return json.loads(message.data)

    async def websocket_broadcast(self, count: int):
        address = self.exporter.address
        self.assertIsNotNone(address)
        host, port = address
        async with ClientSession() as session:
            sockets = [
                await session.ws_connect(f"http://{host}:{port}/api/ws")
                for _ in range(count)
            ]
            try:
                await asyncio.gather(
                    *(socket.receive(timeout=5) for socket in sockets)
                )
                self.exporter.publish(
                    time.time() + 1,
                    "host-a",
                    {"cpu/percent": 99},
                    {},
                )
                messages = await asyncio.gather(
                    *(socket.receive(timeout=5) for socket in sockets)
                )
                return [
                    json.loads(message.data)["metrics"]["cpu/percent"]
                    for message in messages
                ]
            finally:
                await asyncio.gather(*(socket.close() for socket in sockets))

    async def concurrent_history_requests(self, count: int):
        address = self.exporter.address
        self.assertIsNotNone(address)
        host, port = address
        url = (
            f"http://{host}:{port}/api/history"
            "?seconds=21601&max_points=100&metrics=cpu/percent"
        )
        async with ClientSession() as session:
            responses = await asyncio.gather(
                *(session.get(url) for _ in range(count))
            )
            try:
                return await asyncio.gather(
                    *(response.json() for response in responses)
                )
            finally:
                for response in responses:
                    response.release()

    async def cross_origin_websocket_status(self):
        address = self.exporter.address
        self.assertIsNotNone(address)
        host, port = address
        async with ClientSession() as session:
            try:
                await session.ws_connect(
                    f"http://{host}:{port}/api/ws",
                    origin="https://attacker.invalid",
                )
            except WSServerHandshakeError as error:
                return error.status
        return 101

    def test_backpressure_queue_keeps_only_latest_payload(self):
        async def exercise():
            messages = asyncio.Queue(maxsize=1)
            self.exporter._enqueue_latest(messages, "one")
            self.exporter._enqueue_latest(messages, "two")
            return messages.get_nowait()

        self.assertEqual(asyncio.run(exercise()), "two")

    def test_stale_sample_returns_unhealthy(self):
        self.save_state(time.time() - 60)
        self.exporter.start()

        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(self.url("/healthz"), timeout=5)

        self.assertEqual(context.exception.code, 503)

    def test_serves_plugin_document(self):
        StateStore(self.state_file).save(
            {
                "samples": [],
                "rules": {},
                "collectors": {
                    "document_plugin": {
                        "_hostmon_envelope": 1,
                        "plugin_state": {
                            "schema_version": 3,
                            "at": 100,
                            "report": {"usage": [{"submitter": "run-a"}]},
                        },
                    }
                },
                "updated_at": time.time(),
                "host": "host-a",
                "last_metrics": {"cpu/percent": 42},
                "last_fields": {},
            }
        )
        self.exporter.start()

        with urllib.request.urlopen(
            self.url("/api/plugins/document_plugin"),
            timeout=5,
        ) as response:
            document = json.load(response)

        self.assertEqual(document["schema_version"], 3)
        self.assertEqual(document["document"]["usage"][0]["submitter"], "run-a")

    def test_persists_dashboard_preferences_over_http(self):
        self.save_state(time.time())
        self.exporter.start()
        preferences = validate_dashboard_preferences(
            {
                "hiddenPanels": ["network"],
                "panelOrder": ["overview", "network"],
                "windowSeconds": 3600,
                "activePage": "overview",
                "panelState": {},
                "panelColumns": {},
                "theme": "dark",
                "density": "compact",
                "customPanels": [],
            }
        )
        request = urllib.request.Request(
            self.url("/api/preferences"),
            data=json.dumps(preferences).encode(),
            headers={
                "Content-Type": "application/json",
                "Origin": self.url(""),
            },
            method="PUT",
        )

        with urllib.request.urlopen(request, timeout=5) as response:
            saved = json.load(response)
        with urllib.request.urlopen(
            self.url("/api/preferences"),
            timeout=5,
        ) as response:
            loaded = json.load(response)

        self.assertEqual(saved["preferences"], preferences)
        self.assertEqual(loaded["preferences"], preferences)

        patch = urllib.request.Request(
            self.url("/api/preferences"),
            data=json.dumps({"theme": "light"}).encode(),
            headers={
                "Content-Type": "application/json",
                "Origin": self.url(""),
            },
            method="PATCH",
        )
        with urllib.request.urlopen(patch, timeout=5) as response:
            updated = json.load(response)
        self.assertEqual(updated["preferences"]["theme"], "light")
        self.assertEqual(updated["preferences"]["density"], "compact")

    def test_serves_assets_from_external_dashboard_directory(self):
        self.save_state(time.time())
        root = Path(self.directory.name) / "external-dashboard"
        root.mkdir()
        (root / "index.html").write_text("external dashboard", encoding="utf-8")
        self.exporter.settings = PrometheusSettings(
            enabled=True,
            host="127.0.0.1",
            port=0,
            max_sample_age_seconds=30,
            dashboard_directory=root,
        )
        self.exporter.start()

        with urllib.request.urlopen(self.url("/"), timeout=5) as response:
            content = response.read().decode()

        self.assertEqual(content, "external dashboard")

    def test_rejects_invalid_dashboard_preferences(self):
        self.save_state(time.time())
        self.exporter.start()
        request = urllib.request.Request(
            self.url("/api/preferences"),
            data=b"{}",
            headers={
                "Content-Type": "application/json",
                "Origin": self.url(""),
            },
            method="PUT",
        )

        with self.assertRaises(urllib.error.HTTPError) as context:
            urllib.request.urlopen(request, timeout=5)

        self.assertEqual(context.exception.code, 400)

    def test_manages_alert_rules_over_http(self):
        self.save_state(time.time())
        self.exporter.start()
        created = {
            **DEFAULT_RULES[0],
            "alert": "test-rule",
            "expr": "cpu.percent >= 80",
        }

        request = urllib.request.Request(
            self.url("/api/rules"),
            data=json.dumps(created).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 201)
        created["enabled"] = False
        request = urllib.request.Request(
            self.url("/api/rules/test-rule"),
            data=json.dumps(created).encode(),
            headers={"Content-Type": "application/json"},
            method="PUT",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
        with urllib.request.urlopen(self.url("/api/rules"), timeout=5) as response:
            rules = json.load(response)["rules"]
        self.assertFalse(next(rule for rule in rules if rule["alert"] == "test-rule")["enabled"])
        request = urllib.request.Request(
            self.url("/api/rules/test-rule"),
            method="DELETE",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 204)

    def test_serves_collector_diagnostics(self):
        self.save_state(time.time())
        self.exporter.start()

        with urllib.request.urlopen(
            self.url("/api/collectors"),
            timeout=5,
        ) as response:
            collectors = json.load(response)["collectors"]

        self.assertEqual(collectors[0]["name"], "cpu")
        self.assertEqual(collectors[0]["refresh_seconds"], 10)
        self.assertEqual(collectors[0]["deadline_seconds"], 2)

    def test_serves_external_dashboard_configuration(self):
        dashboard_file = Path(self.directory.name) / "dashboard.json"
        dashboard_file.write_text(
            json.dumps({"title": "custom-dashboard"}),
            encoding="utf-8",
        )
        self.exporter.settings = PrometheusSettings(
            enabled=True,
            host="127.0.0.1",
            port=0,
            max_sample_age_seconds=30,
            dashboard_file=dashboard_file,
        )
        self.save_state(time.time())
        self.exporter.start()

        with urllib.request.urlopen(
            self.url("/dashboard.json"),
            timeout=5,
        ) as response:
            dashboard = json.load(response)

        self.assertEqual(dashboard["title"], "custom-dashboard")

    def test_multiple_websocket_clients_receive_broadcast(self):
        self.save_state(time.time())
        self.exporter.start()

        received = asyncio.run(self.websocket_broadcast(20))

        self.assertEqual(received, [99] * 20)

    def test_long_history_requests_share_one_disk_scan(self):
        history = Path(self.directory.name) / "history"
        history.mkdir()
        now = time.time()
        (history / "metrics-2026-08-28-0001.jsonl").write_text(
            "".join(
                json.dumps(
                    {
                        "_time": now - index * 10,
                        "metrics": {"cpu/percent": index},
                    }
                )
                + "\n"
                for index in range(20)
            ),
            encoding="utf-8",
        )
        self.exporter.history_directory = history
        self.save_state(now)
        with patch(
            "host_monitor.prometheus.load_history_window",
            wraps=load_history_window,
        ) as loader:
            self.exporter.start()
            payloads = asyncio.run(self.concurrent_history_requests(8))

        self.assertEqual(loader.call_count, 1)
        self.assertEqual(len(payloads), 8)
        self.assertTrue(all(payload == payloads[0] for payload in payloads))

    def test_websocket_rejects_cross_origin_client(self):
        self.save_state(time.time())
        self.exporter.start()

        status = asyncio.run(self.cross_origin_websocket_status())

        self.assertEqual(status, 403)

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
