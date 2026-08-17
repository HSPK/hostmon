from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from host_monitor.errors import CollectorError
from hostmon_thermal import ThermalCollector


class ThermalCollectorTests(unittest.TestCase):
    def test_reads_scaled_temperature(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "temp"
            path.write_text("72500\n", encoding="utf-8")
            collector = ThermalCollector(
                {
                    "path": str(path),
                    "metric": "thermal/package_celsius",
                    "scale": 1000,
                }
            )

            result = collector.collect(None, 100)

        self.assertEqual(result.metrics["thermal/package_celsius"], 72.5)
        self.assertEqual(result.state["raw"], "72500")

    def test_optional_missing_sensor_returns_warning(self):
        collector = ThermalCollector(
            {"path": "/does/not/exist", "optional": True}
        )

        result = collector.collect(None, 100)

        self.assertEqual(result.metrics, {})
        self.assertEqual(len(result.warnings), 1)

    def test_required_missing_sensor_raises(self):
        collector = ThermalCollector(
            {"path": "/does/not/exist", "optional": False}
        )

        with self.assertRaises(CollectorError):
            collector.collect(None, 100)


if __name__ == "__main__":
    unittest.main()
