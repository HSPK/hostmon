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
KNOWN_TOP_LEVEL = {"monitor", "collectors", "alerts", "history"}
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


@dataclass(frozen=True)
class CollectorSettings:
    name: str
    enabled: bool = True
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
        collectors.append(
            CollectorSettings(name=str(name), enabled=enabled, options=options)
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
        "",
        "[collectors.memory]",
        "enabled = true",
        "",
        "[collectors.disk]",
        "enabled = true",
        'paths = ["/"]',
        "",
        "[collectors.network]",
        "enabled = true",
        'include = ["*"]',
        'exclude = ["lo", "docker*", "veth*", "br-*", "virbr*", "cni*", "flannel*", "cali*"]',
        "",
        "[collectors.gpu]",
        "enabled = true",
        'command = "nvidia-smi"',
        "timeout_seconds = 5",
        "optional = true",
        "",
        "[collectors.pressure]",
        "enabled = true",
        "",
        "[collectors.kubernetes]",
        "enabled = false",
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
        "poll_interval_seconds = 60",
        'kubectl = "kubectl"',
        "timeout_seconds = 15",
        "checks = []",
        "",
        "[history]",
        "enabled = true",
        'directory = "~/.local/state/host-monitor/history"',
        "max_file_mb = 64",
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
            "rate_limit_per_minute = 20",
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
