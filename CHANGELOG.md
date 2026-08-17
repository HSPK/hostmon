# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Changed

- Isolated collectors with concurrent execution, deadlines, bounded stale-data
  fallback, and collector health metrics.
- Added a durable SQLite alert outbox with idempotent events and per-channel
  delivery retries.
- Added explicit state migration with backups and fail-closed handling for
  unknown schema versions.
- Corrected Expr Tracker runtime timing context and pinned its private-API
  compatibility range.
- Made history write failures non-blocking for alert delivery.
- Added a last-known-good rule cache so transient invalid rule files do not
  interrupt collection.

## [0.1.0] - 2026-08-17

### Added

- Config-driven Linux CPU, memory, disk, network, NVIDIA GPU, and PSI collectors.
- Optional Kubernetes workload, Volcano quota, and RBAC permission collectors.
- Expr Tracker alert rules with cooldown, recovery, channel routing, and state.
- Date- and size-segmented JSONL history.
- `hmon` CLI for snapshots, history, rules, alerts, and user-systemd lifecycle.
- K9s localhost snapshot plugin.
