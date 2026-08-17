from __future__ import annotations

from pathlib import Path
from typing import Any

from ..errors import CollectorError
from .base import CollectorResult, reject_unknown_options


def parse_meminfo(text: str) -> dict[str, int]:
    values: dict[str, int] = {}
    for line in text.splitlines():
        name, separator, raw = line.partition(":")
        if not separator:
            continue
        fields = raw.split()
        if not fields:
            continue
        try:
            number = int(fields[0])
        except ValueError as error:
            raise CollectorError(f"invalid /proc/meminfo value for {name}") from error
        multiplier = 1024 if len(fields) > 1 and fields[1] == "kB" else 1
        values[name] = number * multiplier
    return values


class MemoryCollector:
    name = "memory"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(self.name, options, {"proc_root"})
        self.path = Path(str(options.get("proc_root", "/proc"))) / "meminfo"

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult:
        try:
            values = parse_meminfo(self.path.read_text(encoding="utf-8"))
        except OSError as error:
            raise CollectorError(f"cannot read {self.path}: {error}") from error
        try:
            total = values["MemTotal"]
            available = values["MemAvailable"]
        except KeyError as error:
            raise CollectorError(f"{self.path} is missing {error.args[0]}") from error
        if total <= 0 or not 0 <= available <= total:
            raise CollectorError(f"{self.path} contains invalid memory totals")
        used = total - available
        metrics = {
            "memory/total_bytes": float(total),
            "memory/available_bytes": float(available),
            "memory/used_bytes": float(used),
            "memory/percent": used * 100.0 / total,
            "memory/cached_bytes": float(values.get("Cached", 0)),
            "memory/buffers_bytes": float(values.get("Buffers", 0)),
        }
        swap_total = values.get("SwapTotal", 0)
        swap_free = values.get("SwapFree", 0)
        metrics["memory/swap_total_bytes"] = float(swap_total)
        metrics["memory/swap_used_bytes"] = float(max(0, swap_total - swap_free))
        if swap_total > 0:
            metrics["memory/swap_percent"] = (
                (swap_total - swap_free) * 100.0 / swap_total
            )
        return CollectorResult(metrics=metrics, state={"at": now})
