from __future__ import annotations

import fcntl
import json
import os
import re
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import HistorySettings
from .errors import MonitorError
from .state import StateStore


FILE_RE = re.compile(r"^metrics-(\d{4}-\d{2}-\d{2})-(\d{4})\.jsonl$")


class HistoryWriter:
    def __init__(self, settings: HistorySettings):
        self.settings = settings

    def _files_for_date(self, date: str) -> list[Path]:
        files = []
        for path in self.settings.directory.glob(f"metrics-{date}-*.jsonl"):
            match = FILE_RE.match(path.name)
            if match and match.group(1) == date:
                files.append(path)
        return sorted(files)

    def _target(self, date: str, line_size: int) -> Path:
        files = self._files_for_date(date)
        if not files:
            return self.settings.directory / f"metrics-{date}-0001.jsonl"
        latest = files[-1]
        try:
            size = latest.stat().st_size
        except OSError as error:
            raise MonitorError(f"cannot stat history file {latest}: {error}") from error
        if size == 0 or size + line_size <= self.settings.max_file_bytes:
            return latest
        match = FILE_RE.match(latest.name)
        if match is None:
            raise MonitorError(f"invalid history file name: {latest}")
        index = int(match.group(2)) + 1
        return self.settings.directory / f"metrics-{date}-{index:04d}.jsonl"

    def append(
        self,
        *,
        timestamp: float,
        host: str,
        metrics: dict[str, float],
        fields: dict[str, Any] | None = None,
        alerts: list[dict[str, str]] | None = None,
        source: str = "daemon",
    ) -> Path | None:
        if not self.settings.enabled:
            return None
        record: dict[str, Any] = {
            "_time": timestamp,
            "host": host,
            "source": source,
            "metrics": metrics,
        }
        if fields:
            record["fields"] = fields
        if alerts:
            record["alerts"] = alerts
        encoded = (
            json.dumps(
                record,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n"
        ).encode("utf-8")
        date = datetime.fromtimestamp(timestamp, timezone.utc).date().isoformat()
        directory = self.settings.directory
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_path = directory / ".history.lock"
        try:
            with lock_path.open("a+", encoding="utf-8") as lock:
                os.chmod(lock_path, 0o600)
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                target = self._target(date, len(encoded))
                with target.open("ab") as handle:
                    os.chmod(target, 0o600)
                    handle.write(encoded)
                    handle.flush()
                return target
        except OSError as error:
            raise MonitorError(f"cannot append history in {directory}: {error}") from error


class HistoryReader:
    def __init__(self, settings: HistorySettings):
        self.settings = settings

    def list_files(self) -> list[dict[str, Any]]:
        if not self.settings.directory.exists():
            return []
        entries: list[dict[str, Any]] = []
        for path in sorted(self.settings.directory.glob("metrics-*.jsonl")):
            match = FILE_RE.match(path.name)
            if match is None:
                continue
            try:
                stat = path.stat()
            except OSError as error:
                raise MonitorError(f"cannot stat history file {path}: {error}") from error
            entries.append(
                {
                    "path": str(path),
                    "date": match.group(1),
                    "part": int(match.group(2)),
                    "bytes": stat.st_size,
                }
            )
        return entries

    def tail(self, count: int, date: str | None = None) -> list[dict[str, Any]]:
        if count < 1:
            raise MonitorError("history tail count must be positive")
        files = self.list_files()
        if date is not None:
            files = [item for item in files if item["date"] == date]
        rows: list[dict[str, Any]] = []
        for item in reversed(files):
            path = Path(item["path"])
            recent: deque[dict[str, Any]] = deque(maxlen=count - len(rows))
            try:
                with path.open("r", encoding="utf-8") as handle:
                    for line_number, line in enumerate(handle, start=1):
                        if not line.strip():
                            continue
                        try:
                            row = json.loads(line)
                        except json.JSONDecodeError as error:
                            raise MonitorError(
                                f"invalid history JSON at {path}:{line_number}"
                            ) from error
                        if not isinstance(row, dict):
                            raise MonitorError(
                                f"invalid history row at {path}:{line_number}"
                            )
                        recent.append(row)
            except OSError as error:
                raise MonitorError(f"cannot read history file {path}: {error}") from error
            rows = list(recent) + rows
            if len(rows) >= count:
                break
        return rows[-count:]


def migrate_rolling_state(
    history: HistoryWriter,
    state_store: StateStore,
) -> int:
    state = state_store.load()
    if state.get("history_migrated_at"):
        return 0
    samples = state.get("samples", [])
    if not isinstance(samples, list):
        raise MonitorError("state samples must be a list")
    host = str(state.get("host") or "localhost")
    migrated = 0
    for sample in samples:
        if not isinstance(sample, dict):
            continue
        timestamp = sample.get("_time")
        if not isinstance(timestamp, (int, float)):
            continue
        metrics = {
            key: float(value)
            for key, value in sample.items()
            if not key.startswith("_") and isinstance(value, (int, float))
        }
        history.append(
            timestamp=float(timestamp),
            host=host,
            metrics=metrics,
            source="rolling-state-migration",
        )
        migrated += 1
    state["history_migrated_at"] = datetime.now(timezone.utc).timestamp()
    state_store.save(state)
    return migrated
