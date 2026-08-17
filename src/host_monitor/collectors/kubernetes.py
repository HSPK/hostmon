from __future__ import annotations

import json
import shlex
import subprocess
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from typing import Any

from ..errors import CollectorError
from .base import CollectorResult, reject_unknown_options


TERMINAL_PHASES = {"Succeeded", "Failed"}
PROBLEM_WAITING_REASONS = {
    "CrashLoopBackOff",
    "CreateContainerConfigError",
    "CreateContainerError",
    "ErrImagePull",
    "ImagePullBackOff",
    "InvalidImageName",
    "RunContainerError",
}
QUANTITY_SUFFIXES = {
    "": Decimal(1),
    "m": Decimal("0.001"),
    "k": Decimal("1000"),
    "K": Decimal("1000"),
    "M": Decimal("1000000"),
    "G": Decimal("1000000000"),
    "Ki": Decimal(1024),
    "Mi": Decimal(1024**2),
    "Gi": Decimal(1024**3),
}


def parse_quantity(value: Any) -> Decimal:
    text = str(value).strip()
    for suffix in sorted(QUANTITY_SUFFIXES, key=len, reverse=True):
        if suffix and not text.endswith(suffix):
            continue
        number = text[: -len(suffix)] if suffix else text
        try:
            return Decimal(number) * QUANTITY_SUFFIXES[suffix]
        except InvalidOperation:
            continue
    raise CollectorError(f"invalid Kubernetes quantity: {value!r}")


def resource_quantity(container: dict[str, Any], resource: str) -> Decimal:
    resources = container.get("resources") or {}
    requests = resources.get("requests") or {}
    limits = resources.get("limits") or {}
    if resource in requests:
        return parse_quantity(requests[resource])
    if resource in limits:
        return parse_quantity(limits[resource])
    return Decimal(0)


def pod_uses_resource(pod: dict[str, Any], resource: str) -> bool:
    spec = pod.get("spec") or {}
    containers = list(spec.get("containers") or [])
    containers.extend(spec.get("initContainers") or [])
    return any(resource_quantity(container, resource) > 0 for container in containers)


def controller_name(pod: dict[str, Any]) -> str:
    metadata = pod.get("metadata") or {}
    labels = metadata.get("labels") or {}
    for key in (
        "volcano.sh/job-name",
        "batch.kubernetes.io/job-name",
        "job-name",
    ):
        if labels.get(key):
            return str(labels[key])
    owners = metadata.get("ownerReferences") or []
    owner = next(
        (item for item in owners if item.get("controller")),
        owners[0] if owners else None,
    )
    return str((owner or {}).get("name") or metadata.get("name") or "<unknown>")


def pod_problem(pod: dict[str, Any]) -> str | None:
    status = pod.get("status") or {}
    phase = status.get("phase")
    reasons: list[str] = []
    for container_status in status.get("containerStatuses") or []:
        state = container_status.get("state") or {}
        waiting = state.get("waiting") or {}
        waiting_reason = waiting.get("reason")
        if waiting_reason in PROBLEM_WAITING_REASONS:
            reasons.append(str(waiting_reason))
        terminated = state.get("terminated") or {}
        exit_code = terminated.get("exitCode")
        if isinstance(exit_code, int) and exit_code != 0:
            reasons.append(
                str(terminated.get("reason") or f"exit-code-{exit_code}")
            )
    if phase == "Failed":
        reasons.append(str(status.get("reason") or "PodFailed"))
    return ",".join(dict.fromkeys(reasons)) if reasons else None


def failed_jobs(jobs: list[dict[str, Any]]) -> dict[str, str]:
    failed: dict[str, str] = {}
    for job in jobs:
        metadata = job.get("metadata") or {}
        name = str(metadata.get("name") or "<unknown>")
        conditions = (job.get("status") or {}).get("conditions") or []
        condition = next(
            (
                item
                for item in conditions
                if item.get("type") == "Failed" and item.get("status") == "True"
            ),
            None,
        )
        if condition is not None:
            failed[name] = str(condition.get("reason") or "JobFailed")
    return failed


