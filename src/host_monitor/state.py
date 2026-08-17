from __future__ import annotations

import fcntl
import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .errors import MonitorError


STATE_VERSION = 2


def empty_state() -> dict[str, Any]:
    return {
        "version": STATE_VERSION,
        "samples": [],
        "rules": {},
        "collectors": {},
        "updated_at": None,
    }


def migrate_state(payload: dict[str, Any]) -> tuple[dict[str, Any], int | None]:
    raw_version = payload.get("version", 1)
    if not isinstance(raw_version, int):
        raise MonitorError(f"state version must be an integer, got {raw_version!r}")
    if raw_version > STATE_VERSION:
        raise MonitorError(
            f"state version {raw_version} is newer than supported "
            f"version {STATE_VERSION}"
        )
    if raw_version < 1:
        raise MonitorError(f"unsupported state version: {raw_version}")
    state = dict(payload)
    original_version = raw_version
    if raw_version == 1:
        state.setdefault("updated_at", None)
        state["version"] = 2
        state["migrated_at"] = time.time()
        raw_version = 2
    if raw_version != STATE_VERSION:
        raise MonitorError(
            f"no migration path from state version {original_version} "
            f"to {STATE_VERSION}"
        )
    defaults = empty_state()
    defaults.update(state)
    return defaults, (
        original_version if original_version != STATE_VERSION else None
    )


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
        state, migrated_from = migrate_state(payload)
        if migrated_from is not None:
            self._backup(payload, migrated_from)
        for key, default_type in (
            ("samples", list),
            ("rules", dict),
            ("collectors", dict),
        ):
            if not isinstance(state.get(key), default_type):
                raise MonitorError(f"invalid {key} in state {self.path}")
        return state

    def _backup(self, state: dict[str, Any], version: int) -> None:
        backup = self.path.with_name(f"{self.path.name}.v{version}.bak")
        self._atomic_save(backup, state)

    def save(self, state: dict[str, Any]) -> None:
        state = dict(state)
        state["version"] = STATE_VERSION
        self._atomic_save(self.path, state)

    @staticmethod
    def _atomic_save(path: Path, state: dict[str, Any]) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w",
                delete=False,
                dir=path.parent,
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
            os.replace(temporary, path)
        except OSError as error:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
            raise MonitorError(f"cannot write state {path}: {error}") from error

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
