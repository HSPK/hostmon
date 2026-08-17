from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Any

from ..errors import CollectorError
from .base import CollectorResult, reject_unknown_options


def parse_net_dev(text: str) -> dict[str, dict[str, int]]:
    interfaces: dict[str, dict[str, int]] = {}
    for line in text.splitlines()[2:]:
        name, separator, raw_values = line.partition(":")
        if not separator:
            continue
        fields = raw_values.split()
        if len(fields) < 16:
            raise CollectorError("/proc/net/dev contains an incomplete interface row")
        try:
            values = [int(value) for value in fields[:16]]
        except ValueError as error:
            raise CollectorError("/proc/net/dev contains invalid counters") from error
        interfaces[name.strip()] = {
            "rx_bytes": values[0],
            "rx_errors": values[2],
            "rx_dropped": values[3],
            "tx_bytes": values[8],
            "tx_errors": values[10],
            "tx_dropped": values[11],
        }
    return interfaces


class NetworkCollector:
    name = "network"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(
            self.name, options, {"proc_root", "include", "exclude"}
        )
        self.path = Path(str(options.get("proc_root", "/proc"))) / "net" / "dev"
        self.include = self._patterns(options.get("include", ["*"]), "include")
        self.exclude = self._patterns(options.get("exclude", ["lo"]), "exclude")

    @staticmethod
    def _patterns(value: Any, name: str) -> list[str]:
        if not isinstance(value, list) or not all(
            isinstance(item, str) and item for item in value
        ):
            raise ValueError(f"{name} must be an array of non-empty strings")
        return list(value)

    def _selected(self, interface: str) -> bool:
        return any(fnmatch.fnmatch(interface, item) for item in self.include) and not any(
            fnmatch.fnmatch(interface, item) for item in self.exclude
        )

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult:
        try:
            all_interfaces = parse_net_dev(self.path.read_text(encoding="utf-8"))
        except OSError as error:
            raise CollectorError(f"cannot read {self.path}: {error}") from error
        current = {
            name: counters
            for name, counters in all_interfaces.items()
            if self._selected(name)
        }
        if not current:
            raise CollectorError("network filters matched no interfaces")

        metrics = {
            "network/interface_count": float(len(current)),
            "network/rx_errors_total": float(
                sum(item["rx_errors"] for item in current.values())
            ),
            "network/tx_errors_total": float(
                sum(item["tx_errors"] for item in current.values())
            ),
            "network/rx_dropped_total": float(
                sum(item["rx_dropped"] for item in current.values())
            ),
            "network/tx_dropped_total": float(
                sum(item["tx_dropped"] for item in current.values())
            ),
        }
        if isinstance(previous, dict):
            prior_at = previous.get("at")
            prior_interfaces = previous.get("interfaces")
            if isinstance(prior_at, (int, float)) and isinstance(
                prior_interfaces, dict
            ):
                elapsed = now - float(prior_at)
                if elapsed > 0:
                    rx_delta = tx_delta = 0
                    matched = 0
                    for name, counters in current.items():
                        prior = prior_interfaces.get(name)
                        if not isinstance(prior, dict):
                            continue
                        rx = counters["rx_bytes"] - int(prior.get("rx_bytes", 0))
                        tx = counters["tx_bytes"] - int(prior.get("tx_bytes", 0))
                        if rx < 0 or tx < 0:
                            continue
                        rx_delta += rx
                        tx_delta += tx
                        matched += 1
                        metrics[f"network/{name}/rx_mbps"] = (
                            rx * 8.0 / elapsed / 1_000_000
                        )
                        metrics[f"network/{name}/tx_mbps"] = (
                            tx * 8.0 / elapsed / 1_000_000
                        )
                    if matched:
                        metrics["network/rx_mbps"] = (
                            rx_delta * 8.0 / elapsed / 1_000_000
                        )
                        metrics["network/tx_mbps"] = (
                            tx_delta * 8.0 / elapsed / 1_000_000
                        )
        return CollectorResult(
            metrics=metrics,
            state={"at": now, "interfaces": current},
        )
