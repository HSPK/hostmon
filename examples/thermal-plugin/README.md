# hostmon thermal collector example

This example demonstrates a third-party collector registered through the
`host_monitor.collectors` entry-point group.

```bash
python -m pip install --editable .
```

Enable it in hostmon:

```toml
[collectors.thermal]
enabled = true
path = "/sys/class/thermal/thermal_zone0/temp"
metric = "thermal/cpu_celsius"
scale = 1000
optional = true
```

Then run `hmon config validate` and `hmon snapshot`.
