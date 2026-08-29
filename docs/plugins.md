# Collector plugin development

hostmon discovers third-party collectors through Python package entry points.
Plugins are regular installable Python distributions; no source changes or
manual imports in hostmon are required.

This guide covers collector plugins. The separate `k9s-plugin.yaml` file is a
K9s UI shortcut that runs `hmon snapshot`; it is not a collector plugin.

## Collector contract

A collector class must:

1. Expose a stable `name` string.
2. Accept one `dict` of TOML options in `__init__`.
3. Implement `collect(previous, now) -> CollectorResult`.

```python
from typing import Any

from host_monitor.collectors.base import CollectorResult


class MyCollector:
    name = "my_collector"

    def __init__(self, options: dict[str, Any]):
        ...

    def collect(
        self,
        previous: dict[str, Any] | None,
        now: float,
    ) -> CollectorResult:
        ...
```

`now` is the current Unix timestamp. `previous` is the JSON state returned by
this collector on the preceding cycle, or `None` on the first cycle.

## CollectorResult

```python
CollectorResult(
    metrics={"thermal/cpu_celsius": 72.5},
    fields={"thermal_sensor": "x86_pkg_temp"},
    state={"at": now, "raw": 72500},
    warnings=[],
    refreshed=True,
)
```

| Field | Requirements | Purpose |
| --- | --- | --- |
| `metrics` | Globally unique names; finite numeric values | History and rule evaluation |
| `fields` | Globally unique names; string, number, bool, or `None` | Alert title/message templates |
| `state` | JSON-serializable object | Caching, rates, and transition state |
| `warnings` | List of human-readable strings | Non-fatal degradation |
| `refreshed` | Boolean; defaults to `True` | Whether this call fetched new source data |

Use slash-separated metric names. Expr Tracker automatically accepts dotted
aliases, so `thermal/cpu_celsius` becomes `thermal.cpu_celsius` in rules.

Raise `ValueError` for invalid configuration and
`host_monitor.errors.CollectorError` for runtime collection failures. Do not
return NaN, infinity, duplicate metric names, or arbitrary objects in fields.

## Package registration

Register the collector under the `host_monitor.collectors` entry-point group:

```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "hostmon-my-collector"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["hostmon>=0.1,<1"]

[project.entry-points."host_monitor.collectors"]
my_collector = "my_package:MyCollector"
```

The entry-point name should match `MyCollector.name`. External plugins cannot
override built-in collector names.

After installation, enable it in hostmon:

```toml
[collectors.my_collector]
enabled = true
required = false
deadline_seconds = 10
max_stale_seconds = 60
device = "/dev/example"
poll_interval_seconds = 30
```

`enabled`, `required`, `deadline_seconds`, and `max_stale_seconds` are consumed
by hostmon. Every other key is passed to the collector constructor.

Collectors run concurrently. A timed-out invocation remains in flight and is
not submitted again until it finishes, preventing an unbounded thread/task
pile-up. Optional collectors can reuse their last valid result within the
configured stale window. Hostmon emits per-collector `up`, `stale`,
`duration_ms`, `last_success_age_seconds`, and `failures_total` metrics.

```bash
python -m pip install hostmon-my-collector
hmon config validate
hmon snapshot
hmon stop
hmon start
```

Restart the daemon after installing a plugin or changing TOML. Alert rules are
reloaded automatically and do not need a restart.

## Configuration validation

Reject unknown options instead of silently ignoring misspellings:

```python
from host_monitor.collectors.base import reject_unknown_options


def __init__(self, options):
    reject_unknown_options(
        self.name,
        options,
        {"path", "scale", "optional"},
    )
```

Validate types and ranges in the constructor. `hmon config validate` loads
every enabled plugin, so bad configuration fails before the daemon starts.

## Caching expensive collectors

The daemon may run every few seconds while an external API should be polled
less frequently. Store the last result and return it until the polling window
expires:

```python
def collect(self, previous, now):
    if (
        isinstance(previous, dict)
        and now - float(previous.get("at", 0)) < self.poll_interval
    ):
        return CollectorResult(
            metrics=dict(previous["metrics"]),
            fields=dict(previous.get("fields", {})),
            state=previous,
            refreshed=False,
        )

    metrics, fields = self.query_remote_api()
    state = {"at": now, "metrics": metrics, "fields": fields}
    return CollectorResult(
        metrics=metrics,
        fields=fields,
        state=state,
    )
```

Cache hits remain healthy but do not advance collector last-refresh timestamps
or replace the measured duration of the most recent real refresh.

## Optional data sources

If a source is intentionally optional, return a warning and no metrics:

```python
try:
    value = read_sensor()
except FileNotFoundError:
    if self.optional:
        return CollectorResult(
            state={"at": now},
            warnings=["sensor is not available"],
        )
    raise CollectorError("sensor is not available")
```

Do not convert genuine failures into success-shaped zero values.

## Complete example

[`examples/thermal-plugin`](../examples/thermal-plugin) is an installable
plugin that reads a Linux thermal-zone file:

```bash
python -m pip install --editable examples/thermal-plugin
python -m unittest discover -s examples/thermal-plugin -p "test_*.py" -v
```

Configuration:

```toml
[collectors.thermal]
enabled = true
path = "/sys/class/thermal/thermal_zone0/temp"
metric = "thermal/cpu_celsius"
scale = 1000
optional = true
```

Rule:

```json
{
  "alert": "high-cpu-temperature",
  "expr": "thermal.cpu_celsius >= 90",
  "title": "CPU temperature high | {host}",
  "message": "Sensor {thermal_sensor_path}: {expr}"
}
```

## Testing recommendations

At minimum, test:

- valid and invalid constructor options;
- first collection without previous state;
- cached and refreshed collections;
- missing optional and required sources;
- numeric metric output;
- JSON serialization of state;
- template field rendering.

Run the plugin tests against the lowest supported hostmon version. Build and
check the distribution before publishing:

```bash
python -m build
python -m twine check dist/*
```
