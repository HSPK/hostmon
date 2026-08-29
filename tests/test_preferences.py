from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from host_monitor.preferences import (
    DashboardPreferenceStore,
    validate_dashboard_preferences,
)


def sample_preferences() -> dict:
    return {
        "hiddenPanels": ["network"],
        "panelOrder": ["overview", "network"],
        "windowSeconds": 3600,
        "activePage": "overview",
        "panelState": {
            "records": {
                "filter": "all",
                "sort": "name",
                "sortDirection": "asc",
            }
        },
        "panelColumns": {"collectors": ["name", "state"]},
        "theme": "dark",
        "density": "compact",
        "customPanels": [
            {
                "id": "custom-latency",
                "type": "timeseries",
                "page": "metrics",
                "title": "Latency",
                "metrics": ["custom/latency_ms"],
                "custom": True,
            }
        ],
    }


class DashboardPreferenceTests(unittest.TestCase):
    def test_store_round_trips_valid_preferences_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dashboard-preferences.json"
            store = DashboardPreferenceStore(path)

            saved = store.save(sample_preferences())
            loaded = store.load()

            self.assertEqual(loaded, saved)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_rejects_unknown_fields_and_invalid_custom_panels(self):
        unknown = {**sample_preferences(), "extra": True}
        with self.assertRaisesRegex(ValueError, "unknown preference fields"):
            validate_dashboard_preferences(unknown)

        invalid = sample_preferences()
        invalid["customPanels"][0]["metrics"] = []
        with self.assertRaisesRegex(ValueError, "must contain 1..8"):
            validate_dashboard_preferences(invalid)

    def test_load_returns_none_before_first_save(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DashboardPreferenceStore(
                Path(directory) / "dashboard-preferences.json"
            )

            self.assertIsNone(store.load())

    def test_patch_merges_changed_fields_and_nested_panel_state(self):
        with tempfile.TemporaryDirectory() as directory:
            store = DashboardPreferenceStore(
                Path(directory) / "dashboard-preferences.json"
            )
            store.save(sample_preferences())

            updated = store.patch(
                {
                    "theme": "light",
                    "panelState": {
                        "records": None,
                        "other": {"filter": "active"},
                    },
                }
            )

            self.assertEqual(updated["theme"], "light")
            self.assertEqual(updated["density"], "compact")
            self.assertEqual(
                updated["panelState"],
                {
                    "other": {"filter": "active"},
                },
            )


if __name__ == "__main__":
    unittest.main()
