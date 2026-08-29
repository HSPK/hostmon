from __future__ import annotations

import json
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
        "navigationSections": [
            {
                "id": "charts",
                "label": "Charts",
                "placement": "main",
                "pages": ["overview"],
            },
            {
                "id": "tables",
                "label": "Tables",
                "placement": "main",
                "pages": ["metrics"],
            },
        ],
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

    def test_normalizes_legacy_chart_dimensions(self):
        preferences = sample_preferences()
        preferences["customPanels"][0]["height"] = 0
        preferences["customPanels"][0]["lineWidth"] = 0

        normalized = validate_dashboard_preferences(preferences)

        self.assertEqual(normalized["customPanels"][0]["height"], 270)
        self.assertEqual(normalized["customPanels"][0]["lineWidth"], 1.5)

    def test_migrates_preferences_without_navigation_sections(self):
        preferences = sample_preferences()
        del preferences["navigationSections"]

        normalized = validate_dashboard_preferences(preferences)

        self.assertEqual(normalized["navigationSections"], [])

    def test_store_rewrites_legacy_preferences_with_navigation_sections(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dashboard-preferences.json"
            preferences = sample_preferences()
            del preferences["navigationSections"]
            path.write_text(json.dumps(preferences), encoding="utf-8")

            loaded = DashboardPreferenceStore(path).load()

            self.assertEqual(loaded["navigationSections"], [])
            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8"))[
                    "navigationSections"
                ],
                [],
            )

    def test_rejects_duplicate_navigation_page_assignments(self):
        preferences = sample_preferences()
        preferences["navigationSections"][1]["pages"] = ["overview"]

        with self.assertRaisesRegex(ValueError, "assigned to another section"):
            validate_dashboard_preferences(preferences)

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
