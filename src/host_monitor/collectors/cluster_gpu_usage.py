from __future__ import annotations

import json
import re
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Callable

from .base import CollectorResult, reject_unknown_options
from .kubectl_client import KubectlClient, parse_quantity


METRIC_COMPONENT = re.compile(r"[^a-zA-Z0-9_]+")


@dataclass
class SubmitterUsage:
    running_pods: int = 0
    running_gpus: Decimal = Decimal()
    running_nodes: set[str] = field(default_factory=set)
    pending_pods: int = 0
    pending_gpus: Decimal = Decimal()


def _number(value: Decimal) -> int | float:
    return int(value) if value == value.to_integral() else float(value)


def _component(value: str) -> str:
    return METRIC_COMPONENT.sub("_", value).strip("_") or "queue"


def _pod_gpu_request(pod: dict[str, Any], resource: str) -> Decimal:
    total = Decimal()
    for container in (pod.get("spec") or {}).get("containers") or []:
        requests = (container.get("resources") or {}).get("requests") or {}
        if resource in requests:
            total += parse_quantity(requests[resource])
    return total


def _submitter_identity(pod: dict[str, Any]) -> tuple[str, str]:
    labels = (pod.get("metadata") or {}).get("labels") or {}
    return (
        str(
            labels.get("created-by-name")
            or labels.get("owner")
            or "(unlabeled)"
        ),
        str(labels.get("created-by") or "-"),
    )


def _workload_name(pod: dict[str, Any]) -> str:
    metadata = pod.get("metadata") or {}
    labels = metadata.get("labels") or {}
    if labels.get("volcano.sh/job-name"):
        return str(labels["volcano.sh/job-name"])
    for owner in metadata.get("ownerReferences") or []:
        if owner.get("kind") == "Job" and owner.get("controller", True):
            return str(owner.get("name") or metadata.get("name") or "(unknown)")
    return str(metadata.get("name") or "(unknown)")


def _aggregate_by(
    queue_pods: dict[str, list[dict[str, Any]]],
    *,
    gpu_resource: str,
    identity: Callable[[str, dict[str, Any]], tuple[str, ...]],
) -> dict[tuple[str, ...], SubmitterUsage]:
    usage: dict[tuple[str, ...], SubmitterUsage] = defaultdict(SubmitterUsage)
    for queue, pods in queue_pods.items():
        for pod in pods:
            phase = str((pod.get("status") or {}).get("phase") or "")
            if phase not in {"Running", "Pending"}:
                continue
            requested = _pod_gpu_request(pod, gpu_resource)
            if requested <= 0:
                continue
            item = usage[identity(queue, pod)]
            if phase == "Running":
                item.running_pods += 1
                item.running_gpus += requested
                node = (pod.get("spec") or {}).get("nodeName")
                if node:
                    item.running_nodes.add(str(node))
            else:
                item.pending_pods += 1
                item.pending_gpus += requested
    return usage


def aggregate_usage(
    queue_pods: dict[str, list[dict[str, Any]]],
    *,
    gpu_resource: str,
) -> dict[tuple[str, str, str], SubmitterUsage]:
    return _aggregate_by(
        queue_pods,
        gpu_resource=gpu_resource,
        identity=lambda queue, pod: (queue, *_submitter_identity(pod)),
    )


def aggregate_workloads(
    queue_pods: dict[str, list[dict[str, Any]]],
    *,
    gpu_resource: str,
) -> dict[tuple[str, str, str, str], SubmitterUsage]:
    return _aggregate_by(
        queue_pods,
        gpu_resource=gpu_resource,
        identity=lambda queue, pod: (
            queue,
            _workload_name(pod),
            *_submitter_identity(pod),
        ),
    )


