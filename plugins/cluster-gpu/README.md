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
