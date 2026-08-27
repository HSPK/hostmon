# Prometheus and Grafana

hostmon includes a dependency-free HTTP exporter backed by the atomically
written runtime state. Scraping does not enter or block the collection loop.

## Enable the exporter

```toml
[prometheus]
enabled = true
host = "127.0.0.1"
port = 9108
max_sample_age_seconds = 30
```

Restart the service after changing TOML:

```bash
hmon stop
hmon start
```

## Endpoints

| Endpoint | Response |
| --- | --- |
| `/metrics` | Prometheus text exposition |
| `/healthz` | HTTP 200 for a fresh sample, HTTP 503 for a stale/unavailable sample |
| `/api/status` | Latest metrics and non-numeric template fields as JSON |

```bash
curl http://127.0.0.1:9108/healthz
curl http://127.0.0.1:9108/metrics
curl http://127.0.0.1:9108/api/status
```

## Prometheus scrape configuration

For Prometheus running on the same host:

```yaml
scrape_configs:
  - job_name: hostmon
    scrape_interval: 10s
    static_configs:
      - targets: ["127.0.0.1:9108"]
```

Representative metric names:

| hostmon metric | Prometheus metric |
| --- | --- |
| `cpu/percent` | `hostmon_cpu_percent` |
| `memory/percent` | `hostmon_memory_percent` |
| `disk/percent` | `hostmon_disk_percent` |
| `network/rx_mbps` | `hostmon_network_rx_mbps` |
| `gpu/percent` | `hostmon_gpu_percent` |
| `k8s/occupied_gpu_nodes` | `hostmon_k8s_occupied_gpu_nodes` |
| `monitor/collector/cpu/up` | `hostmon_monitor_collector_cpu_up` |

Names are sanitized deterministically. If two source names sanitize to the
same Prometheus name, hostmon adds a stable hash suffix rather than silently
overwriting one value.

Useful Grafana queries:

```promql
hostmon_cpu_percent
hostmon_memory_percent
hostmon_gpu_percent
hostmon_k8s_occupied_gpu_nodes / hostmon_k8s_quota_nodes
hostmon_monitor_collector_kubernetes_up
hostmon_sample_age_seconds
```

Non-numeric fields such as failed or stopped task names are intentionally not
converted to Prometheus labels, which avoids unbounded cardinality. Read them
from `/api/status`.

## Remote Prometheus

The default listener is loopback-only and has no authentication. For a remote
Prometheus instance, use one of:

1. An SSH, Chisel, or VPN tunnel to `127.0.0.1:9108`.
2. A trusted private interface plus firewall rules.
3. A local Prometheus agent that remote-writes to the central server.

Do not bind the exporter to a public interface without network-level access
control.
