from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Sequence

from . import __version__
from .alerts import AlertSender
from .collectors import build_collectors
from .config import (
    Settings,
    initialize_config,
    load_settings,
    resolve_config_path,
    update_prometheus_config,
)
from .errors import MonitorError, ServiceError
from .history import HistoryReader, HistoryWriter, migrate_rolling_state
from .outbox import OutboxStore
from .rules import RuleStore, inspect_rules, write_default_rules
from .runtime import capture_snapshot, run_daemon
from .service import (
    UNIT_NAME,
    disable_service,
    enable_service,
    restart_service,
    service_status,
    start_service,
    stop_service,
)
from .state import StateStore


def configure_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def print_json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def command_config(args: argparse.Namespace) -> int:
    path = resolve_config_path(args.config)
    if args.config_action == "path":
        print(path)
        return 0
    if args.config_action == "init":
        config_file = initialize_config(
            path,
            force=args.force,
            env_file=args.lark_env_file,
            env_key=args.lark_env_key,
        )
        settings = load_settings(config_file)
        write_default_rules(settings.rules_file, force=args.force)
        print(f"configuration={config_file}")
        print(f"rules={settings.rules_file}")
        return 0

    settings = load_settings(path)
    rules = RuleStore(settings.rules_file).load()
    if args.config_action == "show":
        print_json(
            {
                "config_file": str(settings.config_file),
                "state_file": str(settings.state_file),
                "rules_file": str(settings.rules_file),
                "interval_seconds": settings.interval_seconds,
                "snapshot_seconds": settings.snapshot_seconds,
                "history_size": settings.history_size,
                "hostname": settings.hostname or "auto",
                "collectors": [
                    {"name": item.name, "enabled": item.enabled}
                    for item in settings.collectors
                ],
                "alerts": {
                    "enabled": settings.alerts.enabled,
                    "channels": [
                        item.get("name", item.get("type", "unknown"))
                        for item in settings.alerts.channels
                    ],
                    "env_file": str(settings.alerts.env_file)
                    if settings.alerts.env_file
                    else None,
                },
                "rule_count": len(rules),
                "history": {
                    "enabled": settings.history.enabled,
                    "directory": str(settings.history.directory),
                    "max_file_bytes": settings.history.max_file_bytes,
                },
                "prometheus": {
                    "enabled": settings.prometheus.enabled,
                    "host": settings.prometheus.host,
                    "port": settings.prometheus.port,
                    "max_sample_age_seconds": (
                        settings.prometheus.max_sample_age_seconds
                    ),
                },
            }
        )
        return 0
    build_collectors(settings.collectors)
    sender = AlertSender(settings.alerts)
    try:
        for rule in rules:
            sender.validate_channels(rule.channels)
    finally:
        sender.close()
    print(
        f"configuration valid: collectors="
        f"{sum(item.enabled for item in settings.collectors)} rules={len(rules)} "
        f"alerts={'enabled' if settings.alerts.enabled else 'disabled'}"
    )
    return 0


def rule_dict_from_args(args: argparse.Namespace) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "alert": args.name,
        "expr": args.expression,
        "level": args.level,
        "mode": args.mode,
        "for": args.for_steps,
        "cooldown": args.cooldown,
        "notify_recovery": args.notify_recovery,
        "enabled": True,
    }
    if args.title:
        entry["title"] = args.title
    if args.message:
        entry["message"] = args.message
    if args.channel:
        entry["channels"] = list(args.channel)
    return entry


def print_rules(store: RuleStore, as_json: bool) -> None:
    rules = store.load()
    if as_json:
        print_json(
            [
                {
                    "name": rule.name,
                    "expression": rule.condition,
                    "level": rule.level.value,
                    "mode": rule.mode,
                    "for_steps": rule.for_steps,
                    "cooldown": rule.cooldown,
                    "enabled": rule.enabled,
                    "channels": rule.channels,
                }
                for rule in rules
            ]
        )
        return
    print("NAME\tENABLED\tLEVEL\tFOR\tMODE\tEXPRESSION")
    for rule in rules:
        print(
            f"{rule.name}\t{str(rule.enabled).lower()}\t{rule.level.value}\t"
            f"{rule.for_steps}\t{rule.mode}\t{rule.condition}"
        )


