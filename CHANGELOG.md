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
- Moved optional collector refreshes off the critical sampling path, retaining
  last-good data while remote work is in flight and counting each deadline miss
  once instead of once per monitor cycle.
- Exposed plugin state schema versions through the generic plugin document API.
- Parallelized independent Cluster GPU Kubernetes queries with a bounded,
  configurable worker count.
- Distinguished cache hits from real collector refreshes so diagnostics retain
  accurate refresh timestamps and durations.
- Pipelined completed background collectors so fast optional sources retain
  the configured sampling cadence without blocking the main cycle.
- Removed the empty workload-detail grid cell and included explicit run state.
- Included kubectl exit codes when failed commands produce no output.
- Filled the System status grid with the health endpoint and applied bounded
  shared number formatting to raw internal metrics.
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
- Added shareable page routes and browser Back/Forward navigation for stable
  workspace deep links while retaining the last page as the local default.
- Preserved readable fleet and workload column widths on narrow screens with
  panel-local scrolling instead of destructive per-character wrapping.
- Made dense table controls wrap within mobile panels so filters and pagination
  actions remain reachable at 390-pixel viewport widths.
- Added queue-qualified workload deep links so individual run drawers can be
  shared and restored with browser Back/Forward navigation.
- Kept the workload drawer close action inside narrow viewports when long run
  names exercise flexbox intrinsic sizing.
- Added concrete, deterministically ordered GPU node names to run diagnostics
  without increasing time-series cardinality or issuing extra cluster queries.
- Prevented dashboard rebuilds from deleting live hashed assets before the new
  index is ready, retaining one prior JS/CSS generation for in-flight clients.
- Added workload state triage and deterministic sorting by running GPUs,
  pending GPUs, name, submitter, or queue.
- Added an explicit workload empty state so zero-result triage filters never
  look like a loading or rendering failure.
- Clamped no-job GPU availability at zero when pending demand temporarily
  exceeds unallocated capacity, while preserving pending demand separately.
- Versioned cluster GPU collector cache state so semantic upgrades force an
  immediate fresh report instead of reusing older calculations.
- Persisted workload queue, state, and sort choices as typed dashboard
  preferences so triage views survive navigation and reloads.
- Added adaptive 30-day history windows backed by bounded server-side
  downsampling and viewport-sized browser point budgets.
- Moved default navigation and panel/chart definitions into validated
  `dashboard.json` configuration.
- Added persistent drag-and-drop panel ordering and enabled full chart editing
  for built-in panels, including line width.
- Moved connection state into a bottom status bar with API latency and UTC+8
  sample timestamps.
- Added a generic typed data-table renderer, JSON-configured Workload/Metric
  columns, persistent column visibility controls, and semantic table/chart
  page sections.
- Replaced table sort dropdowns with reusable ascending/descending header
  sorting and constrained table-only pages to internal scrolling.
- Reworked chart metric selection into bounded search results and a separate
  selected-metric list.
- Grouped sidebar navigation into Charts, Tables, and Manage, moved Settings
  and System to the bottom, and split Alerts into its own page.
- Added persistent light/dark/system themes and compact/comfortable density.
- Added collector diagnostics with configured refresh/deadline/stale policy,
  absolute UTC+8 refresh time, recent errors, and detailed options.
- Retained the most recent collector failure details after recovery so
  intermittent errors remain inspectable.
- Restored separated multi-column chart grids, added per-chart height editing,
  and removed the global toolbar Layout action in favor of Settings.
- Simplified table titles and outer framing while preserving internal table
  boundaries and scrolling.
- Avoided redundant uPlot data and scale updates by tracking series revisions
  and effective chart ranges.
- Rebuilt operational tables as an industrial DataGrid with dedicated
  toolbar/viewport/footer regions, fixed key columns, explicit widths,
  single-line truncation, stable scrollbars, and CSS containment.
- Standardized UI spacing on 4/8/12/16-pixel tokens, removed redundant section
  labels on table-only pages, and added themed high-contrast scrollbars.
- Coalesced identical long-history requests into one disk scan and cached the
  bounded result for 15 seconds to prevent multi-client I/O amplification.
- Moved all dashboard metric names, chart series metadata, stat definitions,
  table columns, summary fields, sort paths, widths, alignment, and value
  sources into validated runtime JSON configuration.
- Added optional `[prometheus].dashboard_file` loading with packaged fallback,
  allowing navigation and panel changes without rebuilding the frontend.

## [0.1.0] - 2026-08-17

### Added

- Config-driven Linux CPU, memory, disk, network, NVIDIA GPU, and PSI collectors.
- Optional Kubernetes workload, Volcano quota, and RBAC permission collectors.
- Expr Tracker alert rules with cooldown, recovery, channel routing, and state.
- Date- and size-segmented JSONL history.
- `hmon` CLI for snapshots, history, rules, alerts, and user-systemd lifecycle.
- K9s localhost snapshot plugin.
