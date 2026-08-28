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
| `core/preferences.ts` | Browser-local layout preferences |
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
panels. Preferences are
stored in browser local storage and do not affect other users.
Configured tables also expose per-column visibility controls in **Layout**.

The navigation model separates operational workflows:

- **Overview**: host resource summary and high-signal charts.
- **GPU Fleet**: Volcano queue capacity, allocation, pending demand, and
  no-job node equivalents.
- **Workloads**: searchable GPU usage grouped by submitter and creator ID.
- **Metrics**: complete metric catalog and custom chart builder.
- **Collectors**: plugin health and stale/failure state.
- **Kubernetes**: node and task state.
- **Settings**: validated Expr Tracker alert rule CRUD.
- **System**: internal hostmon and API diagnostics.

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
- `gpu-fleet`
- `gpu-submitters`
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

## Development

```bash
npm ci
npm run typecheck
npm run test
npm run test:e2e
npm run dev
npm run build
```

`npm run build` writes production assets to:

```text
../src/host_monitor/static/dashboard/
```

The backend remains available on `127.0.0.1:9108`, so the Vite development
server proxies HTTP and WebSocket API requests to it.
