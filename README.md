# hostmon

[![CI](https://github.com/HSPK/hostmon/actions/workflows/ci.yml/badge.svg)](https://github.com/HSPK/hostmon/actions/workflows/ci.yml)
[![PyPI](https://img.shields.io/pypi/v/hostmon.svg)](https://pypi.org/project/hostmon/)
[![Python](https://img.shields.io/pypi/pyversions/hostmon.svg)](https://pypi.org/project/hostmon/)

`hostmon` is a lightweight, config-driven monitoring package for Linux hosts.
Its primary CLI is `hmon`. It collects localhost CPU, memory, disk, network,
NVIDIA GPU, and PSI metrics, evaluates [Expr Tracker](https://github.com/HSPK/expr_tracker)
rules, and routes alerts to multiple channels.

Optional Kubernetes collectors monitor workload health, Volcano GPU quota, and
RBAC changes. They do not replace localhost resource metrics with Kubernetes
node metrics.

## Highlights

- No metrics server or database required.
- TOML configuration and hot-reloaded JSON alert rules.
- Lark, Slack, DingTalk, WeCom, generic webhook, and email alerts.
- Persistent rule state with cooldown and recovery notifications.
- Full JSONL history rotated by UTC date and maximum file size.
- Extensible collectors discovered through Python entry points.
- User-level systemd lifecycle and an optional K9s shortcut.

## Quick start

```bash
python3.11 -m pip install hostmon

# Creates a complete config with alerts disabled.
hmon config init
hmon config validate
hmon snapshot

# Install and start the user service.
hmon enable
hmon start
hmon status
```

For Lark, the initializer has a convenience option:

```bash
python3.11 -m pip install "hostmon[lark]"
hmon config init \
  --lark-env-file /path/to/secrets.env \
  --lark-env-key WEBHOOK_URL
```

This is only a convenience path. Lark is not required, and all supported
channels can be configured directly in TOML. See
[`docs/alerts.md`](docs/alerts.md).

## Built-in collectors

| Collector | Source | Representative metrics |
| --- | --- | --- |
| `cpu` | `/proc/stat`, `/proc/loadavg` | `cpu.percent`, `cpu.load1` |
| `memory` | `/proc/meminfo` | `memory.percent`, used/available/swap |
| `disk` | Local filesystems | `disk.percent`, per-path usage |
| `network` | `/proc/net/dev` | aggregate and per-interface Mbps |
| `gpu` | `nvidia-smi` | utilization, memory, temperature, power |
| `pressure` | `/proc/pressure` | CPU, memory, and I/O PSI |
| `kubernetes` | `kubectl` | failed tasks, problem Pods, GPU nodes/quota |
| `kubernetes_permissions` | `kubectl auth can-i` | named RBAC checks by verb |

Metric names use `/`, while Expr Tracker expressions may use dots:

```text
gpu/memory_percent  ->  gpu.memory_percent
```

## CLI

```bash
# Configuration
hmon config path
hmon config show
hmon config validate

# Snapshots and history
hmon snapshot --json
hmon history list
hmon history tail -n 20

# Rules
hmon rules
hmon rules test
hmon rules add high-load 'cpu.load1 > 20' --for 3 --cooldown 1800
hmon rules disable high-load
hmon rules enable high-load
hmon rules remove high-load

# Alerts
hmon alert "manual test" --title "hostmon" --level warning

# User-systemd lifecycle
hmon enable
hmon start
hmon status
hmon stop
hmon disable
hmon disable --now
```

`host-monitor` remains available as a compatibility alias.

## Rules

Rules live in `~/.config/host-monitor/rules.json` and are reloaded every
collection cycle:

```json
{
  "alert": "high-cpu",
  "expr": "mean(cpu.percent[6]) >= 90",
  "level": "warning",
  "title": "High CPU | {host}",
  "message": "Condition: {expr}",
  "for": 3,
  "mode": "level",
  "cooldown": 1800,
  "notify_recovery": true,
  "channels": ["slack-ops", "email-oncall"]
}
```

Rules support arithmetic, boolean expressions, windows, edge/level modes,
cooldowns, channel routing, and recovery notifications. See
[`docs/alerts.md`](docs/alerts.md).

## Collector plugins

Third-party packages can add collectors without changing hostmon. A plugin
implements:

```python
collect(previous, now) -> CollectorResult
```

and registers an entry point in the `host_monitor.collectors` group. The
repository includes an installable thermal sensor example:

```bash
python -m pip install --editable examples/thermal-plugin
```

See [`docs/plugins.md`](docs/plugins.md) for the complete API, packaging,
configuration, state, template fields, validation, and testing guide.

## Configuration and storage

Default locations:

| Purpose | Path |
| --- | --- |
| Configuration | `~/.config/host-monitor/config.toml` |
| Rules | `~/.config/host-monitor/rules.json` |
| Runtime state | `~/.local/state/host-monitor/state.json` |
| Long-term history | `~/.local/state/host-monitor/history/` |
| User service | `~/.config/systemd/user/host-monitor.service` |

Complete samples are written as
`metrics-YYYY-MM-DD-NNNN.jsonl`. A new file is created when the UTC date
changes or the configured size limit is reached. Files are not automatically
deleted.

## Architecture

```text
collectors / external entry points
              |
              v
      numeric metrics + template fields
              |
       Expr Tracker rule engine
              |
       channel-aware AlertSender
              |
 Lark / Slack / DingTalk / WeCom / webhook / email

Full samples -> segmented JSONL history
Rule window  -> bounded atomic runtime state
```

## K9s integration

K9s is only a UI shortcut to the localhost CLI. It does not participate in
collection:

```bash
mkdir -p ~/.config/k9s/plugins
cp k9s-plugin.yaml ~/.config/k9s/plugins/localhost-resource-monitor.yaml
```

Press `Shift-M` in any K9s view to run `hmon snapshot`.

## Development

```bash
python3.11 -m pip install --editable ".[dev]"
python3.11 -m unittest discover -s tests -v
python3.11 -m build
python3.11 -m twine check dist/*
```

Release instructions are in [`RELEASING.md`](RELEASING.md).
