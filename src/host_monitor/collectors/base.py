from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class CollectorResult:
    metrics: dict[str, float] = field(default_factory=dict)
    fields: dict[str, Any] = field(default_factory=dict)
    state: dict[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    refreshed: bool = True


@dataclass
class Collection:
    metrics: dict[str, float]
    fields: dict[str, Any]
    states: dict[str, Any]
    warnings: list[str]


class Collector(Protocol):
    name: str

    def __init__(self, options: dict[str, Any]): ...

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult: ...


def reject_unknown_options(
    collector: str, options: dict[str, Any], known: set[str]
) -> None:
    unknown = set(options) - known
    if unknown:
        raise ValueError(
            f"unknown {collector} collector options: {sorted(unknown)}"
        )
