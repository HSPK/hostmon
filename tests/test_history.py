from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from host_monitor.config import HistorySettings
from host_monitor.history import HistoryReader, HistoryWriter


class HistoryTests(unittest.TestCase):
    def test_rotates_by_utc_date_and_file_size(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = HistorySettings(
                enabled=True,
                directory=Path(directory),
                max_file_bytes=1,
            )
            writer = HistoryWriter(settings)
            first = writer.append(
                timestamp=1_786_896_000,
                host="host-a",
                metrics={"cpu/percent": 1},
            )
            second = writer.append(
                timestamp=1_786_896_001,
                host="host-a",
                metrics={"cpu/percent": 2},
            )
            next_day = writer.append(
                timestamp=1_786_982_400,
                host="host-a",
                metrics={"cpu/percent": 3},
            )
            files = HistoryReader(settings).list_files()

        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertIsNotNone(next_day)
        self.assertNotEqual(first, second)
        self.assertNotEqual(second, next_day)
        self.assertEqual(len(files), 3)
        self.assertEqual(files[0]["part"], 1)
        self.assertEqual(files[1]["part"], 2)

    def test_reads_tail_across_rotated_files(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = HistorySettings(
                enabled=True,
                directory=Path(directory),
                max_file_bytes=1,
            )
            writer = HistoryWriter(settings)
            for index in range(3):
                writer.append(
                    timestamp=1_786_896_000 + index,
                    host="host-a",
                    metrics={"value": index},
                )

            rows = HistoryReader(settings).tail(2)

        self.assertEqual([row["metrics"]["value"] for row in rows], [1, 2])


if __name__ == "__main__":
    unittest.main()
