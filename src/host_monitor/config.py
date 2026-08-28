from __future__ import annotations

import json
import os
import tempfile
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .errors import ConfigError


APP_NAME = "host-monitor"
CONFIG_ENV = "HOST_MONITOR_CONFIG"
KNOWN_TOP_LEVEL = {"monitor", "collectors", "alerts", "history", "prometheus"}
KNOWN_MONITOR_KEYS = {
    "interval_seconds",
    "snapshot_seconds",
    "history_size",
    "state_file",
    "rules_file",
    "hostname",
}
KNOWN_ALERT_KEYS = {"enabled", "env_file", "env", "channels", "policy"}
KNOWN_HISTORY_KEYS = {"enabled", "directory", "max_file_mb"}
KNOWN_PROMETHEUS_KEYS = {
    "enabled",
    "host",
    "port",
    "max_sample_age_seconds",
    "dashboard_file",
}
REQUIRED_COLLECTORS = {"cpu", "memory", "disk", "network"}


@dataclass(frozen=True)
class CollectorSettings:
    name: str
    enabled: bool = True
    required: bool = False
    deadline_seconds: float = 30.0
    max_stale_seconds: float = 300.0
    options: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AlertSettings:
    enabled: bool
    env_file: Path | None
    env: dict[str, str]
    channels: tuple[dict[str, Any], ...]
    policy: dict[str, Any]


@dataclass(frozen=True)
class HistorySettings:
    enabled: bool
    directory: Path
    max_file_bytes: int


@dataclass(frozen=True)
class PrometheusSettings:
    enabled: bool
    host: str
    port: int
    max_sample_age_seconds: float
    dashboard_file: Path | None = None


@dataclass(frozen=True)
class Settings:
    config_file: Path
    interval_seconds: float
    snapshot_seconds: float
    history_size: int
    state_file: Path
    rules_file: Path
    hostname: str
    collectors: tuple[CollectorSettings, ...]
    alerts: AlertSettings
    history: HistorySettings
    prometheus: PrometheusSettings


def config_home() -> Path:
    return Path(
        os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    ).expanduser()


def state_home() -> Path:
    return Path(
        os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local" / "state"))
    ).expanduser()


