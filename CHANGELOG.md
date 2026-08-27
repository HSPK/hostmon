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
- Changed Kubernetes notifications to fire only when occupied GPU nodes
  decrease below quota, including the task names and nodes affected by that
  transition.
- Bounded default remote collector deadlines to half the collection interval,
  so slow Kubernetes API calls cannot create long gaps in localhost history.
- Removed the duplicate state fsync and made the scheduler catch up after a
  slight overrun instead of adding another full interval.
- Added a standard-library Prometheus exporter with `/metrics`, `/healthz`,
  and `/api/status` endpoints.
- Added `hmon exporter start|stop|restart|status` for one-command exporter
  configuration, systemd lifecycle, and readiness checks.
- Added a modular TypeScript/Vite/uPlot dashboard with an in-memory columnar
  ring, frame-coalesced updates, and aiohttp WebSocket backend.
- Bounded web compression workers and kept hot JSON/Prometheus responses
  uncompressed to reduce latency and thread growth under concurrent load.
- Added operations-console navigation, a complete metric catalog with
  statistics, configurable custom charts, panel persistence, CSV export, and
  real-browser responsiveness tests.
- Added a cluster GPU usage collector with queue CPU/GPU capacity, allocation,
  pending demand, no-job node equivalents, and submitter workload breakdowns.
- Added GPU Fleet and Workloads workspace views backed by generic plugin
  document APIs.
- Cached metric catalog statistics by data revision and time window to prevent
  repeated aggregate work from blocking the async HTTP loop.
- Added domain-aware labels and units for cluster GPU capacity metrics.
- Cached encoded catalog responses by dashboard revision to keep the async
  event loop responsive under concurrent metric-explorer requests.
- Split GPU capacity and availability/demand charts so low-volume pending and
  no-job signals retain useful visual scale.
- Increased chart value-axis width for untruncated multi-digit capacity labels.
- Added run-level Volcano workload aggregation and a selectable workload detail
  drawer while keeping high-cardinality records out of metric history.
- Paginated workload rendering with shared table controls to bound DOM work for
  clusters with hundreds of active runs.

## [0.1.0] - 2026-08-17

### Added

- Config-driven Linux CPU, memory, disk, network, NVIDIA GPU, and PSI collectors.
- Optional Kubernetes workload, Volcano quota, and RBAC permission collectors.
- Expr Tracker alert rules with cooldown, recovery, channel routing, and state.
- Date- and size-segmented JSONL history.
- `hmon` CLI for snapshots, history, rules, alerts, and user-systemd lifecycle.
- K9s localhost snapshot plugin.
