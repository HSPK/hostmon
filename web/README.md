# hostmon web dashboard

The dashboard is an independently engineered TypeScript application. Vite
builds immutable assets that are packaged inside the Python distribution.
uPlot renders time-series data on Canvas, while a single WebSocket carries
incremental snapshots.

## Architecture

```text
aiohttp /api/history ---- initial columnar history
aiohttp /api/ws --------- incremental snapshots
                               |
                               v
                       TimeSeriesStore
                               |
                   requestAnimationFrame batching
                               |
              PanelRegistry -> panel renderers -> uPlot
```

Important modules:

| Module | Responsibility |
| --- | --- |
| `core/api-client.ts` | Initial status and compact history requests |
| `core/websocket-client.ts` | WebSocket lifecycle and jittered reconnect |
| `core/time-series-store.ts` | Bounded aligned columnar data |
| `core/preferences.ts` | Server-backed preferences with local migration fallback |
| `panels/panel.ts` | Renderer interface and registry |
| `panels/data-table.ts` | Typed configurable table rendering |
| `panels/timeseries-panel.ts` | uPlot adapter |
| `config/dashboard.json` | Declarative navigation and default panel layout |
| `config/dashboard.ts` | Runtime validation for dashboard configuration |
| `app.ts` | Application orchestration only |

## Performance properties

- No framework virtual DOM.
- One WebSocket connection per browser tab.
- Store updates are coalesced to one browser frame.
- Charts redraw only when data, layout, or time range changes.
- History is aligned and columnar rather than object-per-point.
- Server history is bounded and downsampled before serialization.
- Windows up to 30 days decode at most one JSON record per display bucket.
- Hashed Vite assets use immutable HTTP caching.
- No runtime CDN, fonts, JavaScript, or CSS dependencies.
- Rendering pauses when the page is hidden.

The production bundle budget is below 100 KiB compressed.

## Customize the dashboard

Users can drag panel headers or open **Layout** to show, hide, and reorder
panels. Preferences are atomically stored by the hostmon service. Existing
browser-local settings migrate on first connection and remain an offline
fallback.
Configured tables also expose per-column visibility controls in **Layout**.

The navigation model separates operational workflows:

- **Overview**: host resource summary and high-signal charts.
- **Metrics**: complete metric catalog and custom chart builder.
- **Collectors**: plugin health and stale/failure state.
- **Alerts**: validated Expr Tracker alert rule CRUD.
- **Settings**: web theme and density.
- **System**: internal hostmon and API diagnostics.

Repository-local plugins may provide additional navigation, panels, and
renderers without entering the core Python release.

The **Metrics** page searches every metric exposed by hostmon and shows
current, minimum, average, p95, maximum, and sample count. Select any metrics
to create line or area charts with custom titles, fixed/automatic axes, and
one- or two-column layouts. Custom charts can be edited or deleted without
rebuilding the frontend.

Navigation groups and the default layout are declarative:

```json
{
  "id": "network",
  "type": "timeseries",
  "page": "overview",
  "title": "Network throughput",
  "metrics": ["network/rx_mbps", "network/tx_mbps"],
  "section": "Charts"
}
```

Available built-in panel types:

- `stats`
- `timeseries`
- `collectors`
- `tasks`
- `metrics`
- `plugin-summary` (repository plugin build)
- `plugin-records` (repository plugin build)
- `rules`
- `system`

To add a display type, implement the small `PanelRenderer` lifecycle:

```ts
interface PanelRenderer {
  readonly element: HTMLElement;
  update(): void;
  destroy(): void;
}
```

Register the factory in `src/panels/registry.ts`. Data transport, storage, and
application orchestration do not need to change.

Every concrete metric name and display field belongs in `dashboard.json`.
Table columns use the generic `id`, `label`, `path`, `width`, `align`, `pinned`,
`sort`, `format`, and `action` schema. Summary cards use configured value
sources and templates.

For runtime customization, copy the packaged `dashboard.json` and configure:

```toml
[prometheus]
dashboard_file = "~/.config/host-monitor/dashboard.json"
dashboard_directory = "~/.config/host-monitor/dashboard/"
```

The browser fetches and validates this file on each reload; no TypeScript
rebuild is required.

## Development

```bash
npm ci
npm run typecheck
npm run test
npm run test:e2e
npm run dev
npm run build
```

`npm run build` writes the release-safe core dashboard to:

```text
../src/host_monitor/static/dashboard/
```

It also writes the repository-local plugin dashboard to:

```text
../plugins/cluster-gpu/static/dashboard/
```

The backend remains available on `127.0.0.1:9108`, so the Vite development
server proxies HTTP and WebSocket API requests to it.
