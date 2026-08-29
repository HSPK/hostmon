from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from ..errors import CollectorError
from .base import CollectorResult, reject_unknown_options
from .kubectl_client import KubectlClient


NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
VERB_RE = re.compile(r"^[a-z][a-z-]*$")


@dataclass(frozen=True)
class PermissionCheck:
    name: str
    context: str
    namespace: str
    resource: str
    verbs: tuple[str, ...]


def parse_checks(value: Any) -> tuple[PermissionCheck, ...]:
    if not isinstance(value, list) or not value:
        raise ValueError("checks must be a non-empty array of tables")
    checks: list[PermissionCheck] = []
    names: set[str] = set()
    for index, raw in enumerate(value, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"check #{index} must be a table")
        unknown = set(raw) - {
            "name",
            "context",
            "namespace",
            "resource",
            "verbs",
        }
        if unknown:
            raise ValueError(
                f"unknown options in permission check #{index}: {sorted(unknown)}"
            )
        name = str(raw.get("name", "")).strip()
        if not NAME_RE.fullmatch(name):
            raise ValueError(
                f"check #{index} name must match {NAME_RE.pattern!r}"
            )
        if name in names:
            raise ValueError(f"duplicate permission check name: {name}")
        names.add(name)
        resource = str(raw.get("resource", "")).strip()
        if not resource:
            raise ValueError(f"check #{index} resource is required")
        raw_verbs = raw.get("verbs")
        if not isinstance(raw_verbs, list) or not raw_verbs:
            raise ValueError(f"check #{index} verbs must be a non-empty array")
        verbs = tuple(str(verb).strip().lower() for verb in raw_verbs)
        if not all(VERB_RE.fullmatch(verb) for verb in verbs):
            raise ValueError(f"check #{index} contains an invalid verb")
        if len(set(verbs)) != len(verbs):
            raise ValueError(f"check #{index} contains duplicate verbs")
        checks.append(
            PermissionCheck(
                name=name,
                context=str(raw.get("context", "")).strip(),
                namespace=str(raw.get("namespace", "")).strip(),
                resource=resource,
                verbs=verbs,
            )
        )
    return tuple(checks)


class KubernetesPermissionCollector:
    name = "kubernetes_permissions"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(
            self.name,
            options,
            {
                "checks",
                "poll_interval_seconds",
                "kubectl",
                "timeout_seconds",
            },
        )
        self.checks = parse_checks(options.get("checks"))
        self.poll_interval = float(options.get("poll_interval_seconds", 60))
        if self.poll_interval <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        self.timeout = float(options.get("timeout_seconds", 15))
        if self.timeout <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.client = KubectlClient(
            str(options.get("kubectl", "kubectl")),
            timeout_seconds=self.timeout,
        )

    def _allowed(self, check: PermissionCheck, verb: str) -> bool:
        return self.client.can_i(
            verb,
            check.resource,
            context=check.context,
            namespace=check.namespace,
        )

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult:
        if isinstance(previous, dict):
            at = previous.get("at")
            metrics = previous.get("metrics")
            fields = previous.get("fields")
            if (
                isinstance(at, (int, float))
                and now - float(at) < self.poll_interval
                and isinstance(metrics, dict)
                and isinstance(fields, dict)
            ):
                return CollectorResult(
                    metrics={str(key): float(value) for key, value in metrics.items()},
                    fields=dict(fields),
                    state=previous,
                    refreshed=False,
                )

        metrics: dict[str, float] = {}
        fields: dict[str, Any] = {}
        for check in self.checks:
            results = {
                verb: self._allowed(check, verb) for verb in check.verbs
            }
            prefix = f"permission/{check.name}"
            for verb, allowed in results.items():
                metrics[f"{prefix}/{verb}"] = float(allowed)
            metrics[f"{prefix}/allowed"] = float(all(results.values()))
            granted = [verb for verb, allowed in results.items() if allowed]
            missing = [verb for verb, allowed in results.items() if not allowed]
            field_prefix = f"permission_{check.name}"
            fields.update(
                {
                    f"{field_prefix}_context": check.context or "current",
                    f"{field_prefix}_namespace": check.namespace or "(cluster)",
                    f"{field_prefix}_resource": check.resource,
                    f"{field_prefix}_granted_verbs": ", ".join(granted) or "(none)",
                    f"{field_prefix}_missing_verbs": ", ".join(missing) or "(none)",
                }
            )
        state = {"at": now, "metrics": metrics, "fields": fields}
        return CollectorResult(metrics=metrics, fields=fields, state=state)
