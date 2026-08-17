from __future__ import annotations

import re
import shutil
from pathlib import Path
from typing import Any

from ..errors import CollectorError
from .base import CollectorResult, reject_unknown_options


def path_label(path: Path) -> str:
    if str(path) == "/":
        return "root"
    label = re.sub(r"[^A-Za-z0-9_]+", "_", str(path).strip("/"))
    return label.strip("_") or "root"


class DiskCollector:
    name = "disk"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(self.name, options, {"paths"})
        raw_paths = options.get("paths", ["/"])
        if not isinstance(raw_paths, list) or not raw_paths:
            raise ValueError("paths must be a non-empty array")
        self.paths = [Path(str(path)).expanduser() for path in raw_paths]
        labels = [path_label(path) for path in self.paths]
        if len(set(labels)) != len(labels):
            raise ValueError("disk paths produce duplicate metric labels")

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult:
        metrics: dict[str, float] = {}
        percents: list[float] = []
        for path in self.paths:
            try:
                usage = shutil.disk_usage(path)
            except OSError as error:
                raise CollectorError(f"cannot read disk usage for {path}: {error}") from error
            if usage.total <= 0:
                raise CollectorError(f"disk {path} reports non-positive capacity")
            percent = usage.used * 100.0 / usage.total
            label = path_label(path)
            metrics.update(
                {
                    f"disk/{label}/total_bytes": float(usage.total),
                    f"disk/{label}/used_bytes": float(usage.used),
                    f"disk/{label}/free_bytes": float(usage.free),
                    f"disk/{label}/percent": percent,
                }
            )
            percents.append(percent)
        metrics["disk/percent"] = max(percents)
        return CollectorResult(metrics=metrics, state={"at": now})