def build_report(
    queues: list[str],
    queue_objects: list[dict[str, Any]],
    usage: dict[tuple[str, str, str], SubmitterUsage],
    *,
    gpus_per_node: int,
    gpu_resource: str,
    workloads: dict[tuple[str, str, str, str], SubmitterUsage] | None = None,
) -> dict[str, Any]:
    usage_rows = [
        {
            "queue": queue,
            "submitter": submitter,
            "creator_id": creator_id,
            "running_pods": item.running_pods,
            "running_gpus": _number(item.running_gpus),
            "running_gpu_nodes": len(item.running_nodes),
            "pending_pods": item.pending_pods,
            "pending_gpus": _number(item.pending_gpus),
        }
        for (queue, submitter, creator_id), item in sorted(
            usage.items(),
            key=lambda entry: (
                entry[0][0],
                -entry[1].running_gpus,
                entry[0][1],
            ),
        )
    ]
    objects = {
        str((item.get("metadata") or {}).get("name")): item
        for item in queue_objects
    }
    capacity: list[dict[str, Any]] = []
    for queue in queues:
        item = objects.get(queue)
        if item is None:
            raise ValueError(f"Volcano queue response is missing {queue!r}")
        spec = item.get("spec") or {}
        status = item.get("status") or {}
        capability = spec.get("capability") or {}
        allocated = status.get("allocated") or {}
        capacity_gpus = int(parse_quantity(capability.get(gpu_resource, 0)))
        allocated_gpus = int(parse_quantity(allocated.get(gpu_resource, 0)))
        capacity_cpus = parse_quantity(capability.get("cpu", 0))
        allocated_cpus = parse_quantity(allocated.get("cpu", 0))
        pending_gpus = sum(
            (
                row.pending_gpus
                for (usage_queue, _, _), row in usage.items()
                if usage_queue == queue
            ),
            Decimal(),
        )
        unallocated_gpus = capacity_gpus - allocated_gpus
        no_job_gpus = unallocated_gpus - int(pending_gpus)
        capacity.append(
            {
                "queue": queue,
                "capacity_gpus": capacity_gpus,
                "allocated_gpus": allocated_gpus,
                "pending_gpus": int(pending_gpus),
                "unallocated_gpus": unallocated_gpus,
                "no_job_gpus": no_job_gpus,
                "no_job_node_equivalents": max(no_job_gpus, 0)
                // gpus_per_node,
                "capacity_cpus": _number(capacity_cpus),
                "allocated_cpus": _number(allocated_cpus),
                "free_cpus": _number(capacity_cpus - allocated_cpus),
            }
        )
    total = {
        "queue": "TOTAL",
        **{
            key: sum(float(row[key]) for row in capacity)
            for key in (
                "capacity_gpus",
                "allocated_gpus",
                "pending_gpus",
                "unallocated_gpus",
                "no_job_gpus",
                "no_job_node_equivalents",
                "capacity_cpus",
                "allocated_cpus",
                "free_cpus",
            )
        },
    }
    for key, value in tuple(total.items()):
        if isinstance(value, float) and value.is_integer():
            total[key] = int(value)
    workload_rows = [
        {
            "queue": queue,
            "name": name,
            "submitter": submitter,
            "creator_id": creator_id,
            "status": (
                "Mixed"
                if item.running_pods and item.pending_pods
                else "Running"
                if item.running_pods
                else "Pending"
            ),
            "running_pods": item.running_pods,
            "running_gpus": _number(item.running_gpus),
            "running_gpu_nodes": len(item.running_nodes),
            "pending_pods": item.pending_pods,
            "pending_gpus": _number(item.pending_gpus),
        }
        for (queue, name, submitter, creator_id), item in sorted(
            (workloads or {}).items(),
            key=lambda entry: (
                entry[0][0],
                -entry[1].running_gpus,
                -entry[1].pending_gpus,
                entry[0][1],
            ),
        )
    ]
    return {
        "gpus_per_node": gpus_per_node,
        "usage": usage_rows,
        "workloads": workload_rows,
        "capacity": capacity,
        "total_capacity": total,
    }


