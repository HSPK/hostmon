from __future__ import annotations

import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any

from .config import Settings, atomic_write_text, config_home
from .errors import ConfigError, ServiceError


UNIT_NAME = "host-monitor.service"


def systemd_user_dir() -> Path:
    return config_home() / "systemd" / "user"


def unit_path() -> Path:
    return systemd_user_dir() / UNIT_NAME


def render_unit(settings: Settings) -> str:
    executable = shlex.quote(sys.executable)
    config = shlex.quote(str(settings.config_file))
    # The Lark backend imports pandas on first send; its BLAS pool is unused here.
    return "\n".join(
        [
            "[Unit]",
            "Description=Lightweight localhost resource monitor",
            "After=network-online.target",
            "Wants=network-online.target",
            "",
            "[Service]",
            "Type=simple",
            f"ExecStart={executable} -m host_monitor --config {config} daemon",
            "Restart=on-failure",
            "RestartSec=5s",
            "Environment=PYTHONUNBUFFERED=1",
            "Environment=OPENBLAS_NUM_THREADS=1",
            "UMask=0077",
            "NoNewPrivileges=true",
            "PrivateTmp=true",
            "",
            "[Install]",
            "WantedBy=default.target",
            "",
        ]
    )


def run_systemctl(*arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    command = ["systemctl", "--user", *arguments]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            text=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise ServiceError(f"cannot run systemctl: {error}") from error
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise ServiceError(f"systemctl {' '.join(arguments)} failed: {detail}")
    return result


def enable_service(settings: Settings) -> Path:
    path = unit_path()
    try:
        atomic_write_text(path, render_unit(settings), mode=0o644)
    except ConfigError as error:
        raise ServiceError(f"cannot install service unit {path}: {error}") from error
    run_systemctl("daemon-reload")
    run_systemctl("enable", UNIT_NAME)
    return path


def start_service() -> None:
    if not unit_path().exists():
        raise ServiceError("service is not installed; run `hmon enable`")
    run_systemctl("start", UNIT_NAME)


def stop_service() -> None:
    run_systemctl("stop", UNIT_NAME)


def restart_service() -> None:
    if not unit_path().exists():
        raise ServiceError("service is not installed; run `hmon enable`")
    run_systemctl("restart", UNIT_NAME)


def disable_service(*, now: bool = False) -> None:
    arguments = ["disable"]
    if now:
        arguments.append("--now")
    arguments.append(UNIT_NAME)
    run_systemctl(*arguments)


def service_status() -> dict[str, Any]:
    result = run_systemctl(
        "show",
        UNIT_NAME,
        "--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus",
        check=False,
    )
    values: dict[str, Any] = {}
    for line in result.stdout.splitlines():
        key, separator, value = line.partition("=")
        if separator:
            values[key] = value
    if not values:
        values = {
            "LoadState": "not-found",
            "ActiveState": "inactive",
            "SubState": "dead",
            "UnitFileState": "disabled",
            "MainPID": "0",
        }
    return values
