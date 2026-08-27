# Cluster GPU usage plugin

The `cluster_gpu_usage` collector aggregates Kubernetes Pods and Volcano queue
status across one or more queue namespaces.

## Configuration

```toml
[collectors.cluster_gpu_usage]
enabled = true
required = false
deadline_seconds = 5
max_stale_seconds = 300
context = "my-cluster"
queues = ["queue-a", "queue-b"]
gpu_resource = "nvidia.com/gpu"
gpus_per_node = 8
poll_interval_seconds = 60
kubectl = "kubectl"
timeout_seconds = 30
```

The collector groups running and pending GPU Pods by:

1. `created-by-name`
2. `owner`
3. `(unlabeled)`

`created-by` is retained as the creator ID. Running nodes are deduplicated per
submitter.

## Queue calculations

| Value | Calculation |
| --- | --- |
| Capacity GPUs | `spec.capability[nvidia.com/gpu]` |
| Allocated GPUs | `status.allocated[nvidia.com/gpu]` |
| Pending GPUs | Sum of pending Pod GPU requests |
| Free now | Capacity minus allocated |
| No-job GPUs | Free now minus pending |
| No-job nodes | Positive no-job GPUs divided by GPUs per node |
| Free CPUs | CPU capacity minus allocated CPU |

Queue aggregates are regular numeric hostmon metrics, for example:

```text
cluster_gpu/queue/queue_a/capacity_gpus
cluster_gpu/queue/queue_a/allocated_gpus
cluster_gpu/queue/queue_a/no_job_node_equivalents
cluster_gpu/queue/total/free_cpus
```

The complete submitter table is a structured plugin document:

```text
GET /api/plugins/cluster_gpu_usage
```

This avoids high-cardinality submitter names in metric history while still
supporting rich GPU Fleet and Workloads UI views.