def command_rules(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    store = RuleStore(settings.rules_file)
    action = args.rules_action or "list"
    if action == "list":
        print_rules(store, args.json)
    elif action == "validate":
        rules = store.load()
        print(f"rules valid: {len(rules)}")
    elif action == "add":
        rule = store.add(rule_dict_from_args(args))
        print(f"rule added: {rule.name}")
    elif action == "remove":
        store.remove(args.name)
        print(f"rule removed: {args.name}")
    elif action in {"enable", "disable"}:
        enabled = action == "enable"
        store.set_enabled(args.name, enabled)
        print(f"rule {action}d: {args.name}")
    elif action == "test":
        collection = capture_snapshot(settings)
        results = inspect_rules(store.load(), collection.metrics)
        if args.json:
            print_json({"metrics": collection.metrics, "rules": results})
        else:
            for item in results:
                print(
                    f"{item['name']}: {item['result']} | {item['expression']}"
                )
    return 0


def command_snapshot(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    collection = capture_snapshot(settings)
    payload = {
        "metrics": collection.metrics,
        "fields": collection.fields,
        "warnings": collection.warnings,
    }
    if args.json:
        print_json(payload)
    else:
        for name, value in sorted(collection.metrics.items()):
            print(f"{name}={value:.6g}")
        for name, value in sorted(collection.fields.items()):
            print(f"{name}={value}")
        for warning in collection.warnings:
            print(f"WARNING: {warning}", file=sys.stderr)
    return 0


def command_alert(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    sender = AlertSender(settings.alerts)
    try:
        sender.send_manual(
            title=args.title,
            text=args.message,
            level=args.level,
            channels=args.channel,
        )
    finally:
        sender.close()
    print("alert sent")
    return 0


def command_enable(args: argparse.Namespace) -> int:
    path = resolve_config_path(args.config)
    if not path.exists():
        initialize_config(path)
        settings = load_settings(path)
        write_default_rules(settings.rules_file)
        print(f"created default configuration with alerts disabled: {path}")
    settings = load_settings(path)
    RuleStore(settings.rules_file).load()
    build_collectors(settings.collectors)
    unit = enable_service(settings)
    print(f"enabled {UNIT_NAME}: {unit}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    status = service_status()
    path = resolve_config_path(args.config)
    state: dict[str, Any] | None = None
    outbox_pending: int | None = None
    if path.exists():
        settings = load_settings(path)
        state = StateStore(settings.state_file).load()
        outbox = OutboxStore(settings.state_file.with_name("reliability.db"))
        try:
            outbox_pending = outbox.pending_count()
        finally:
            outbox.close()
    payload = {
        "service": {
            "load": status.get("LoadState"),
            "active": status.get("ActiveState"),
            "sub": status.get("SubState"),
            "enabled": status.get("UnitFileState"),
            "pid": int(status.get("MainPID") or 0),
        },
        "last_sample": (
            {
                "host": state.get("host"),
                "updated_at": state.get("updated_at"),
                "metrics": state.get("last_metrics", {}),
                "fields": state.get("last_fields", {}),
                "history_file": state.get("last_history_file"),
            }
            if state and state.get("updated_at")
            else None
        ),
        "reliability": {
            "outbox_pending": outbox_pending,
        },
    }
    if args.json:
        print_json(payload)
    else:
        service = payload["service"]
        print(
            f"service={service['active']}/{service['sub']} "
            f"enabled={service['enabled']} pid={service['pid']}"
        )
        if payload["last_sample"]:
            sample = payload["last_sample"]
            print(
                f"last_sample host={sample['host']} updated_at={sample['updated_at']}"
            )
            for name, value in sorted(sample["metrics"].items()):
                print(f"{name}={value:.6g}")
            for name, value in sorted(sample["fields"].items()):
                print(f"{name}={value}")
        print(f"outbox_pending={outbox_pending if outbox_pending is not None else '-'}")
    return 0


def command_history(args: argparse.Namespace) -> int:
    settings = load_settings(args.config)
    reader = HistoryReader(settings.history)
    action = args.history_action or "list"
    if action == "list":
        files = reader.list_files()
        if args.json:
            print_json(files)
        else:
            print("DATE\tPART\tBYTES\tPATH")
            for item in files:
                print(
                    f"{item['date']}\t{item['part']:04d}\t{item['bytes']}\t"
                    f"{item['path']}"
                )
        return 0
    if action == "tail":
        rows = reader.tail(args.count, args.date)
        if args.json:
            print_json(rows)
        else:
            for row in rows:
                print(json.dumps(row, ensure_ascii=False, sort_keys=True))
        return 0
    if action == "migrate-state":
        count = migrate_rolling_state(
            HistoryWriter(settings.history),
            StateStore(settings.state_file),
        )
        print(f"migrated_samples={count}")
        return 0
    raise MonitorError(f"unsupported history action: {action}")


def prometheus_url(settings: Settings, path: str = "/healthz") -> str:
    host = settings.prometheus.host
    if host in {"0.0.0.0", "::", "[::]"}:
        host = "127.0.0.1"
    elif ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"http://{host}:{settings.prometheus.port}{path}"


def probe_exporter(settings: Settings, timeout: float = 2) -> tuple[bool, str]:
    if not settings.prometheus.enabled:
        return False, "disabled"
    url = prometheus_url(settings)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace").strip()
    except urllib.error.HTTPError as error:
        return False, f"HTTP {error.code}"
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return False, str(error)
    return response.status == 200, body or f"HTTP {response.status}"


def wait_for_exporter(settings: Settings, timeout: float) -> None:
    if timeout <= 0:
        raise ServiceError("exporter readiness timeout must be positive")
    deadline = time.monotonic() + timeout
    detail = "not ready"
    while time.monotonic() < deadline:
        healthy, detail = probe_exporter(settings, timeout=1)
        if healthy:
            return
        time.sleep(0.2)
    raise ServiceError(
        f"Prometheus exporter did not become healthy within {timeout:g}s: {detail}"
    )


def command_exporter(args: argparse.Namespace) -> int:
    action = args.exporter_action
    if action == "status":
        settings = load_settings(args.config)
        service = service_status()
        healthy, detail = probe_exporter(settings)
        payload = {
            "enabled": settings.prometheus.enabled,
            "healthy": healthy,
            "detail": detail,
            "metrics_url": prometheus_url(settings, "/metrics"),
            "health_url": prometheus_url(settings),
            "service_active": service.get("ActiveState") == "active",
        }
        if args.json:
            print_json(payload)
        else:
            print(
                f"enabled={str(payload['enabled']).lower()} "
                f"healthy={str(healthy).lower()} "
                f"service_active={str(payload['service_active']).lower()}"
            )
            print(f"metrics={payload['metrics_url']}")
            print(f"health={payload['health_url']} ({detail})")
        return 0 if healthy or not settings.prometheus.enabled else 1

    if action == "start":
        settings = update_prometheus_config(
            args.config,
            enabled=True,
            host=args.host,
            port=args.port,
            max_sample_age_seconds=args.max_sample_age,
        )
        enable_service(settings)
        restart_service()
        wait_for_exporter(settings, args.timeout)
        print(f"Prometheus exporter started: {prometheus_url(settings, '/metrics')}")
        return 0

    settings = load_settings(args.config)
    if action == "stop":
        settings = update_prometheus_config(args.config, enabled=False)
        if service_status().get("ActiveState") == "active":
            restart_service()
        print("Prometheus exporter stopped; host monitoring remains active")
        return 0

    if action == "restart":
        if not settings.prometheus.enabled:
            raise ServiceError("Prometheus exporter is disabled; run `hmon exporter start`")
        enable_service(settings)
        restart_service()
        wait_for_exporter(settings, args.timeout)
        print(f"Prometheus exporter restarted: {prometheus_url(settings, '/metrics')}")
        return 0
    raise MonitorError(f"unsupported exporter action: {action}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hmon",
        description="Lightweight localhost resource monitoring and Expr Tracker alerts.",
    )
    parser.add_argument("--config", help="path to config.toml")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    config_parser = commands.add_parser("config", help="initialize or validate config")
    config_actions = config_parser.add_subparsers(
        dest="config_action", required=True
    )
    init_parser = config_actions.add_parser("init")
    init_parser.add_argument("--force", action="store_true")
    init_parser.add_argument("--lark-env-file")
    init_parser.add_argument("--lark-env-key", default="WEBHOOK_URL")
    config_actions.add_parser("path")
    config_actions.add_parser("show")
    config_actions.add_parser("validate")

    rules_parser = commands.add_parser("rules", help="manage Expr Tracker rules")
    rules_parser.add_argument("--json", action="store_true")
    rule_actions = rules_parser.add_subparsers(dest="rules_action")
    list_parser = rule_actions.add_parser("list")
    list_parser.add_argument("--json", action="store_true")
    rule_actions.add_parser("validate")
    add_parser = rule_actions.add_parser("add")
    add_parser.add_argument("name")
    add_parser.add_argument("expression")
    add_parser.add_argument("--level", default="warning")
    add_parser.add_argument("--title")
    add_parser.add_argument("--message")
    add_parser.add_argument("--mode", choices=("edge", "level"), default="level")
    add_parser.add_argument("--for", dest="for_steps", type=int, default=1)
    add_parser.add_argument("--cooldown", type=float, default=300)
    add_parser.add_argument("--notify-recovery", action="store_true")
    add_parser.add_argument("--channel", action="append")
    for name in ("remove", "enable", "disable"):
        action_parser = rule_actions.add_parser(name)
        action_parser.add_argument("name")
    test_parser = rule_actions.add_parser("test")
    test_parser.add_argument("--json", action="store_true")

    snapshot_parser = commands.add_parser("snapshot", help="collect localhost metrics")
    snapshot_parser.add_argument("--json", action="store_true")

    history_parser = commands.add_parser("history", help="inspect long-term history")
    history_parser.add_argument("--json", action="store_true")
    history_actions = history_parser.add_subparsers(dest="history_action")
    history_list = history_actions.add_parser("list")
    history_list.add_argument("--json", action="store_true")
    history_tail = history_actions.add_parser("tail")
    history_tail.add_argument("-n", "--count", type=int, default=20)
    history_tail.add_argument("--date")
    history_tail.add_argument("--json", action="store_true")
    history_actions.add_parser("migrate-state")

    exporter_parser = commands.add_parser(
        "exporter",
        help="start and manage the Prometheus exporter",
    )
    exporter_actions = exporter_parser.add_subparsers(
        dest="exporter_action",
        required=True,
    )
    exporter_start = exporter_actions.add_parser("start")
    exporter_start.add_argument("--host")
    exporter_start.add_argument("--port", type=int)
    exporter_start.add_argument("--max-sample-age", type=float)
    exporter_start.add_argument("--timeout", type=float, default=15)
    exporter_stop = exporter_actions.add_parser("stop")
    exporter_restart = exporter_actions.add_parser("restart")
    exporter_restart.add_argument("--timeout", type=float, default=15)
    exporter_status = exporter_actions.add_parser("status")
    exporter_status.add_argument("--json", action="store_true")

    alert_parser = commands.add_parser("alert", help="send a manual alert")
    alert_parser.add_argument("message")
    alert_parser.add_argument("--title", default="hostmon alert")
    alert_parser.add_argument(
        "--level",
        choices=("debug", "info", "warning", "error", "critical"),
        default="warning",
    )
    alert_parser.add_argument("--channel", action="append")

    commands.add_parser("enable", help="install and enable the user service")
    commands.add_parser("start", help="start the user service")
    commands.add_parser("stop", help="stop the user service")
    disable_parser = commands.add_parser("disable", help="disable the user service")
    disable_parser.add_argument("--now", action="store_true")
    status_parser = commands.add_parser("status", help="show service and sample status")
    status_parser.add_argument("--json", action="store_true")
    commands.add_parser("daemon", help="run the foreground monitor loop")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    configure_logging(args.verbose)
    try:
        if args.command == "config":
            return command_config(args)
        if args.command == "rules":
            return command_rules(args)
        if args.command == "snapshot":
            return command_snapshot(args)
        if args.command == "history":
            return command_history(args)
        if args.command == "exporter":
            return command_exporter(args)
        if args.command == "alert":
            return command_alert(args)
        if args.command == "enable":
            return command_enable(args)
        if args.command == "start":
            start_service()
            print(f"started {UNIT_NAME}")
            return 0
        if args.command == "stop":
            stop_service()
            print(f"stopped {UNIT_NAME}")
            return 0
        if args.command == "disable":
            disable_service(now=args.now)
            print(f"disabled {UNIT_NAME}")
            return 0
        if args.command == "status":
            return command_status(args)
        if args.command == "daemon":
            run_daemon(load_settings(args.config))
            return 0
    except MonitorError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    parser.error(f"unsupported command: {args.command}")
    return 2