def report_metrics(report: dict[str, Any]) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for row in [*report["capacity"], report["total_capacity"]]:
        queue = _component(str(row["queue"]).lower())
        prefix = f"cluster_gpu/queue/{queue}"
        for key in (
            "capacity_gpus",
            "allocated_gpus",
            "pending_gpus",
            "unallocated_gpus",
            "no_job_gpus",
            "no_job_node_equivalents",
            "capacity_cpus",
            "allocated_cpus",
            "free_cpus",
        ):
            metrics[f"{prefix}/{key}"] = float(row[key])
    metrics["cluster_gpu/submitter_count"] = float(len(report["usage"]))
    metrics["cluster_gpu/running_gpus"] = float(
        sum(float(row["running_gpus"]) for row in report["usage"])
    )
    metrics["cluster_gpu/pending_gpus"] = float(
        sum(float(row["pending_gpus"]) for row in report["usage"])
    )
    return metrics


class ClusterGPUUsageCollector:
    name = "cluster_gpu_usage"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(
            self.name,
            options,
            {
                "context",
                "queues",
                "gpu_resource",
                "gpus_per_node",
                "poll_interval_seconds",
                "kubectl",
                "timeout_seconds",
            },
        )
        raw_queues = options.get("queues")
        if not isinstance(raw_queues, list) or not raw_queues:
            raise ValueError("queues must be a non-empty array")
        self.queues = [str(queue).strip() for queue in raw_queues]
        if not all(self.queues) or len(set(self.queues)) != len(self.queues):
            raise ValueError("queues must contain unique non-empty names")
        self.gpu_resource = str(
            options.get("gpu_resource", "nvidia.com/gpu")
        ).strip()
        self.gpus_per_node = int(options.get("gpus_per_node", 8))
        if self.gpus_per_node < 1:
            raise ValueError("gpus_per_node must be positive")
        self.poll_interval = float(options.get("poll_interval_seconds", 60))
        if self.poll_interval <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        self.timeout = float(options.get("timeout_seconds", 30))
        self.client = KubectlClient(
            str(options.get("kubectl", "kubectl")),
            context=str(options.get("context", "")),
            timeout_seconds=self.timeout,
        )

    def _json(self, *arguments: str) -> dict[str, Any]:
        return self.client.json(*arguments)

    def collect(
        self,
        previous: dict[str, Any] | None,
        now: float,
    ) -> CollectorResult:
        if isinstance(previous, dict):
            at = previous.get("at")
            metrics = previous.get("metrics")
            report = previous.get("report")
            if (
                isinstance(at, (int, float))
                and now - float(at) < self.poll_interval
                and isinstance(metrics, dict)
                and isinstance(report, dict)
                and isinstance(report.get("workloads"), list)
            ):
                return CollectorResult(
                    metrics={
                        str(name): float(value)
                        for name, value in metrics.items()
                    },
                    state=previous,
                )
        request_timeout = f"--request-timeout={max(1, int(self.timeout))}s"
        queue_pods = {
            queue: KubectlClient.items(
                self._json(
                    "get",
                    "pods",
                    "--namespace",
                    queue,
                    "--output=json",
                    request_timeout,
                ),
                "pod",
            )
            for queue in self.queues
        }
        queue_objects = KubectlClient.items(
            self._json(
                "get",
                "queues.scheduling.volcano.sh",
                *self.queues,
                "--output=json",
                request_timeout,
            ),
            "Volcano queue",
        )
        usage = aggregate_usage(
            queue_pods,
            gpu_resource=self.gpu_resource,
        )
        workloads = aggregate_workloads(
            queue_pods,
            gpu_resource=self.gpu_resource,
        )
        report = build_report(
            self.queues,
            queue_objects,
            usage,
            gpus_per_node=self.gpus_per_node,
            gpu_resource=self.gpu_resource,
            workloads=workloads,
        )
        metrics = report_metrics(report)
        return CollectorResult(
            metrics=metrics,
            state={
                "at": now,
                "metrics": metrics,
                "report": report,
            },
        )
