from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from expr_tracker.alerts import AlertMessage

from .errors import AlertError, MonitorError
from .rules import CapturedAlert


URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)


@dataclass(frozen=True)
class PendingDelivery:
    event_id: str
    channel: str
    message: AlertMessage
    attempts: int


@dataclass(frozen=True)
class DeliveryReport:
    delivered: int
    failed: int
    pending: int
    errors: tuple[str, ...]


def _safe_error(error: Exception) -> str:
    text = f"{type(error).__name__}: {error}"
    return URL_RE.sub("<redacted-url>", text)[:1000]


def _message_payload(message: AlertMessage) -> dict[str, Any]:
    payload = message.to_dict()
    payload["level"] = message.level.value
    return payload


def _event_id(message: AlertMessage) -> str:
    identity = "\0".join(
        [
            str(message.source or ""),
            str(message.dedup_key or ""),
            message.title,
            message.level.value,
            message.text if not message.dedup_key else "",
        ]
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


class OutboxStore:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            self.connection = sqlite3.connect(path, timeout=10)
            os.chmod(path, 0o600)
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.execute("PRAGMA busy_timeout=10000")
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS outbox_events (
                    event_id TEXT PRIMARY KEY,
                    created_at REAL NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS outbox_deliveries (
                    event_id TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'delivered')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt_at REAL NOT NULL,
                    last_error TEXT,
                    delivered_at REAL,
                    PRIMARY KEY (event_id, channel),
                    FOREIGN KEY (event_id) REFERENCES outbox_events(event_id)
                        ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS outbox_pending
                    ON outbox_deliveries(status, next_attempt_at);
                """
            )
            self.connection.commit()
        except (OSError, sqlite3.Error) as error:
            raise MonitorError(f"cannot initialize alert outbox {path}: {error}") from error

    def close(self) -> None:
        self.connection.close()

    def enqueue(
        self,
        captured: CapturedAlert,
        channels: Sequence[str],
        *,
        now: float,
    ) -> str | None:
        if not channels:
            return None
        event_id = _event_id(captured.message)
        payload = json.dumps(
            _message_payload(captured.message),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        try:
            with self.connection:
                self.connection.execute(
                    """
                    INSERT OR IGNORE INTO outbox_events
                        (event_id, created_at, payload_json)
                    VALUES (?, ?, ?)
                    """,
                    (event_id, now, payload),
                )
                self.connection.executemany(
                    """
                    INSERT OR IGNORE INTO outbox_deliveries
                        (event_id, channel, next_attempt_at)
                    VALUES (?, ?, ?)
                    """,
                    [(event_id, channel, now) for channel in sorted(set(channels))],
                )
        except sqlite3.Error as error:
            raise MonitorError(f"cannot enqueue alert {event_id}: {error}") from error
        return event_id

    def pending(self, *, now: float, limit: int = 100) -> list[PendingDelivery]:
        try:
            rows = self.connection.execute(
                """
                SELECT d.event_id, d.channel, e.payload_json, d.attempts
                FROM outbox_deliveries AS d
                JOIN outbox_events AS e USING (event_id)
                WHERE d.status = 'pending' AND d.next_attempt_at <= ?
                ORDER BY e.created_at, d.channel
                LIMIT ?
                """,
                (now, limit),
            ).fetchall()
        except sqlite3.Error as error:
            raise MonitorError(f"cannot read alert outbox: {error}") from error
        deliveries: list[PendingDelivery] = []
        for event_id, channel, raw_payload, attempts in rows:
            try:
                payload = json.loads(raw_payload)
                message = AlertMessage(**payload)
            except (json.JSONDecodeError, TypeError, ValueError) as error:
                raise MonitorError(
                    f"invalid outbox payload for event {event_id}: {error}"
                ) from error
            deliveries.append(
                PendingDelivery(
                    event_id=event_id,
                    channel=channel,
                    message=message,
                    attempts=int(attempts),
                )
            )
        return deliveries

    def mark_delivered(
        self, event_id: str, channel: str, *, now: float
    ) -> None:
        try:
            with self.connection:
                self.connection.execute(
                    """
                    UPDATE outbox_deliveries
                    SET status = 'delivered', delivered_at = ?, last_error = NULL
                    WHERE event_id = ? AND channel = ?
                    """,
                    (now, event_id, channel),
                )
        except sqlite3.Error as error:
            raise MonitorError(f"cannot update alert delivery: {error}") from error

    def mark_failed(
        self,
        delivery: PendingDelivery,
        error: Exception,
        *,
        now: float,
    ) -> str:
        attempts = delivery.attempts + 1
        delay = min(300.0, float(2 ** min(attempts, 8)))
        detail = _safe_error(error)
        try:
            with self.connection:
                self.connection.execute(
                    """
                    UPDATE outbox_deliveries
                    SET attempts = ?, next_attempt_at = ?, last_error = ?
                    WHERE event_id = ? AND channel = ?
                    """,
                    (
                        attempts,
                        now + delay,
                        detail,
                        delivery.event_id,
                        delivery.channel,
                    ),
                )
        except sqlite3.Error as db_error:
            raise MonitorError(
                f"cannot record failed alert delivery: {db_error}"
            ) from db_error
        return detail

    def pending_count(self) -> int:
        try:
            row = self.connection.execute(
                "SELECT COUNT(*) FROM outbox_deliveries WHERE status = 'pending'"
            ).fetchone()
        except sqlite3.Error as error:
            raise MonitorError(f"cannot count pending alerts: {error}") from error
        return int(row[0]) if row else 0

    def event_status(self, event_id: str) -> dict[str, str]:
        try:
            rows = self.connection.execute(
                """
                SELECT channel, status
                FROM outbox_deliveries
                WHERE event_id = ?
                ORDER BY channel
                """,
                (event_id,),
            ).fetchall()
        except sqlite3.Error as error:
            raise MonitorError(f"cannot read alert status: {error}") from error
        return {str(channel): str(status) for channel, status in rows}

    def prune_delivered(self, *, before: float) -> int:
        try:
            with self.connection:
                cursor = self.connection.execute(
                    """
                    DELETE FROM outbox_events
                    WHERE created_at < ?
                      AND NOT EXISTS (
                          SELECT 1
                          FROM outbox_deliveries AS d
                          WHERE d.event_id = outbox_events.event_id
                            AND d.status != 'delivered'
                      )
                    """,
                    (before,),
                )
        except sqlite3.Error as error:
            raise MonitorError(f"cannot prune alert outbox: {error}") from error
        return int(cursor.rowcount)

    def deliver_pending(
        self,
        sender: Any,
        *,
        now: float,
        limit: int = 100,
    ) -> DeliveryReport:
        delivered = 0
        failed = 0
        errors: list[str] = []
        for delivery in self.pending(now=now, limit=limit):
            try:
                sender.send_one(delivery.message, delivery.channel)
            except AlertError as error:
                failed += 1
                errors.append(
                    f"channel {delivery.channel!r}: "
                    f"{self.mark_failed(delivery, error, now=now)}"
                )
            else:
                self.mark_delivered(
                    delivery.event_id,
                    delivery.channel,
                    now=now,
                )
                delivered += 1
        return DeliveryReport(
            delivered=delivered,
            failed=failed,
            pending=self.pending_count(),
            errors=tuple(errors),
        )
