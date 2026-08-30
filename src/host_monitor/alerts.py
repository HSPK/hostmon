from __future__ import annotations

import json
import os
import shlex
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence

from expr_tracker.alerts import (
    AlertConfig,
    AlertLevel,
    AlertMessage,
    ChannelConfig,
    Dispatcher,
    WebhookPolicy,
)
from expr_tracker.alerts.backends import (
    AlertBackend,
    LarkBackend as ExprTrackerLarkBackend,
    SendError,
    post_json,
    register_backend,
    render_text,
)

from .config import AlertSettings
from .errors import AlertError
from .rules import CapturedAlert


LARK_TIMEZONE = timezone(timedelta(hours=8))
LARK_LEVEL_EMOJI = {
    AlertLevel.DEBUG: "\U0001f50d",
    AlertLevel.INFO: "\u2139\ufe0f",
    AlertLevel.WARNING: "\u26a0\ufe0f",
    AlertLevel.ERROR: "\u274c",
    AlertLevel.CRITICAL: "\U0001f6a8",
}


def _lark_heading(content: str) -> dict[str, Any]:
    return {
        "tag": "column_set",
        "flex_mode": "none",
        "background_style": "default",
        "horizontal_spacing": "default",
        "horizontal_align": "left",
        "columns": [
            {
                "tag": "column",
                "background_style": "default",
                "elements": [
                    {
                        "tag": "div",
                        "text": {
                            "tag": "plain_text",
                            "content": content,
                            "text_size": "heading",
                            "text_align": "left",
                            "text_color": "default",
                        },
                    }
                ],
                "width": "auto",
                "weight": 1,
                "vertical_align": "top",
                "vertical_spacing": "default",
            }
        ],
    }


def _lark_markdown(content: str) -> dict[str, str]:
    return {
        "tag": "markdown",
        "content": content,
        "text_align": "left",
        "text_size": "normal",
    }


def _lark_payload(message: AlertMessage) -> dict[str, Any]:
    title = f"{LARK_LEVEL_EMOJI.get(message.level, '')} {message.title}".strip()
    subtitle = message.subtitle or datetime.now(LARK_TIMEZONE).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    elements = [
        _lark_heading("Message"),
        _lark_markdown(f"```txt\n{render_text(message)}\n```"),
    ]
    if message.level in (AlertLevel.ERROR, AlertLevel.CRITICAL):
        elements.extend(
            [
                _lark_heading("Traceback"),
                _lark_markdown(
                    f"```\n{(message.traceback or '').strip()}\n```"
                ),
            ]
        )
    return {
        "msg_type": "interactive",
        "card": {
            "elements": elements,
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "subtitle": {"tag": "plain_text", "content": subtitle},
                "template": (
                    "red"
                    if message.level in (AlertLevel.ERROR, AlertLevel.CRITICAL)
                    else "green"
                ),
                "ud_icon": {
                    "token": (
                        "error_filled"
                        if message.level in (
                            AlertLevel.ERROR,
                            AlertLevel.CRITICAL,
                        )
                        else "yes_filled"
                    )
                },
            },
        },
    }


class LightweightLarkBackend(AlertBackend):
    type = "lark"

    def __init__(self, config: ChannelConfig):
        super().__init__(config)
        self.fallback = (
            ExprTrackerLarkBackend(config)
            if set(config.options) - {"headers"}
            else None
        )

    def validate(self) -> None:
        if self.fallback is not None:
            self.fallback.validate()
            return
        if not self.config.resolve_url():
            raise ValueError(
                f"Channel {self.config.name!r} (lark) has no webhook URL; "
                "set 'url' or 'url_env'."
            )
        headers = self.config.options.get("headers")
        if headers is not None and not isinstance(headers, dict):
            raise ValueError("Lark channel options.headers must be an object")

    def send(self, message: AlertMessage) -> None:
        if self.fallback is not None:
            self.fallback.send(message)
            return
        url = self.config.resolve_url()
        if not url:
            raise SendError(
                f"Channel {self.config.name!r} has no webhook URL",
                retryable=False,
            )
        timeout = (
            self.config.policy.timeout
            if self.config.policy is not None
            else 10.0
        )
        body = post_json(
            url,
            _lark_payload(message),
            timeout,
            self.config.options.get("headers"),
        )
        try:
            response = json.loads(body)
            code = int(response["code"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            raise SendError(
                f"Lark webhook returned an invalid response: {error}"
            ) from error
        if code != 0:
            raise SendError(
                f"Lark webhook failed: code={code} msg={response.get('msg')!r}"
            )


register_backend("lark", LightweightLarkBackend)


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
