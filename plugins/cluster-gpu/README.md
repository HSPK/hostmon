# Repository-local cluster plugin

This plugin is used by the development deployment and is intentionally
excluded from `hostmon` wheel and source distributions. It is not published as
a separate package.

Install it only in the target host environment:

```bash
uv pip install --python /usr/bin/python3.11 \
  --prefix ~/.local --no-deps --editable plugins/cluster-gpu
```

The complete plugin dashboard is built into:

```text
plugins/cluster-gpu/static/dashboard/
```

Point the local hostmon configuration at the repository files:

```toml
[prometheus]
dashboard_file = "/path/to/repository/plugins/cluster-gpu/dashboard.json"
dashboard_directory = "/path/to/repository/plugins/cluster-gpu/static/dashboard"
```

The collector entry points remain configuration-driven and are available only
after this local editable installation.

GPU workload rows include `submitted_at`, `started_at`, `finished_at` (Unix
seconds, nullable), and `runtime_seconds`. Submission time comes from Job
metadata, not Pod creation time. Start time uses the earliest observed
workload-container start, not Job `status.startTime` (controller acknowledgement); a start
observed in a prior poll is retained only for the same Job UID. Pending jobs
that have never started have no runtime. Completed/failed Job runtime stops
at completion, and terminal GPU Jobs remain listed while their resources exist.
Unknown start/end timestamps remain null rather than implying zero duration.
CPU-only Jobs remain outside this GPU report.

The collector now requires namespace-scoped `list` access to both
`jobs.batch` and `jobs.batch.volcano.sh`, in addition to Pods and Volcano queues.
Query failures surface as collector errors. Allocation/submitter usage still
counts only Running/Pending GPU Pods; completed Jobs do not consume capacity.
RVX receives these fields automatically in the existing
`collectors.cluster_gpu_usage.document.workloads` snapshot array. Runtime is
measured at the collector observation time, not extrapolated by the browser
when collection is stale.
