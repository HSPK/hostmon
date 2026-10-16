from __future__ import annotations

import copy
import unittest
from unittest.mock import patch

from host_monitor.errors import CollectorError
from host_monitor.rvx_snapshots import _public_collectors
from hostmon_cluster_gpu.cluster_gpu_usage import (
    ClusterGPUUsageCollector,
    add_workload_timing,
    aggregate_usage,
    aggregate_workloads,
    build_report,
)


def job(*, phase="Running", uid="job-uid"):
    return {
        "metadata": {
            "name": "job-a", "uid": uid,
            "creationTimestamp": "2026-01-01T00:00:00Z",
            "labels": {"created-by-name": "test-user"},
        },
        "spec": {"tasks": [{"template": {
            "spec": {"containers": [{"resources": {"requests": {"nvidia.com/gpu": "8"}}}]}
        }}]},
        "status": {"state": {"phase": phase}},
    }


def pod(*, phase="Running", started="2026-01-01T00:01:00Z", finished=None):
    state = {}
    if started:
        state = {"running": {"startedAt": started}}
    if finished:
        state = {"terminated": {"startedAt": started, "finishedAt": finished}}
    return {
        "metadata": {"name": "pod-a", "labels": {
            "volcano.sh/job-name": "job-a", "created-by-name": "test-user",
        }},
        "spec": {"nodeName": "gpu-1", "containers": [
            {"resources": {"requests": {"nvidia.com/gpu": "8"}}}
        ]},
        "status": {"phase": phase, "containerStatuses": [{"state": state}]},
    }


def report_for(jobs, pods, *, now=1767225900, previous=None):
    queue_pods = {"queue-a": pods}
    report = build_report(
        ["queue-a"], [{"metadata": {"name": "queue-a"}}],
        aggregate_usage(queue_pods, gpu_resource="nvidia.com/gpu"),
        gpus_per_node=8, gpu_resource="nvidia.com/gpu",
        workloads=aggregate_workloads(queue_pods, gpu_resource="nvidia.com/gpu"),
    )
    add_workload_timing(
        report, queue_pods, {"queue-a": jobs}, now=now,
        previous_report=previous, gpu_resource="nvidia.com/gpu",
    )
    return report


class WorkloadTimingTests(unittest.TestCase):
    def test_running_uses_job_submission_and_actual_container_start(self):
        report = report_for([job()], [pod()])
        row = report["workloads"][0]
        self.assertEqual(row["submitted_at"], 1767225600)
        self.assertEqual(row["started_at"], 1767225660)
        self.assertEqual(row["runtime_seconds"], 240)
        self.assertIsNone(row["finished_at"])
        self.assertEqual(report["usage"][0]["running_gpus"], 8)

    def test_pending_without_pods_has_no_runtime(self):
        pending = job(phase="Pending")
        pending["status"]["startTime"] = "2026-01-01T00:00:10Z"
        row = report_for([pending], [])["workloads"][0]
        self.assertEqual(row["status"], "Pending")
        self.assertIsNone(row["started_at"])
        self.assertIsNone(row["runtime_seconds"])

    def test_completed_duration_is_fixed_and_does_not_allocate_gpus(self):
        done = job(phase="Completed")
        done["status"]["state"]["lastTransitionTime"] = "2026-01-01T00:04:00Z"
        pods = [pod(phase="Succeeded", finished="2026-01-01T00:03:50Z")]
        first = report_for([done], pods)
        later = report_for([done], [], now=1767229900, previous=first)
        for report in (first, later):
            row = report["workloads"][0]
            self.assertEqual(row["runtime_seconds"], 180)
            self.assertEqual(row["finished_at"], 1767225840)
            self.assertEqual(row["running_gpus"], 0)
            self.assertEqual(report["usage"], [])

    def test_start_survives_restart_but_not_job_name_reuse(self):
        first = report_for([job()], [pod()])
        restarted = report_for(
            [job()], [pod(started="2026-01-01T00:03:00Z")], previous=first
        )
        self.assertEqual(restarted["workloads"][0]["started_at"], 1767225660)
        replacement = report_for([job(phase="Pending", uid="new")], [], previous=first)
        self.assertIsNone(replacement["workloads"][0]["started_at"])

    def test_batch_job_completion_and_failed_without_start(self):
        batch = job()
        batch["spec"] = {"template": batch["spec"]["tasks"][0]["template"]}
        batch["status"] = {
            "startTime": "2026-01-01T00:01:00Z",
            "completionTime": "2026-01-01T00:04:00Z",
            "conditions": [{"type": "Complete", "status": "True"}],
        }
        row = report_for(
            [batch], [pod(phase="Succeeded", finished="2026-01-01T00:04:00Z")]
        )["workloads"][0]
        self.assertEqual(row["status"], "Completed")
        self.assertEqual(row["runtime_seconds"], 180)
        failed = job(phase="Failed")
        failed["status"]["state"]["lastTransitionTime"] = "2026-01-01T00:04:00Z"
        self.assertIsNone(report_for([failed], [])["workloads"][0]["runtime_seconds"])

    def test_multiple_pods_use_earliest_start_and_cpu_jobs_stay_excluded(self):
        second = pod(started="2026-01-01T00:02:00Z")
        second["metadata"]["name"] = "pod-b"
        row = report_for([job()], [pod(), second])["workloads"][0]
        self.assertEqual(row["started_at"], 1767225660)
        cpu = job()
        cpu["spec"]["tasks"][0]["template"]["spec"]["containers"][0]["resources"] = {}
        self.assertEqual(report_for([cpu], [])["workloads"], [])

    def test_invalid_timestamp_is_an_explicit_collector_error(self):
        invalid = job()
        invalid["metadata"]["creationTimestamp"] = "invalid"
        with self.assertRaisesRegex(CollectorError, "timestamp"):
            report_for([invalid], [pod()])

    def test_job_query_failure_is_not_silently_hidden(self):
        collector = ClusterGPUUsageCollector({"queues": ["queue-a"]})
        self.addCleanup(collector.close)

        def query(*arguments):
            if arguments[1] == "jobs.batch,jobs.batch.volcano.sh":
                raise CollectorError("jobs list forbidden")
            if arguments[1] == "queues.scheduling.volcano.sh":
                return {"items": [{"metadata": {"name": "queue-a"}}]}
            return {"items": []}

        with patch.object(collector, "_json", side_effect=query):
            with self.assertRaisesRegex(CollectorError, "jobs list forbidden"):
                collector.collect(None, 1767225900)

    def test_timing_fields_survive_rvx_public_snapshot(self):
        report = report_for([job()], [pod()])
        states = {"cluster_gpu_usage": {
            "last_success_at": 1767225900,
            "plugin_state": {"report": report, "schema_version": 4, "at": 1767225900},
        }}
        original = copy.deepcopy(states)
        public = _public_collectors(states, {}, 1767225900)
        self.assertEqual(
            public["cluster_gpu_usage"]["document"]["workloads"][0]["runtime_seconds"],
            240,
        )
        self.assertEqual(states, original)


if __name__ == "__main__":
    unittest.main()
