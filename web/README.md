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
| `core/frame-scheduler.ts` | One animation clock shared by every chart |
| `core/preferences.ts` | Browser-local layout preferences |
| `panels/panel.ts` | Renderer interface and registry |
| `panels/timeseries-panel.ts` | uPlot adapter |
| `config/dashboard.ts` | Declarative default panel layout |
| `app.ts` | Application orchestration only |

## Performance properties

- No framework virtual DOM.
- One WebSocket connection per browser tab.
- One shared animation frame scheduler for every chart.
- Updates are coalesced to one browser frame.
- History is aligned and columnar rather than object-per-point.
- Server history is bounded and downsampled before serialization.
- Hashed Vite assets use immutable HTTP caching.
- No runtime CDN, fonts, JavaScript, or CSS dependencies.
- Rendering pauses when the page is hidden.

The production bundle budget is below 100 KiB compressed.

## Customize the dashboard

Users can open **Customize** to show, hide, and reorder panels. Preferences are
stored in browser local storage and do not affect other users.

The default layout is declarative:

```ts
// src/config/dashboard.ts
{
  id: "network",
  type: "timeseries",
  title: "Network throughput",
  metrics: ["network/rx_mbps", "network/tx_mbps"]
}
```

Available built-in panel types:

- `stats`
- `timeseries`
- `collectors`
- `tasks`

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
npm run dev
npm run build
```

`npm run build` writes production assets to:

```text
../src/host_monitor/static/dashboard/
```

The backend remains available on `127.0.0.1:9108`, so the Vite development
server proxies HTTP and WebSocket API requests to it.
