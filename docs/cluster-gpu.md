# Cluster GPU usage plugin

The `cluster_gpu_usage` collector aggregates Kubernetes Pods and Volcano queue
status across one or more queue namespaces.

## Configuration

```toml
[collectors.cluster_gpu_usage]
enabled = true
required = false
deadline_seconds = 20
max_stale_seconds = 300
context = "my-cluster"
queues = ["queue-a", "queue-b"]
gpu_resource = "nvidia.com/gpu"
gpus_per_node = 8
poll_interval_seconds = 60
kubectl = "kubectl"
timeout_seconds = 30
max_parallel_queries = 2
```

The daemon refreshes this optional collector in the background. Slow
Kubernetes responses therefore keep the previous valid report available
without delaying localhost samples or dashboard WebSocket updates.
Independent Pod and Volcano queue requests run concurrently with a bounded,
configurable worker count. Two workers are the default because additional
workers increase Kubernetes client pressure without improving the normal
two-queue refresh time.

Permission checks can use the same bounded concurrency without launching all
`kubectl auth can-i` commands at once:

```toml
[collectors.kubernetes_permissions]
enabled = true
required = false
poll_interval_seconds = 60
timeout_seconds = 15
max_parallel_queries = 2
```

Two workers are the default. This keeps the total check latency below the
serial path during normal operation while avoiding the API contention and
process spike caused by submitting every verb simultaneously.

The Kubernetes task-health collector applies the same limit to its independent
Pod and Job requests. GPU capacity and Volcano queue ownership remain in
`cluster_gpu_usage`:

```toml
[collectors.kubernetes]
enabled = true
required = false
namespace = "queue-a"
poll_interval_seconds = 60
timeout_seconds = 30
max_parallel_queries = 2
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
| No-job GPUs | Capacity minus running and pending Pod GPU requests |
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
supporting rich GPU Fleet and Workloads UI views. The Workloads query, queue,
state, and sort settings persist through the dashboard's generic `panelState`
preferences.
