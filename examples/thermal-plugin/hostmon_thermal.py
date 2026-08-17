from __future__ import annotations

from pathlib import Path
from typing import Any

from host_monitor.collectors.base import CollectorResult, reject_unknown_options
from host_monitor.errors import CollectorError


class ThermalCollector:
    name = "thermal"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(
            self.name,
            options,
            {"path", "metric", "scale", "optional"},
        )
        self.path = Path(
            str(options.get("path", "/sys/class/thermal/thermal_zone0/temp"))
        ).expanduser()
        self.metric = str(options.get("metric", "thermal/cpu_celsius")).strip()
        if not self.metric:
            raise ValueError("metric must be a non-empty string")
        self.scale = float(options.get("scale", 1000))
        if self.scale <= 0:
            raise ValueError("scale must be positive")
        self.optional = options.get("optional", True)
        if not isinstance(self.optional, bool):
            raise ValueError("optional must be true or false")

    def collect(
        self,
        previous: dict[str, Any] | None,
        now: float,
    ) -> CollectorResult:
        try:
            raw = self.path.read_text(encoding="utf-8").strip()
        except FileNotFoundError as error:
            if self.optional:
                return CollectorResult(
                    state={"at": now},
                    warnings=[f"thermal sensor is not available: {self.path}"],
                )
            raise CollectorError(
                f"thermal sensor is not available: {self.path}"
            ) from error
        except OSError as error:
            raise CollectorError(f"cannot read thermal sensor {self.path}: {error}") from error
        try:
            value = float(raw) / self.scale
        except ValueError as error:
            raise CollectorError(
                f"thermal sensor {self.path} returned an invalid value"
            ) from error
        return CollectorResult(
            metrics={self.metric: value},
            fields={"thermal_sensor_path": str(self.path)},
            state={"at": now, "raw": raw},
        )