@dataclass(frozen=True)
class WorkloadAnalysis:
    metrics: dict[str, float]
    fields: dict[str, Any]
    gpu_task_nodes: dict[str, list[str]]


def analyze_workloads(
    pods: list[dict[str, Any]],
    jobs: list[dict[str, Any]],
    *,
    gpu_resource: str,
) -> WorkloadAnalysis:
    job_problems = failed_jobs(jobs)
    problems = dict(job_problems)
    problem_pods = 0
    occupied_nodes: set[str] = set()
    gpu_task_nodes: dict[str, set[str]] = {}
    gpu_pods = 0
    for pod in pods:
        problem = pod_problem(pod)
        if problem:
            problem_pods += 1
            problems.setdefault(controller_name(pod), problem)
        status = pod.get("status") or {}
        spec = pod.get("spec") or {}
        node = spec.get("nodeName")
        if (
            status.get("phase") not in TERMINAL_PHASES
            and node
            and pod_uses_resource(pod, gpu_resource)
        ):
            occupied_nodes.add(str(node))
            gpu_task_nodes.setdefault(controller_name(pod), set()).add(str(node))
            gpu_pods += 1

    normalized_task_nodes = {
        task: sorted(nodes) for task, nodes in sorted(gpu_task_nodes.items())
    }
    names = sorted(problems)
    details = [f"{name} ({problems[name]})" for name in names]
    metrics = {
        "k8s/failed_task_count": float(len(names)),
        "k8s/failed_job_count": float(len(job_problems)),
        "k8s/problem_pod_count": float(problem_pods),
        "k8s/occupied_gpu_nodes": float(len(occupied_nodes)),
        "k8s/gpu_pod_count": float(gpu_pods),
        "k8s/gpu_task_count": float(len(normalized_task_nodes)),
    }
    fields = {
        "k8s_failed_tasks": ", ".join(names) if names else "(none)",
        "k8s_failed_task_details": "; ".join(details) if details else "(none)",
        "k8s_gpu_tasks": (
            ", ".join(normalized_task_nodes) if normalized_task_nodes else "(none)"
        ),
    }
    return WorkloadAnalysis(
        metrics=metrics,
        fields=fields,
        gpu_task_nodes=normalized_task_nodes,
    )


def stopped_gpu_tasks(
    previous: Any,
    current: dict[str, list[str]],
) -> tuple[list[str], list[str]]:
    if not isinstance(previous, dict):
        return [], []
    stopped: list[str] = []
    details: list[str] = []
    for task, raw_nodes in sorted(previous.items()):
        if not isinstance(raw_nodes, list):
            continue
        prior_nodes = {str(node) for node in raw_nodes}
        current_nodes = {str(node) for node in current.get(str(task), [])}
        lost_nodes = sorted(prior_nodes - current_nodes)
        if not lost_nodes:
            continue
        stopped.append(str(task))
        details.append(f"{task} (-{', -'.join(lost_nodes)})")
    return stopped, details


