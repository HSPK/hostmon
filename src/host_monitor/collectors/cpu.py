from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ..errors import CollectorError
from .base import CollectorResult, reject_unknown_options


def parse_cpu_line(text: str) -> tuple[int, int]:
    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0] == "cpu":
            try:
                values = [int(value) for value in fields[1:]]
            except ValueError as error:
                raise CollectorError("/proc/stat contains invalid CPU counters") from error
            if len(values) < 5:
                break
            idle = values[3] + values[4]
            total = sum(values[:8])
            return total, idle
    raise CollectorError("/proc/stat does not contain aggregate CPU counters")


class CPUCollector:
    name = "cpu"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(self.name, options, {"proc_root"})
        self.proc_root = Path(str(options.get("proc_root", "/proc")))

    def _read(self, name: str) -> str:
        path = self.proc_root / name
        try:
            return path.read_text(encoding="utf-8")
        except OSError as error:
            raise CollectorError(f"cannot read {path}: {error}") from error

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult:
        total, idle = parse_cpu_line(self._read("stat"))
        metrics: dict[str, float] = {
            "cpu/cores": float(os.cpu_count() or 1),
        }
        try:
            loads = [float(value) for value in self._read("loadavg").split()[:3]]
        except ValueError as error:
            raise CollectorError("/proc/loadavg contains invalid values") from error
        if len(loads) == 3:
            metrics.update(
                {
                    "cpu/load1": loads[0],
                    "cpu/load5": loads[1],
                    "cpu/load15": loads[2],
                }
            )
        try:
            metrics["host/uptime_seconds"] = float(self._read("uptime").split()[0])
        except (IndexError, ValueError) as error:
            raise CollectorError("/proc/uptime contains invalid values") from error

        if isinstance(previous, dict):
            prior_total = previous.get("total")
            prior_idle = previous.get("idle")
            if isinstance(prior_total, int) and isinstance(prior_idle, int):
                total_delta = total - prior_total
                idle_delta = idle - prior_idle
                if total_delta > 0 and 0 <= idle_delta <= total_delta:
                    metrics["cpu/percent"] = (
                        (total_delta - idle_delta) * 100.0 / total_delta
                    )
        return CollectorResult(
            metrics=metrics,
            state={"at": now, "total": total, "idle": idle},
        )
