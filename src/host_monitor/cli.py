from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Sequence

from . import __version__
from .alerts import AlertSender
from .collectors import build_collectors
from .config import (
    initialize_config,
    load_settings,
    resolve_config_path,
)
from .errors import MonitorError
from .history import HistoryReader, HistoryWriter, migrate_rolling_state
from .rules import RuleStore, inspect_rules, write_default_rules
from .runtime import capture_snapshot, run_daemon
from .service import (
    UNIT_NAME,
    disable_service,
    enable_service,
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
    if path.exists():
        settings = load_settings(path)
        state = StateStore(settings.state_file).load()
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