class KubernetesCollector:
    name = "kubernetes"

    def __init__(self, options: dict[str, Any]):
        reject_unknown_options(
            self.name,
            options,
            {
                "context",
                "namespace",
                "queue",
                "gpu_resource",
                "gpus_per_node",
                "poll_interval_seconds",
                "kubectl",
                "timeout_seconds",
            },
        )
        self.context = str(options.get("context", "")).strip()
        self.namespace = str(options.get("namespace", "")).strip()
        if not self.namespace:
            raise ValueError("namespace is required")
        self.queue = str(options.get("queue", "")).strip()
        self.gpu_resource = str(
            options.get("gpu_resource", "nvidia.com/gpu")
        ).strip()
        self.gpus_per_node = int(options.get("gpus_per_node", 8))
        if self.gpus_per_node < 1:
            raise ValueError("gpus_per_node must be positive")
        self.poll_interval = float(options.get("poll_interval_seconds", 60))
        if self.poll_interval <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        kubectl = options.get("kubectl", "kubectl")
        if not isinstance(kubectl, str) or not kubectl.strip():
            raise ValueError("kubectl must be a non-empty command")
        self.kubectl = shlex.split(kubectl)
        self.timeout = float(options.get("timeout_seconds", 30))
        if self.timeout <= 0:
            raise ValueError("timeout_seconds must be positive")

    def _command(self, *arguments: str) -> list[str]:
        command = list(self.kubectl)
        if self.context:
            command.extend(["--context", self.context])
        command.extend(arguments)
        return command

    def _json(self, *arguments: str) -> dict[str, Any]:
        command = self._command(*arguments)
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                check=False,
                text=True,
                timeout=self.timeout,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as error:
            raise CollectorError(f"cannot run {command[0]}: {error}") from error
        if result.returncode != 0:
            detail = result.stderr.strip() or result.stdout.strip()
            raise CollectorError(f"kubectl failed: {detail}")
        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise CollectorError("kubectl returned invalid JSON") from error
        if not isinstance(payload, dict):
            raise CollectorError("kubectl returned a non-object JSON payload")
        return payload

    @staticmethod
    def _items(payload: dict[str, Any], kind: str) -> list[dict[str, Any]]:
        items = payload.get("items")
        if not isinstance(items, list) or not all(
            isinstance(item, dict) for item in items
        ):
            raise CollectorError(f"kubectl returned an invalid {kind} list")
        return items

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
                )

        request_timeout = f"--request-timeout={max(1, int(self.timeout))}s"
        pods = self._items(
            self._json(
                "get",
                "pods",
                "--namespace",
                self.namespace,
                "--output=json",
                request_timeout,
            ),
            "pod",
        )
        jobs = self._items(
            self._json(
                "get",
                "jobs",
                "--namespace",
                self.namespace,
                "--output=json",
                request_timeout,
            ),
            "job",
        )
        analysis = analyze_workloads(
            pods,
            jobs,
            gpu_resource=self.gpu_resource,
        )
        metrics = analysis.metrics
        fields = analysis.fields
        previous_task_nodes = (
            previous.get("gpu_task_nodes") if isinstance(previous, dict) else None
        )
        stopped_tasks, stopped_details = stopped_gpu_tasks(
            previous_task_nodes,
            analysis.gpu_task_nodes,
        )
        metrics["k8s/stopped_task_count"] = float(len(stopped_tasks))
        fields["k8s_stopped_tasks"] = (
            ", ".join(stopped_tasks) if stopped_tasks else "(none)"
        )
        fields["k8s_stopped_task_details"] = (
            "; ".join(stopped_details) if stopped_details else "(none)"
        )
        fields.update(
            {
                "k8s_context": self.context or "current",
                "k8s_namespace": self.namespace,
            }
        )
        if self.queue:
            queue = self._json(
                "get",
                "queues.scheduling.volcano.sh",
                self.queue,
                "--output=json",
                request_timeout,
            )
            capability = (queue.get("spec") or {}).get("capability") or {}
            if self.gpu_resource not in capability:
                raise CollectorError(
                    f"Volcano queue {self.queue!r} has no "
                    f"{self.gpu_resource!r} capability"
                )
            quota = parse_quantity(capability[self.gpu_resource])
            if quota <= 0:
                raise CollectorError(
                    f"Volcano queue {self.queue!r} has a non-positive GPU quota"
                )
            quota_nodes = int(
                (quota / Decimal(self.gpus_per_node)).to_integral_value(
                    rounding=ROUND_CEILING
                )
            )
            metrics["k8s/quota_gpus"] = float(quota)
            metrics["k8s/quota_nodes"] = float(quota_nodes)
        state = {
            "at": now,
            "metrics": metrics,
            "fields": fields,
            "gpu_task_nodes": analysis.gpu_task_nodes,
        }
        return CollectorResult(metrics=metrics, fields=fields, state=state)
