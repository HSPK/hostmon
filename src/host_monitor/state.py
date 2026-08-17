from __future__ import annotations

import fcntl
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .errors import MonitorError


STATE_VERSION = 1


def empty_state() -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "samples": [],
        "rules": {},
        "collectors": {},
    }


class StateStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, Any]:
        if not self.path.exists():
            return empty_state()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise MonitorError(f"cannot read state {self.path}: {error}") from error
        if not isinstance(payload, dict):
            raise MonitorError(f"state is not a JSON object: {self.path}")
        if payload.get("version") != STATE_VERSION:
            return empty_state()
        state = empty_state()
        state.update(payload)
        for key, default_type in (
            ("samples", list),
            ("rules", dict),
            ("collectors", dict),
        ):
            if not isinstance(state.get(key), default_type):
                raise MonitorError(f"invalid {key} in state {self.path}")
        return state

    def save(self, state: dict[str, Any]) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                delete=False,
                dir=self.path.parent,
                encoding="utf-8",
            ) as handle:
                temporary = Path(handle.name)
                os.chmod(temporary, 0o600)
                json.dump(
                    state,
                    handle,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                )
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        except OSError as error:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            raise MonitorError(f"cannot write state {self.path}: {error}") from error

    @contextmanager
    def process_lock(self) -> Iterator[None]:
        lock_path = self.path.with_suffix(f"{self.path.suffix}.lock")
        lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            with lock_path.open("a+", encoding="utf-8") as handle:
                os.chmod(lock_path, 0o600)
                try:
                    fcntl.flock(
                        handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB
                    )
                except BlockingIOError as error:
                    raise MonitorError("another hostmon process is running") from error
                yield
        except OSError as error:
            raise MonitorError(f"cannot lock state {lock_path}: {error}") from error
