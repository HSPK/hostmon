from __future__ import annotations

import json
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from host_monitor.collectors.cpu import CPUCollector, parse_cpu_line
from hostmon_cluster_gpu.cluster_gpu_usage import (
    ClusterGPUUsageCollector,
    aggregate_usage,
    aggregate_workloads,
    build_report,
    report_metrics,
)
from host_monitor.collectors.disk import DiskCollector
from host_monitor.collectors.gpu import parse_gpu_rows
from hostmon_cluster_gpu.kubernetes import (
    KubernetesCollector,
    analyze_workloads,
    stopped_gpu_tasks,
)
from host_monitor.collectors.memory import MemoryCollector, parse_meminfo
from host_monitor.collectors.network import NetworkCollector, parse_net_dev
from hostmon_cluster_gpu.kubectl_client import KubectlClient
from hostmon_cluster_gpu.permissions import (
    KubernetesPermissionCollector,
    parse_checks,
)
from host_monitor.config import (
    ConfigError,
    initialize_config,
    load_settings,
    update_prometheus_config,
)
from host_monitor.errors import CollectorError
from host_monitor.rules import write_default_rules


class ConfigTests(unittest.TestCase):
    def test_initializes_and_loads_complete_default_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)
            settings = load_settings(path)
            write_default_rules(settings.rules_file)

            self.assertEqual(settings.interval_seconds, 10)
            self.assertEqual(settings.rules_file, Path(directory) / "rules.json")
            self.assertEqual(
                [item.name for item in settings.collectors if item.enabled],
                ["cpu", "memory", "disk", "network", "gpu", "pressure"],
            )
            self.assertFalse(settings.alerts.enabled)
            self.assertTrue(settings.history.enabled)
            self.assertEqual(settings.history.max_file_bytes, 64 * 1024 * 1024)
            self.assertFalse(settings.prometheus.enabled)
            self.assertEqual(settings.prometheus.host, "127.0.0.1")
            self.assertEqual(settings.prometheus.port, 9108)
            self.assertIsNone(settings.prometheus.dashboard_directory)
            self.assertEqual(len(settings.collectors), 6)

    def test_atomically_updates_prometheus_section(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)

            settings = update_prometheus_config(
                path,
                enabled=True,
                host="127.0.0.2",
                port=9200,
                max_sample_age_seconds=45,
            )

            self.assertTrue(settings.prometheus.enabled)
            self.assertEqual(settings.prometheus.host, "127.0.0.2")
            self.assertEqual(settings.prometheus.port, 9200)
            self.assertEqual(settings.prometheus.max_sample_age_seconds, 45)
            self.assertIn("[collectors.cpu]", path.read_text(encoding="utf-8"))

    def test_invalid_prometheus_update_preserves_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)
            before = path.read_text(encoding="utf-8")

            with self.assertRaises(ConfigError):
                update_prometheus_config(path, port=70000)

            self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_resolves_external_dashboard_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)
            content = path.read_text(encoding="utf-8").replace(
                "max_sample_age_seconds = 30",
                'max_sample_age_seconds = 30\ndashboard_file = "dashboard.json"',
            )
            Path(directory, "dashboard.json").write_text(
                "{}",
                encoding="utf-8",
            )
            path.write_text(content, encoding="utf-8")

            settings = load_settings(path)

        self.assertEqual(
            settings.prometheus.dashboard_file,
            Path(directory) / "dashboard.json",
        )

    def test_rejects_missing_external_dashboard_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            initialize_config(path)
            content = path.read_text(encoding="utf-8").replace(
                "max_sample_age_seconds = 30",
                'max_sample_age_seconds = 30\n'
                'dashboard_directory = "missing-dashboard"',
            )
            path.write_text(content, encoding="utf-8")

            with self.assertRaisesRegex(
                ConfigError,
                "dashboard_directory does not exist",
            ):
                load_settings(path)

    def test_plugin_dashboard_requires_external_asset_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.toml"
            dashboard = Path(directory) / "dashboard.json"
            initialize_config(path)
            dashboard.write_text(
                json.dumps(
                    {
                        "panels": [
                            {
                                "id": "records",
                                "type": "plugin-records",
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            content = path.read_text(encoding="utf-8").replace(
                "max_sample_age_seconds = 30",
                'max_sample_age_seconds = 30\n'
                'dashboard_file = "dashboard.json"',
            )
            path.write_text(content, encoding="utf-8")

            with self.assertRaisesRegex(
                ConfigError,
                "dashboard_directory is not configured",
            ):
                load_settings(path)


class CPUCollectorTests(unittest.TestCase):
    def test_parses_and_calculates_cpu_percent(self):
        total, idle = parse_cpu_line("cpu  100 0 50 800 50 0 0 0 0 0\n")
        self.assertEqual((total, idle), (1000, 850))

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "stat").write_text(
                "cpu  100 0 50 800 50 0 0 0 0 0\n", encoding="utf-8"
            )
            (root / "loadavg").write_text("1.0 2.0 3.0 1/1 1\n", encoding="utf-8")
            (root / "uptime").write_text("123.0 0.0\n", encoding="utf-8")
            collector = CPUCollector({"proc_root": directory})

            result = collector.collect(
                {"total": 900, "idle": 800, "at": 9},
                10,
            )

        self.assertAlmostEqual(result.metrics["cpu/percent"], 50)
        self.assertEqual(result.metrics["cpu/load5"], 2)
        self.assertEqual(result.metrics["host/uptime_seconds"], 123)


class MemoryCollectorTests(unittest.TestCase):
    def test_parses_meminfo_and_calculates_used_memory(self):
        values = parse_meminfo(
            "MemTotal: 1000 kB\nMemAvailable: 250 kB\n"
            "Cached: 100 kB\nBuffers: 50 kB\n"
            "SwapTotal: 200 kB\nSwapFree: 50 kB\n"
        )
        self.assertEqual(values["MemTotal"], 1000 * 1024)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meminfo"
            path.write_text(
                "MemTotal: 1000 kB\nMemAvailable: 250 kB\n"
                "Cached: 100 kB\nBuffers: 50 kB\n"
                "SwapTotal: 200 kB\nSwapFree: 50 kB\n",
                encoding="utf-8",
            )
            result = MemoryCollector({"proc_root": directory}).collect(None, 1)

        self.assertAlmostEqual(result.metrics["memory/percent"], 75)
        self.assertAlmostEqual(result.metrics["memory/swap_percent"], 75)


class DiskCollectorTests(unittest.TestCase):
    def test_emits_per_path_and_max_disk_percent(self):
        usage = type("Usage", (), {"total": 1000, "used": 750, "free": 250})
        with patch("host_monitor.collectors.disk.shutil.disk_usage", return_value=usage):
            result = DiskCollector({"paths": ["/"]}).collect(None, 1)

        self.assertEqual(result.metrics["disk/root/percent"], 75)
        self.assertEqual(result.metrics["disk/percent"], 75)


class NetworkCollectorTests(unittest.TestCase):
    def test_filters_interfaces_and_calculates_rates(self):
        first = (
            "Inter-| Receive | Transmit\n"
            " face |bytes packets errs drop fifo frame compressed multicast|"
            "bytes packets errs drop fifo colls carrier compressed\n"
            "lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n"
            "eth0: 1000000 1 0 0 0 0 0 0 2000000 1 0 0 0 0 0 0\n"
        )
        parsed = parse_net_dev(first)
        self.assertEqual(parsed["eth0"]["tx_bytes"], 2_000_000)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "net"
            path.mkdir()
            (path / "dev").write_text(first, encoding="utf-8")
            collector = NetworkCollector(
                {"proc_root": directory, "include": ["*"], "exclude": ["lo"]}
            )
            baseline = collector.collect(None, 10)
            second = (
                "Inter-| Receive | Transmit\n"
                " face |bytes packets errs drop fifo frame compressed multicast|"
                "bytes packets errs drop fifo colls carrier compressed\n"
                "lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n"
                "eth0: 2000000 1 0 0 0 0 0 0 3000000 1 0 0 0 0 0 0\n"
            )
            (path / "dev").write_text(second, encoding="utf-8")
            result = collector.collect(baseline.state, 12)

        self.assertAlmostEqual(result.metrics["network/rx_mbps"], 4)
        self.assertAlmostEqual(result.metrics["network/tx_mbps"], 4)
        self.assertEqual(result.metrics["network/interface_count"], 1)


class GPUCollectorTests(unittest.TestCase):
    def test_parses_nvidia_smi_rows(self):
        rows = parse_gpu_rows("0, 95, 81920, 40960, 78, 300.5\n")

        self.assertEqual(rows[0]["index"], 0)
        self.assertEqual(rows[0]["utilization.gpu"], 95)
        self.assertEqual(rows[0]["power.draw"], 300.5)


class KubernetesCollectorTests(unittest.TestCase):
    def test_reports_failed_task_names_and_gpu_nodes(self):
        jobs = [
            {
                "metadata": {"name": "failed-job"},
                "status": {
                    "conditions": [
                        {
                            "type": "Failed",
                            "status": "True",
                            "reason": "BackoffLimitExceeded",
                        }
                    ]
                },
            }
        ]
        pods = [
            {
                "metadata": {
                    "name": "failed-job-abc",
                    "ownerReferences": [
                        {
                            "name": "failed-job",
                            "kind": "Job",
                            "controller": True,
                        }
                    ],
                },
                "status": {"phase": "Failed", "reason": "Error"},
                "spec": {"containers": []},
            },
            {
                "metadata": {
                    "name": "worker-0",
                    "ownerReferences": [
                        {
                            "name": "training",
                            "kind": "Job",
                            "controller": True,
                        }
                    ],
                },
                "status": {
                    "phase": "Running",
                    "containerStatuses": [
                        {
                            "state": {
                                "waiting": {"reason": "CrashLoopBackOff"}
                            }
                        }
                    ],
                },
                "spec": {
                    "nodeName": "gpu-1",
                    "containers": [
                        {
                            "resources": {
                                "limits": {"nvidia.com/gpu": "8"}
                            }
                        }
                    ],
                },
            },
        ]

        analysis = analyze_workloads(
            pods,
            jobs,
            gpu_resource="nvidia.com/gpu",
        )

        metrics, fields = analysis.metrics, analysis.fields
        self.assertEqual(metrics["k8s/failed_task_count"], 2)
        self.assertEqual(metrics["k8s/occupied_gpu_nodes"], 1)
        self.assertEqual(
            analysis.gpu_task_nodes,
            {"training": ["gpu-1"]},
        )
        self.assertEqual(fields["k8s_failed_tasks"], "failed-job, training")
        self.assertIn("BackoffLimitExceeded", fields["k8s_failed_task_details"])
        self.assertIn("CrashLoopBackOff", fields["k8s_failed_task_details"])

    def test_reuses_cached_poll_result(self):
        collector = KubernetesCollector(
            {
                "namespace": "team-a",
                "poll_interval_seconds": 60,
            }
        )
        previous = {
            "at": 100,
            "metrics": {"k8s/failed_task_count": 1.0},
            "fields": {"k8s_failed_tasks": "job-a"},
        }
        with patch.object(collector, "_json") as query:
            result = collector.collect(previous, 120)

        query.assert_not_called()
        self.assertEqual(result.metrics["k8s/failed_task_count"], 1)
        self.assertEqual(result.fields["k8s_failed_tasks"], "job-a")
        self.assertFalse(result.refreshed)

    def test_identifies_tasks_that_lost_gpu_nodes(self):
        stopped, details = stopped_gpu_tasks(
            {
                "training-a": ["gpu-1", "gpu-2"],
                "training-b": ["gpu-3"],
            },
            {
                "training-a": ["gpu-1"],
            },
        )

        self.assertEqual(stopped, ["training-a", "training-b"])
        self.assertEqual(
            details,
            ["training-a (-gpu-2)", "training-b (-gpu-3)"],
        )


class KubernetesPermissionCollectorTests(unittest.TestCase):
    def test_checks_all_verbs_and_exposes_missing_permissions(self):
        collector = KubernetesPermissionCollector(
            {
                "checks": [
                    {
                        "name": "team_volcano_jobs",
                        "context": "my-cluster",
                        "namespace": "ml-team",
                        "resource": "jobs.batch.volcano.sh",
                        "verbs": ["create", "get", "list", "watch"],
                    }
                ]
            }
        )
        answers = {
            "create": False,
            "get": True,
            "list": True,
            "watch": False,
        }
        with patch.object(
            collector,
            "_allowed",
            side_effect=lambda check, verb: answers[verb],
        ):
            result = collector.collect(None, 100)

        self.assertEqual(
            result.metrics["permission/team_volcano_jobs/allowed"],
            0,
        )
        self.assertEqual(
            result.fields["permission_team_volcano_jobs_granted_verbs"],
            "get, list",
        )
        self.assertEqual(
            result.fields["permission_team_volcano_jobs_missing_verbs"],
            "create, watch",
        )

    def test_reuses_cached_permission_result(self):
        collector = KubernetesPermissionCollector(
            {
                "checks": [
                    {
                        "name": "access",
                        "namespace": "team-a",
                        "resource": "jobs.batch.volcano.sh",
                        "verbs": ["create"],
                    }
                ],
                "poll_interval_seconds": 60,
            }
        )
        previous = {
            "at": 100,
            "metrics": {"permission/access/allowed": 0.0},
            "fields": {"permission_access_missing_verbs": "create"},
        }
        with patch.object(collector, "_allowed") as query:
            result = collector.collect(previous, 120)

        query.assert_not_called()
        self.assertEqual(result.metrics["permission/access/allowed"], 0)
        self.assertFalse(result.refreshed)

    def test_rejects_unsafe_check_names(self):
        with self.assertRaises(ValueError):
            parse_checks(
                [
                    {
                        "name": "bad/name",
                        "resource": "jobs.batch.volcano.sh",
                        "verbs": ["get"],
                    }
                ]
            )


class KubectlClientTests(unittest.TestCase):
    def test_empty_command_errors_include_exit_code(self):
        client = KubectlClient("kubectl")

        with patch(
            "hostmon_cluster_gpu.kubectl_client.subprocess.run",
            return_value=subprocess.CompletedProcess(
                ["kubectl"],
                7,
                stdout="",
                stderr="",
            ),
        ):
            with self.assertRaisesRegex(CollectorError, "exit code 7"):
                client.run("get", "pods")
            with self.assertRaisesRegex(CollectorError, "exit code 7"):
                client.can_i("get", "pods")


class ClusterGPUUsageCollectorTests(unittest.TestCase):
    def test_matches_submitter_and_queue_capacity_semantics(self):
        pods = {
            "queue-a": [
                {
                    "metadata": {
                        "labels": {
                            "created-by-name": "run-a",
                            "created-by": "user-a",
                            "volcano.sh/job-name": "job-a",
                        }
                    },
                    "status": {"phase": "Running"},
                    "spec": {
                        "nodeName": "gpu-1",
                        "containers": [
                            {
                                "resources": {
                                    "requests": {"nvidia.com/gpu": "8"}
                                }
                            }
                        ],
                    },
                },
                {
                    "metadata": {
                        "labels": {
                            "owner": "run-a",
                            "created-by": "user-a",
                            "volcano.sh/job-name": "job-a",
                        }
                    },
                    "status": {"phase": "Pending"},
                    "spec": {
                        "containers": [
                            {
                                "resources": {
                                    "requests": {"nvidia.com/gpu": "12"}
                                }
                            }
                        ]
                    },
                },
            ]
        }
        usage = aggregate_usage(pods, gpu_resource="nvidia.com/gpu")
        workloads = aggregate_workloads(
            pods,
            gpu_resource="nvidia.com/gpu",
        )
        queues = [
            {
                "metadata": {"name": "queue-a"},
                "spec": {
                    "capability": {
                        "nvidia.com/gpu": "32",
                        "cpu": "200",
                    }
                },
                "status": {
                    "allocated": {
                        "nvidia.com/gpu": "16",
                        "cpu": "125500m",
                    }
                },
            }
        ]

        report = build_report(
            ["queue-a"],
            queues,
            usage,
            gpus_per_node=8,
            gpu_resource="nvidia.com/gpu",
            workloads=workloads,
        )
        metrics = report_metrics(report)

        self.assertEqual(report["usage"][0]["running_gpus"], 8)
        self.assertEqual(report["usage"][0]["pending_gpus"], 12)
        self.assertEqual(len(report["workloads"]), 1)
        self.assertEqual(report["workloads"][0]["name"], "job-a")
        self.assertEqual(report["workloads"][0]["status"], "Mixed")
        self.assertEqual(report["workloads"][0]["running_nodes"], ["gpu-1"])
        self.assertEqual(report["capacity"][0]["unallocated_gpus"], 16)
        self.assertEqual(report["capacity"][0]["no_job_gpus"], 12)
        self.assertEqual(report["capacity"][0]["gpu_allocation"], "16 / 32")
        self.assertEqual(report["capacity"][0]["utilization_percent"], 50)
        self.assertEqual(report["capacity"][0]["no_job_node_equivalents"], 1)
        self.assertEqual(report["capacity"][0]["allocated_cpus"], 125.5)
        self.assertEqual(
            metrics["cluster_gpu/queue/queue_a/allocated_gpus"],
            16,
        )
        self.assertEqual(
            metrics["cluster_gpu/queue/queue_a/no_job_gpus"],
            12,
        )

    def test_reuses_cached_cluster_report(self):
        collector = ClusterGPUUsageCollector(
            {
                "queues": ["queue-a"],
                "poll_interval_seconds": 60,
            }
        )
        previous = {
            "schema_version": 3,
            "at": 100,
            "metrics": {"cluster_gpu/running_gpus": 8},
            "report": {"usage": [], "workloads": []},
        }
        with patch.object(collector, "_json") as query:
            result = collector.collect(previous, 120)

        query.assert_not_called()
        self.assertEqual(result.metrics["cluster_gpu/running_gpus"], 8)
        self.assertIs(result.state, previous)
        self.assertFalse(result.refreshed)

    def test_cluster_queries_run_concurrently(self):
        collector = ClusterGPUUsageCollector(
            {
                "queues": ["queue-a", "queue-b"],
                "max_parallel_queries": 3,
            }
        )
        release = threading.Event()
        lock = threading.Lock()
        active = 0
        peak = 0

        def query(*arguments):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                if active == 3:
                    release.set()
            if not release.wait(0.5):
                raise AssertionError("cluster queries did not overlap")
            try:
                if arguments[1] == "pods":
                    return {"items": []}
                return {
                    "items": [
                        {
                            "metadata": {"name": queue},
                            "spec": {
                                "capability": {
                                    "nvidia.com/gpu": "8",
                                    "cpu": "100",
                                }
                            },
                            "status": {
                                "allocated": {
                                    "nvidia.com/gpu": "0",
                                    "cpu": "0",
                                }
                            },
                        }
                        for queue in ("queue-a", "queue-b")
                    ]
                }
            finally:
                with lock:
                    active -= 1

        try:
            with patch.object(collector, "_json", side_effect=query):
                result = collector.collect(None, 100)
        finally:
            collector.close()

        self.assertEqual(peak, 3)
        self.assertEqual(
            result.metrics["cluster_gpu/queue/total/capacity_gpus"],
            16,
        )

    def test_reuses_cluster_query_executor(self):
        def query(*arguments):
            if arguments[1] == "pods":
                return {"items": []}
            return {
                "items": [
                    {
                        "metadata": {"name": "queue-a"},
                        "spec": {
                            "capability": {
                                "nvidia.com/gpu": "8",
                                "cpu": "100",
                            }
                        },
                        "status": {
                            "allocated": {
                                "nvidia.com/gpu": "0",
                                "cpu": "0",
                            }
                        },
                    }
                ]
            }

        with patch(
            "hostmon_cluster_gpu.cluster_gpu_usage.ThreadPoolExecutor",
            wraps=ThreadPoolExecutor,
        ) as executor_type, patch(
            "hostmon_cluster_gpu.cluster_gpu_usage._trim_native_heap",
            return_value=True,
        ) as trim:
            collector = ClusterGPUUsageCollector({"queues": ["queue-a"]})
            try:
                with patch.object(collector, "_json", side_effect=query):
                    first = collector.collect(None, 100)
                    collector.collect(first.state, 200)
            finally:
                collector.close()

        executor_type.assert_called_once()
        self.assertEqual(trim.call_count, 2)


if __name__ == "__main__":
    unittest.main()