def default_config_path() -> Path:
    configured = os.environ.get(CONFIG_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    return config_home() / APP_NAME / "config.toml"


def resolve_config_path(path: str | Path | None) -> Path:
    return (
        Path(path).expanduser().resolve()
        if path is not None
        else default_config_path()
    )


def _resolve_path(value: Any, base: Path, default: Path) -> Path:
    if value in (None, ""):
        return default.expanduser()
    path = Path(str(value)).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def _positive_number(name: str, value: Any, minimum: float = 0.0) -> float:
    if isinstance(value, bool):
        raise ConfigError(f"{name} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ConfigError(f"{name} must be a number, got {value!r}") from error
    if number <= minimum:
        raise ConfigError(f"{name} must be greater than {minimum}")
    return number


def _positive_int(name: str, value: Any, minimum: int = 0) -> int:
    if isinstance(value, bool):
        raise ConfigError(f"{name} must be an integer")
    try:
        number = int(value)
    except (TypeError, ValueError) as error:
        raise ConfigError(f"{name} must be an integer, got {value!r}") from error
    if number <= minimum:
        raise ConfigError(f"{name} must be greater than {minimum}")
    return number


def _nonnegative_number(name: str, value: Any) -> float:
    if isinstance(value, bool):
        raise ConfigError(f"{name} must be a number")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ConfigError(f"{name} must be a number, got {value!r}") from error
    if number < 0:
        raise ConfigError(f"{name} must not be negative")
    return number


def _mapping(name: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError(f"{name} must be a TOML table")
    return value


def load_settings(path: str | Path | None = None) -> Settings:
    config_file = resolve_config_path(path)
    try:
        payload = tomllib.loads(config_file.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ConfigError(
            f"configuration not found: {config_file}; run `hmon config init`"
        ) from error
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ConfigError(f"cannot read configuration {config_file}: {error}") from error
    if not isinstance(payload, dict):
        raise ConfigError("configuration root must be a TOML table")
    unknown = set(payload) - KNOWN_TOP_LEVEL
    if unknown:
        raise ConfigError(f"unknown top-level configuration keys: {sorted(unknown)}")

    base = config_file.parent
    monitor = _mapping("monitor", payload.get("monitor", {}))
    unknown = set(monitor) - KNOWN_MONITOR_KEYS
    if unknown:
        raise ConfigError(f"unknown monitor options: {sorted(unknown)}")
    interval = _positive_number(
        "monitor.interval_seconds", monitor.get("interval_seconds", 10)
    )
    snapshot = _positive_number(
        "monitor.snapshot_seconds", monitor.get("snapshot_seconds", 1)
    )
    history_size = _positive_int(
        "monitor.history_size", monitor.get("history_size", 360), 1
    )
    default_state = state_home() / APP_NAME / "state.json"
    state_file = _resolve_path(monitor.get("state_file"), base, default_state)
    rules_file = _resolve_path(
        monitor.get("rules_file", "rules.json"),
        base,
        base / "rules.json",
    )
    hostname = str(monitor.get("hostname", "")).strip()

    raw_collectors = _mapping("collectors", payload.get("collectors", {}))
    collectors: list[CollectorSettings] = []
    for name, raw_options in raw_collectors.items():
        options = _mapping(f"collectors.{name}", raw_options).copy()
        enabled = options.pop("enabled", True)
        if not isinstance(enabled, bool):
            raise ConfigError(f"collectors.{name}.enabled must be true or false")
        required = options.pop("required", name in REQUIRED_COLLECTORS)
        if not isinstance(required, bool):
            raise ConfigError(f"collectors.{name}.required must be true or false")
        raw_timeout = options.get("timeout_seconds", 3)
        try:
            default_deadline = min(
                max(1.0, interval / 2.0),
                max(1.0, float(raw_timeout) + 2.0),
            )
        except (TypeError, ValueError) as error:
            raise ConfigError(
                f"collectors.{name}.timeout_seconds must be a number"
            ) from error
        deadline = _positive_number(
            f"collectors.{name}.deadline_seconds",
            options.pop("deadline_seconds", default_deadline),
        )
        max_stale = _nonnegative_number(
            f"collectors.{name}.max_stale_seconds",
            options.pop(
                "max_stale_seconds",
                0 if required else max(300.0, interval * 3),
            ),
        )
        collectors.append(
            CollectorSettings(
                name=str(name),
                enabled=enabled,
                required=required,
                deadline_seconds=deadline,
                max_stale_seconds=max_stale,
                options=options,
            )
        )
    enabled_collectors = [item for item in collectors if item.enabled]
    if not enabled_collectors:
        raise ConfigError("at least one collector must be enabled")

    raw_alerts = _mapping("alerts", payload.get("alerts", {}))
    unknown = set(raw_alerts) - KNOWN_ALERT_KEYS
    if unknown:
        raise ConfigError(f"unknown alert options: {sorted(unknown)}")
    alerts_enabled = raw_alerts.get("enabled", False)
    if not isinstance(alerts_enabled, bool):
        raise ConfigError("alerts.enabled must be true or false")
    raw_env_file = raw_alerts.get("env_file")
    env_file = (
        _resolve_path(raw_env_file, base, base)
        if raw_env_file not in (None, "")
        else None
    )
    raw_env = _mapping("alerts.env", raw_alerts.get("env", {}))
    env = {str(source): str(target) for source, target in raw_env.items()}
    raw_channels = raw_alerts.get("channels", [])
    if not isinstance(raw_channels, list) or not all(
        isinstance(item, dict) for item in raw_channels
    ):
        raise ConfigError("alerts.channels must be an array of tables")
    channels = tuple(dict(item) for item in raw_channels)
    policy = dict(_mapping("alerts.policy", raw_alerts.get("policy", {})))
    if alerts_enabled and not channels:
        raise ConfigError("alerts.enabled requires at least one alerts.channels entry")

    raw_history = _mapping("history", payload.get("history", {}))
    unknown = set(raw_history) - KNOWN_HISTORY_KEYS
    if unknown:
        raise ConfigError(f"unknown history options: {sorted(unknown)}")
    history_enabled = raw_history.get("enabled", True)
    if not isinstance(history_enabled, bool):
        raise ConfigError("history.enabled must be true or false")
    history_directory = _resolve_path(
        raw_history.get("directory"),
        base,
        state_home() / APP_NAME / "history",
    )
    max_file_mb = _positive_number(
        "history.max_file_mb", raw_history.get("max_file_mb", 64)
    )
    max_file_bytes = max(1, int(max_file_mb * 1024 * 1024))

    raw_prometheus = _mapping("prometheus", payload.get("prometheus", {}))
    unknown = set(raw_prometheus) - KNOWN_PROMETHEUS_KEYS
    if unknown:
        raise ConfigError(f"unknown prometheus options: {sorted(unknown)}")
    prometheus_enabled = raw_prometheus.get("enabled", False)
    if not isinstance(prometheus_enabled, bool):
        raise ConfigError("prometheus.enabled must be true or false")
    prometheus_host = str(raw_prometheus.get("host", "127.0.0.1")).strip()
    if not prometheus_host:
        raise ConfigError("prometheus.host must be non-empty")
    prometheus_port = _positive_int(
        "prometheus.port", raw_prometheus.get("port", 9108)
    )
    if prometheus_port > 65535:
        raise ConfigError("prometheus.port must not exceed 65535")
    max_sample_age = _positive_number(
        "prometheus.max_sample_age_seconds",
        raw_prometheus.get(
            "max_sample_age_seconds",
            max(30.0, interval * 3),
        ),
    )
    raw_dashboard_file = raw_prometheus.get("dashboard_file")
    dashboard_file = (
        _resolve_path(raw_dashboard_file, base, base / "dashboard.json")
        if raw_dashboard_file not in (None, "")
        else None
    )

    return Settings(
        config_file=config_file,
        interval_seconds=interval,
        snapshot_seconds=snapshot,
        history_size=history_size,
        state_file=state_file,
        rules_file=rules_file,
        hostname=hostname,
        collectors=tuple(collectors),
        alerts=AlertSettings(
            enabled=alerts_enabled,
            env_file=env_file,
            env=env,
            channels=channels,
            policy=policy,
        ),
        history=HistorySettings(
            enabled=history_enabled,
            directory=history_directory,
            max_file_bytes=max_file_bytes,
        ),
        prometheus=PrometheusSettings(
            enabled=prometheus_enabled,
            host=prometheus_host,
            port=prometheus_port,
            max_sample_age_seconds=max_sample_age,
            dashboard_file=dashboard_file,
        ),
    )


def render_default_config(
    *,
    env_file: str | Path | None = None,
    env_key: str = "WEBHOOK_URL",
    env_target: str = "ET_LARK_WEBHOOK_URL",
) -> str:
    alert_enabled = env_file is not None
    lines = [
        "[monitor]",
        "interval_seconds = 10",
        "snapshot_seconds = 1",
        "history_size = 360",
        'state_file = "~/.local/state/host-monitor/state.json"',
        'rules_file = "rules.json"',
        'hostname = ""',
        "",
        "[collectors.cpu]",
        "enabled = true",
        "required = true",
        "",
        "[collectors.memory]",
        "enabled = true",
        "required = true",
        "",
        "[collectors.disk]",
        "enabled = true",
        "required = true",
        'paths = ["/"]',
        "",
        "[collectors.network]",
        "enabled = true",
        "required = true",
        'include = ["*"]',
        'exclude = ["lo", "docker*", "veth*", "br-*", "virbr*", "cni*", "flannel*", "cali*"]',
        "",
        "[collectors.gpu]",
        "enabled = true",
        "required = false",
        "deadline_seconds = 7",
        "max_stale_seconds = 300",
        'command = "nvidia-smi"',
        "timeout_seconds = 5",
        "optional = true",
        "",
        "[collectors.pressure]",
        "enabled = true",
        "required = false",
        "",
        "[collectors.kubernetes]",
        "enabled = false",
        "required = false",
        "deadline_seconds = 5",
        "max_stale_seconds = 300",
        'context = ""',
        'namespace = ""',
        'queue = ""',
        'gpu_resource = "nvidia.com/gpu"',
        "gpus_per_node = 8",
        "poll_interval_seconds = 60",
        'kubectl = "kubectl"',
        "timeout_seconds = 30",
        "",
        "[collectors.kubernetes_permissions]",
        "enabled = false",
        "required = false",
        "deadline_seconds = 5",
        "max_stale_seconds = 300",
        "poll_interval_seconds = 60",
        'kubectl = "kubectl"',
        "timeout_seconds = 15",
        "checks = []",
        "",
        "[collectors.cluster_gpu_usage]",
        "enabled = false",
        "required = false",
        "deadline_seconds = 5",
        "max_stale_seconds = 300",
        'context = ""',
        'queues = ["queue-a", "queue-b"]',
        'gpu_resource = "nvidia.com/gpu"',
        "gpus_per_node = 8",
        "poll_interval_seconds = 60",
        'kubectl = "kubectl"',
        "timeout_seconds = 30",
        "",
        "[history]",
        "enabled = true",
        'directory = "~/.local/state/host-monitor/history"',
        "max_file_mb = 64",
        "",
        "[prometheus]",
        "enabled = false",
        'host = "127.0.0.1"',
        "port = 9108",
        "max_sample_age_seconds = 30",
        "",
        "[alerts]",
        f"enabled = {'true' if alert_enabled else 'false'}",
    ]
    if env_file is not None:
        lines.append(f"env_file = {json.dumps(str(Path(env_file).expanduser()))}")
        lines.extend(
            [
                "",
                "[alerts.env]",
                f"{env_key} = {json.dumps(env_target)}",
                "",
                "[[alerts.channels]]",
                'type = "lark"',
                'name = "lark"',
                f"url_env = {json.dumps(env_target)}",
                'min_level = "info"',
            ]
        )
    lines.extend(
        [
            "",
            "[alerts.policy]",
            "timeout = 10",
            "max_retries = 3",
            "backoff_initial = 0.5",
            "backoff_factor = 2",
            "backoff_max = 15",
            "dedup_window = 0",
            "async_send = false",
            "queue_size = 100",
            'on_queue_full = "drop_oldest"',
            "fail_silently = false",
            "",
        ]
    )
    return "\n".join(lines)


def atomic_write_text(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", delete=False, dir=path.parent, encoding="utf-8"
        ) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, mode)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as error:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        raise ConfigError(f"cannot write {path}: {error}") from error


def _render_prometheus_section(settings: PrometheusSettings) -> str:
    lines = [
            "[prometheus]",
            f"enabled = {'true' if settings.enabled else 'false'}",
            f"host = {json.dumps(settings.host)}",
            f"port = {settings.port}",
            f"max_sample_age_seconds = {settings.max_sample_age_seconds:g}",
    ]
    if settings.dashboard_file is not None:
        lines.append(f"dashboard_file = {json.dumps(str(settings.dashboard_file))}")
    lines.append("")
    return "\n".join(lines)


def _replace_toml_section(text: str, name: str, replacement: str) -> str:
    lines = text.splitlines(keepends=True)
    starts = [
        index
        for index, line in enumerate(lines)
        if line.partition("#")[0].strip() == f"[{name}]"
    ]
    if len(starts) > 1:
        raise ConfigError(f"configuration contains multiple [{name}] sections")
    if not starts:
        separator = "" if not text or text.endswith("\n\n") else "\n"
        return f"{text}{separator}{replacement}"
    start = starts[0]
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].lstrip().startswith("["):
            end = index
            break
    replacement_lines = replacement.splitlines(keepends=True)
    return "".join(lines[:start] + replacement_lines + lines[end:])


def update_prometheus_config(
    path: str | Path | None = None,
    *,
    enabled: bool | None = None,
    host: str | None = None,
    port: int | None = None,
    max_sample_age_seconds: float | None = None,
) -> Settings:
    settings = load_settings(path)
    current = settings.prometheus
    resolved_enabled = current.enabled if enabled is None else enabled
    resolved_host = current.host if host is None else str(host).strip()
    resolved_port = current.port if port is None else port
    resolved_max_age = (
        current.max_sample_age_seconds
        if max_sample_age_seconds is None
        else max_sample_age_seconds
    )
    if not isinstance(resolved_enabled, bool):
        raise ConfigError("prometheus.enabled must be true or false")
    if not resolved_host:
        raise ConfigError("prometheus.host must be non-empty")
    if (
        isinstance(resolved_port, bool)
        or not isinstance(resolved_port, int)
        or not 1 <= resolved_port <= 65535
    ):
        raise ConfigError("prometheus.port must be between 1 and 65535")
    if (
        isinstance(resolved_max_age, bool)
        or not isinstance(resolved_max_age, (int, float))
        or resolved_max_age <= 0
    ):
        raise ConfigError("prometheus.max_sample_age_seconds must be positive")
    updated = PrometheusSettings(
        enabled=resolved_enabled,
        host=resolved_host,
        port=resolved_port,
        max_sample_age_seconds=float(resolved_max_age),
        dashboard_file=current.dashboard_file,
    )
    try:
        text = settings.config_file.read_text(encoding="utf-8")
    except OSError as error:
        raise ConfigError(
        f"cannot read configuration {settings.config_file}: {error}"
        ) from error
    candidate = _replace_toml_section(
        text,
        "prometheus",
        _render_prometheus_section(updated),
    )
    try:
        tomllib.loads(candidate)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"updated configuration is invalid: {error}") from error
    atomic_write_text(settings.config_file, candidate)
    return load_settings(settings.config_file)


def initialize_config(
    path: str | Path | None = None,
    *,
    force: bool = False,
    env_file: str | Path | None = None,
    env_key: str = "WEBHOOK_URL",
    env_target: str = "ET_LARK_WEBHOOK_URL",
) -> Path:
    config_file = resolve_config_path(path)
    if config_file.exists() and not force:
        raise ConfigError(f"configuration already exists: {config_file}")
    content = render_default_config(
        env_file=env_file,
        env_key=env_key,
        env_target=env_target,
    )
    atomic_write_text(config_file, content)
    return config_file
