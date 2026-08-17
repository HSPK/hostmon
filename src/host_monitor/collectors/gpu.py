from __future__ import annotations

import shlex
import subprocess
from typing import Any

from ..errors import CollectorError
from .base import CollectorResult, reject_unknown_options


QUERY_FIELDS = (
    "index",
    "utilization.gpu",
    "memory.total",
    "memory.used",
    "temperature.gpu",
    "power.draw",
)


def parse_gpu_rows(text: str) -> list[dict[str, float]]:
    rows: list[dict[str, float]] = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        values = [item.strip() for item in line.split(",")]
        if len(values) != len(QUERY_FIELDS):
            raise CollectorError(
                f"nvidia-smi returned {len(values)} columns on line {line_number}"
            )
        try:
            index = int(values[0])
        except ValueError as error:
            raise CollectorError("nvidia-smi returned an invalid GPU index") from error
        parsed: dict[str, float] = {"index": float(index)}
        for name, raw in zip(QUERY_FIELDS[1:], values[1:], strict=True):
            if raw.upper() in {"N/A", "NA", "[N/A]"}:
                continue
            try:
                parsed[name] = float(raw)
            except ValueError as error:
                raise CollectorError(
                    f"nvidia-smi returned an invalid {name} value: {raw!r}"
                ) from error
        rows.append(parsed)
    return rows


class GPUCollector:
    name = "gpu"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(
            self.name,
            options,
            {"command", "timeout_seconds", "optional"},
        )
        command = options.get("command", "nvidia-smi")
        if not isinstance(command, str) or not command.strip():
            raise ValueError("command must be a non-empty string")
        self.command = shlex.split(command)
        self.timeout = float(options.get("timeout_seconds", 5))
        if self.timeout <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.optional = options.get("optional", True)
        if not isinstance(self.optional, bool):
            raise ValueError("optional must be true or false")

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult:
        command = [
            *self.command,
            f"--query-gpu={','.join(QUERY_FIELDS)}",
            "--format=csv,noheader,nounits",
        ]
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                timeout=self.timeout,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as error:
            if self.optional:
                return CollectorResult(
                    state={"at": now},
                    warnings=[f"GPU collector unavailable: {error}"],
                )
            raise CollectorError(f"cannot run {self.command[0]}: {error}") from error
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            if self.optional:
                return CollectorResult(
                    state={"at": now},
                    warnings=[f"GPU collector unavailable: {detail}"],
                )
            raise CollectorError(f"nvidia-smi failed: {detail}")
        rows = parse_gpu_rows(result.stdout)
        if not rows:
            if self.optional:
                return CollectorResult(
                    state={"at": now},
                    warnings=["GPU collector found no devices"],
                )
            raise CollectorError("nvidia-smi found no devices")

        metrics: dict[str, float] = {"gpu/count": float(len(rows))}
        utilization: list[float] = []
        memory_percent: list[float] = []
        temperatures: list[float] = []
        total_power = 0.0
        for row in rows:
            index = int(row["index"])
            prefix = f"gpu/{index}"
            if "utilization.gpu" in row:
                value = row["utilization.gpu"]
                metrics[f"{prefix}/percent"] = value
                utilization.append(value)
            total = row.get("memory.total")
            used = row.get("memory.used")
            if total is not None:
                metrics[f"{prefix}/memory_total_bytes"] = total * 1024**2
            if used is not None:
                metrics[f"{prefix}/memory_used_bytes"] = used * 1024**2
            if total and used is not None:
                value = used * 100.0 / total
                metrics[f"{prefix}/memory_percent"] = value
                memory_percent.append(value)
            if "temperature.gpu" in row:
                value = row["temperature.gpu"]
                metrics[f"{prefix}/temperature_c"] = value
                temperatures.append(value)
            if "power.draw" in row:
                value = row["power.draw"]
                metrics[f"{prefix}/power_watts"] = value
                total_power += value
        if utilization:
            metrics["gpu/percent"] = max(utilization)
        if memory_percent:
            metrics["gpu/memory_percent"] = max(memory_percent)
        if temperatures:
            metrics["gpu/temperature_c"] = max(temperatures)
        metrics["gpu/power_watts"] = total_power
        return CollectorResult(metrics=metrics, state={"at": now})
