from __future__ import annotations

import os
import shlex
from pathlib import Path
from typing import Any, Sequence

from expr_tracker.alerts import (
    AlertConfig,
    AlertMessage,
    ChannelConfig,
    Dispatcher,
    WebhookPolicy,
)

from .config import AlertSettings
from .errors import AlertError
from .rules import CapturedAlert


def read_dotenv(
    path: Path, wanted: set[str] | None = None
) -> dict[str, str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise AlertError(f"cannot read alert environment {path}: {error}") from error
    values: dict[str, str] = {}
    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        name, separator, raw_value = stripped.partition("=")
        if not separator:
            continue
        name = name.strip()
        if wanted is not None and name not in wanted:
            continue
        try:
            parsed = shlex.split(raw_value, comments=True, posix=True)
        except ValueError as error:
            raise AlertError(f"invalid environment value at {path}:{line_number}") from error
        if len(parsed) != 1:
            raise AlertError(f"invalid environment value at {path}:{line_number}")
        values[name] = parsed[0]
    return values


def load_alert_environment(settings: AlertSettings) -> None:
    if not settings.env:
        return
    missing = {
        source: target
        for source, target in settings.env.items()
        if not os.environ.get(target)
    }
    if not missing:
        return
    if settings.env_file is None:
        raise AlertError("alerts.env requires alerts.env_file")
    source_values = read_dotenv(settings.env_file, set(missing))
    for source, target in missing.items():
        value = source_values.get(source)
        if not value:
            raise AlertError(f"{source} is missing from {settings.env_file}")
        os.environ[target] = value


class AlertSender:
    def __init__(self, settings: AlertSettings):
        self.settings = settings
        self.dispatcher: Dispatcher | None = None
        self.channel_names: set[str] = {
            str(item.get("name") or item.get("type"))
            for item in settings.channels
            if item.get("name") or item.get("type")
        }
        if not settings.enabled:
            return
        load_alert_environment(settings)
        try:
            channels = [ChannelConfig.from_dict(item) for item in settings.channels]
            for channel in channels:
                if channel.policy is not None:
                    channel.policy.async_send = False
                    channel.policy.fail_silently = False
                    channel.policy.dedup_window = 0
                    channel.policy.rate_limit_per_minute = None
            policy_values = dict(settings.policy)
            policy_values["async_send"] = False
            policy_values["fail_silently"] = False
            policy_values["dedup_window"] = 0
            policy_values["rate_limit_per_minute"] = None
            policy = WebhookPolicy.from_dict(policy_values)
            self.dispatcher = Dispatcher(
                AlertConfig(
                    channels=channels,
                    default_policy=policy,
                    enabled=True,
                )
            )
        except (TypeError, ValueError) as error:
            raise AlertError(f"invalid Expr Tracker alert configuration: {error}") from error
        self.channel_names = set(self.dispatcher.channel_names())
        if not self.channel_names:
            raise AlertError("no alert channels are configured")

    def _validate_channels(self, channels: Sequence[str] | None) -> None:
        if not channels:
            return
        unknown = set(channels) - self.channel_names
        if unknown:
            raise AlertError(f"unknown alert channels: {sorted(unknown)}")

    def validate_channels(self, channels: Sequence[str] | None) -> None:
        self._validate_channels(channels)

    def targets(self, captured: CapturedAlert) -> list[str]:
        if not self.settings.enabled or self.dispatcher is None:
            return []
        self._validate_channels(captured.channels)
        return (
            sorted(set(captured.channels))
            if captured.channels
            else sorted(self.channel_names)
        )

    def send_one(self, message: AlertMessage, channel: str) -> None:
        if not self.settings.enabled or self.dispatcher is None:
            raise AlertError("alerts are disabled in the configuration")
        self._validate_channels([channel])
        try:
            self.dispatcher.send(message, [channel])
        except RuntimeError as error:
            raise AlertError(str(error)) from error

    def send_captured(self, alerts: Sequence[CapturedAlert]) -> int:
        if not alerts:
            return 0
        if not self.settings.enabled or self.dispatcher is None:
            return 0
        for captured in alerts:
            for channel in self.targets(captured):
                self.send_one(captured.message, channel)
        return len(alerts)

    def send_manual(
        self,
        *,
        title: str,
        text: str,
        level: str,
        channels: Sequence[str] | None = None,
    ) -> None:
        if not self.settings.enabled or self.dispatcher is None:
            raise AlertError("alerts are disabled in the configuration")
        self._validate_channels(channels)
        try:
            message = AlertMessage(
                title=title,
                text=text,
                level=level,
                source="manual:hostmon",
            )
            self.dispatcher.send(message, list(channels) if channels else None)
        except (RuntimeError, ValueError) as error:
            raise AlertError(str(error)) from error

    def close(self) -> None:
        if self.dispatcher is not None:
            self.dispatcher.close()
