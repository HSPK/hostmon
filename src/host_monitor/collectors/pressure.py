from __future__ import annotations

from pathlib import Path
from typing import Any

from ..errors import CollectorError
from .base import CollectorResult, reject_unknown_options


def parse_pressure(text: str) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        category = fields[0]
        for field in fields[1:]:
            name, separator, value = field.partition("=")
            if not separator:
                continue
            try:
                metrics[f"{category}_{name}"] = float(value)
            except ValueError as error:
                raise CollectorError(
                    f"invalid pressure value {field!r}"
                ) from error
    return metrics


class PressureCollector:
    name = "pressure"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(self.name, options, {"proc_root", "optional"})
        self.root = Path(str(options.get("proc_root", "/proc"))) / "pressure"
        self.optional = options.get("optional", True)
        if not isinstance(self.optional, bool):
            raise ValueError("optional must be true or false")

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult:
        metrics: dict[str, float] = {}
        warnings: list[str] = []
        for resource in ("cpu", "memory", "io"):
            path = self.root / resource
            try:
                values = parse_pressure(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                if self.optional:
                    warnings.append(f"pressure metrics unavailable: {path}")
                    continue
                raise CollectorError(f"pressure metrics unavailable: {path}")
            except OSError as error:
                raise CollectorError(f"cannot read {path}: {error}") from error
            for name, value in values.items():
                metrics[f"pressure/{resource}/{name}"] = value
        return CollectorResult(
            metrics=metrics,
            state={"at": now},
            warnings=warnings,
        )
