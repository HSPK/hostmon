from __future__ import annotations

import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from unittest.mock import patch

from host_monitor.config import RvxSnapshotSettings
from host_monitor.errors import MonitorError
from host_monitor.rvx_snapshots import (
    MAX_PAGE_BYTES,
    MAX_SNAPSHOT_BYTES,
    RvxSnapshotBuffer,
)


class SnapshotBufferTests(unittest.TestCase):
    def setUp(self):
        self.settings = RvxSnapshotSettings(enabled=True, run_id="run-test")
        self.buffer = RvxSnapshotBuffer(self.settings, "node-a")

    def capture(self, *, fields=None, metrics=None, collectors=None, alerts=None, step=0):
        return self.buffer.capture(
            100 + step, "node-a", metrics or {}, fields or {},
            collectors or {}, alerts or [], step=step,
        )

    def test_history_is_immutable_and_each_capture_replaces_full_state(self):
        fields = {"phase": "training", "queue": {"ready": [1, None, False]}}
        self.capture(fields=fields, metrics={"cpu/percent": 70})
        fields["queue"]["ready"].append("later-mutation")
        self.capture(fields={"phase": None}, step=1)

        history = json.loads(self.buffer.history(after=0))
        first, second = history["snapshots"]
        self.assertEqual(first["state"]["fields"]["queue"]["ready"], [1, None, False])
        self.assertEqual(second["state"]["fields"], {"phase": None})
        self.assertEqual(second["state"]["metrics"], {})
        self.assertEqual(second, json.loads(self.buffer.latest()))
        self.assertEqual([item["sequence"] for item in history["snapshots"]], [0, 1])
        self.assertEqual(second["axes"], {"hostmon_sample": 1})

    def test_only_public_collector_document_and_health_are_captured(self):
        self.capture(
            collectors={
                "cluster": {
                    "last_success_at": 90,
                    "last_failure_at": 80,
                    "failures_total": 2,
                    "plugin_state": {
                        "schema_version": 3, "at": 90,
                        "report": {"workers": [{"phase": "busy", "rank": 0}]},
                        "credential": "private-test-value",
                        "internal_cache": [1, 2],
                    },
                    "options": {"private_option": "do-not-publish"},
                },
            },
            metrics={"monitor/collector/cluster/up": 1},
            alerts=[{
                "title": "Low capacity", "level": "warning", "message": "One worker",
                "channels": ["private-destination"], "event_id": "outbox-private-id",
                "delivery": {"detail": "private-delivery"},
            }],
        )
        payload = self.buffer.latest()
        state = json.loads(payload)["state"]
        collector = state["collectors"]["cluster"]
        self.assertEqual(collector["document"]["workers"][0]["phase"], "busy")
        self.assertEqual(collector["age_seconds"], 10)
        self.assertTrue(collector["up"])
        self.assertFalse(collector["stale"])
        self.assertEqual(collector["document_schema_version"], 3)
        self.assertEqual(
            state["alerts"],
            [{"title": "Low capacity", "level": "warning", "message": "One worker"}],
        )
        for private in (b"credential", b"internal_cache", b"options", b"outbox-private", b"private-destination"):
            self.assertNotIn(private, payload)

    def test_fresh_session_does_not_seed_fake_snapshots(self):
        second = RvxSnapshotBuffer(self.settings, "node-a")
        self.assertNotEqual(second.session_id, self.buffer.session_id)
        self.assertEqual(json.loads(second.history(after=0))["snapshots"], [])
        self.assertEqual(second.descriptor()["schema_version"], 1)
        with self.assertRaisesRegex(MonitorError, "no completed"):
            second.latest()

    def test_retention_and_paging_never_skip_unreturned_snapshots(self):
        self.buffer = RvxSnapshotBuffer(replace(self.settings, capacity=3), "node-a")
        for step in range(5):
            self.capture(fields={"version": step}, step=step)
        page = json.loads(self.buffer.history(after=0, limit=1))
        self.assertEqual(page["oldest_sequence"], 2)
        self.assertEqual(page["dropped_before"], 2)
        self.assertEqual(page["next_sequence"], 3)
        self.assertEqual(page["snapshots"][0]["sequence"], 2)
        page = json.loads(self.buffer.history(after=page["next_sequence"], limit=1))
        self.assertIsNone(page["dropped_before"])
        self.assertEqual(page["snapshots"][0]["sequence"], 3)
        self.assertEqual(page["next_sequence"], 4)
        empty = json.loads(self.buffer.history(after=5))
        self.assertEqual(empty["snapshots"], [])
        self.assertEqual(empty["next_sequence"], 5)

    def test_wire_pages_obey_byte_budget_and_make_progress(self):
        fields = {"large": "a" * (MAX_SNAPSHOT_BYTES - 1000)}
        for step in range(5):
            self.capture(fields=fields, step=step)
        first = self.buffer.history(after=0)
        self.assertLessEqual(len(first), MAX_PAGE_BYTES)
        page = json.loads(first)
        self.assertGreater(len(page["snapshots"]), 0)
        self.assertLess(len(page["snapshots"]), 5)
        second = json.loads(self.buffer.history(after=page["next_sequence"]))
        sequences = [item["sequence"] for item in page["snapshots"] + second["snapshots"]]
        self.assertEqual(sequences, list(range(5)))

    def test_byte_retention_reports_eviction(self):
        self.capture(fields={"value": "x" * 1000})
        one = len(self.buffer.latest())
        self.buffer = RvxSnapshotBuffer(
            replace(self.settings, max_buffer_bytes=one + 50), "node-a",
        )
        self.capture(fields={"value": "x" * 1000})
        self.capture(fields={"value": "x" * 1000}, step=1)
        page = json.loads(self.buffer.history(after=0))
        self.assertEqual(page["oldest_sequence"], 1)
        self.assertEqual(page["dropped_before"], 1)
        self.assertEqual(len(page["snapshots"]), 1)

    def test_invalid_snapshots_surface_until_a_successful_capture(self):
        nested = {}
        for _ in range(65):
            nested = {"child": nested}
        cyclic = {}
        cyclic["self"] = cyclic
        for invalid in (
            {"value": float("nan")}, {"value": float("inf")},
            {"value": 2**64}, {"value": -(2**63) - 1},
            {"value": object()}, {1: "non-string-key"},
            {"value": (1, 2)}, {"value": "\ud800"},
            {"value": "x" * MAX_SNAPSHOT_BYTES}, {"value": [None] * 100_001},
            nested, cyclic,
        ):
            with self.subTest(value_type=type(invalid).__name__):
                self.buffer = RvxSnapshotBuffer(self.settings, "node-a")
                with self.assertRaises(MonitorError):
                    self.capture(fields=invalid)
                with self.assertRaises(MonitorError):
                    self.buffer.latest()
                with self.assertRaises(MonitorError):
                    self.buffer.history(after=0)
                self.assertEqual(self.capture(fields={"recovered": True}), 0)
                self.assertEqual(json.loads(self.buffer.latest())["state"]["fields"], {"recovered": True})

    def test_invalid_cursor_arguments_are_not_coerced(self):
        for arguments in (
            {"after": -1}, {"after": True}, {"after": 1.5},
            {"after": 1}, {"after": 2**63}, {"after": 0, "limit": 0},
            {"after": 0, "limit": 257}, {"after": 0, "limit": False},
        ):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                self.buffer.history(**arguments)

    def test_concurrent_captures_assign_a_contiguous_history(self):
        with ThreadPoolExecutor(max_workers=4) as executor:
            sequences = list(executor.map(lambda step: self.capture(step=step), range(64)))
        self.assertEqual(sorted(sequences), list(range(64)))
        page = json.loads(self.buffer.history(after=0))
        self.assertEqual([item["sequence"] for item in page["snapshots"]], list(range(64)))
        self.assertEqual(page["next_sequence"], 64)

    def test_invalid_buffer_capacities_are_rejected(self):
        for limits in (
            {"capacity": 0}, {"capacity": True}, {"max_buffer_bytes": 0},
            {"max_buffer_bytes": 1024**3 + 1},
        ):
            with self.subTest(limits=limits), self.assertRaises(MonitorError):
                RvxSnapshotBuffer(replace(self.settings, **limits), "node-a")

    def test_concurrently_mutated_plugin_state_surfaces_as_capture_failure(self):
        with patch(
            "host_monitor.rvx_snapshots._validate_json",
            side_effect=RuntimeError("dictionary changed size during iteration"),
        ):
            with self.assertRaisesRegex(MonitorError, "state changed"):
                self.capture()
        with self.assertRaises(MonitorError):
            self.buffer.latest()
        self.assertEqual(self.capture(), 0)
