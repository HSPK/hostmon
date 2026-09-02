from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from host_monitor.collectors.base import CollectorResult, reject_unknown_options
from .kubectl_client import KubectlClient, parse_quantity


TERMINAL_PHASES = {"Succeeded", "Failed"}
STATE_SCHEMA_VERSION = 2
PROBLEM_WAITING_REASONS = {
    "CrashLoopBackOff",
    "CreateContainerConfigError",
    "CreateContainerError",
    "ErrImagePull",
    "ImagePullBackOff",
    "InvalidImageName",
    "RunContainerError",
}
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
    gpu_task_nodes: dict[str, set[str]] = {}
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
            gpu_task_nodes.setdefault(controller_name(pod), set()).add(str(node))

    normalized_task_nodes = {
        task: sorted(nodes) for task, nodes in sorted(gpu_task_nodes.items())
    }
    names = sorted(problems)
    details = [f"{name} ({problems[name]})" for name in names]
    metrics = {
        "k8s/failed_task_count": float(len(names)),
        "k8s/failed_job_count": float(len(job_problems)),
        "k8s/problem_pod_count": float(problem_pods),
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
                "gpu_resource",
                "poll_interval_seconds",
                "kubectl",
                "timeout_seconds",
                "max_parallel_queries",
            },
        )
        self.context = str(options.get("context", "")).strip()
        self.namespace = str(options.get("namespace", "")).strip()
        if not self.namespace:
            raise ValueError("namespace is required")
        self.gpu_resource = str(
            options.get("gpu_resource", "nvidia.com/gpu")
        ).strip()
        self.poll_interval = float(options.get("poll_interval_seconds", 60))
        if self.poll_interval <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        self.timeout = float(options.get("timeout_seconds", 30))
        if self.timeout <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.max_parallel_queries = int(options.get("max_parallel_queries", 2))
        if self.max_parallel_queries < 1:
            raise ValueError("max_parallel_queries must be positive")
        self._executor = ThreadPoolExecutor(
            max_workers=min(self.max_parallel_queries, 2),
            thread_name_prefix="hostmon-kubernetes",
        )
        self.client = KubectlClient(
            str(options.get("kubectl", "kubectl")),
            context=self.context,
            timeout_seconds=self.timeout,
        )

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _json(self, *arguments: str) -> dict[str, Any]:
        return self.client.json(*arguments)

    @staticmethod
    def _items(payload: dict[str, Any], kind: str) -> list[dict[str, Any]]:
        return KubectlClient.items(payload, kind)

    def collect(
        self, previous: dict[str, Any] | None, now: float
    ) -> CollectorResult:
        if isinstance(previous, dict):
            at = previous.get("at")
            metrics = previous.get("metrics")
            fields = previous.get("fields")
            if (
                previous.get("schema_version") == STATE_SCHEMA_VERSION
                and isinstance(at, (int, float))
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

        request_timeout = f"--request-timeout={max(1, int(self.timeout))}s"
        futures = {
            "pods": self._executor.submit(
                self._json,
                "get",
                "pods",
                "--namespace",
                self.namespace,
                "--output=json",
                request_timeout,
            ),
            "jobs": self._executor.submit(
                self._json,
                "get",
                "jobs",
                "--namespace",
                self.namespace,
                "--output=json",
                request_timeout,
            ),
        }
        wait(tuple(futures.values()))
        pods = self._items(
            futures["pods"].result(),
            "pod",
        )
        jobs = self._items(
            futures["jobs"].result(),
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
        state = {
            "schema_version": STATE_SCHEMA_VERSION,
            "at": now,
            "metrics": metrics,
            "fields": fields,
            "gpu_task_nodes": analysis.gpu_task_nodes,
        }
        return CollectorResult(metrics=metrics, fields=fields, state=state)
