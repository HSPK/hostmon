import type {
  CollectorDiagnostic,
  CollectorPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import { DataTable, type DataColumn } from "./data-table";

interface CollectorRow extends CollectorDiagnostic {
  up: number;
  stale: number;
  failures: number;
  duration: number | undefined;
}

export class CollectorPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly table: DataTable<CollectorRow>;
  private readonly columns: DataColumn<CollectorRow>[];
  private readonly dialog: HTMLDialogElement;
  private diagnostics: CollectorDiagnostic[] = [];
  private lastLoaded = 0;
  private loading = false;

  constructor(
    definition: CollectorPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "collector-panel");
    this.element = shell.element;
    this.columns = [
      {id: "name", label: "Collector", render: row => row.name},
      {id: "state", label: "State", render: row => stateBadge(row)},
      {
        id: "duration",
        label: "Duration",
        render: row => format(row.duration, "ms"),
      },
      {
        id: "refresh",
        label: "Refresh",
        render: row => format(row.refresh_seconds, "s"),
      },
      {
        id: "updated",
        label: "Last refresh (UTC+8)",
        render: row => formatTimestamp(row.last_success_at),
      },
      {
        id: "failures",
        label: "Failures",
        render: row => String(row.failures),
      },
      {
        id: "log",
        label: "Latest log",
        render: row => row.last_error ?? "OK",
      },
      {
        id: "details",
        label: "Details",
        render: row => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "table-action";
          button.textContent = "View";
          button.addEventListener("click", () => this.openDetails(row));
          return button;
        },
      },
    ];
    this.table = new DataTable(this.columns, "health-table");
    shell.body.append(this.table.element);
    this.dialog = document.createElement("dialog");
    this.dialog.className = "collector-dialog";
    this.dialog.innerHTML = `
      <header><h2>Collector details</h2><button class="icon-button" type="button">Close</button></header>
      <pre></pre>
    `;
    this.dialog.querySelector("button")!.addEventListener(
      "click",
      () => this.dialog.close(),
    );
    document.body.append(this.dialog);
    void this.load();
  }

  update(): void {
    this.render();
    if (Date.now() - this.lastLoaded > 10_000) void this.load();
  }

  destroy(): void {
    this.dialog.remove();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.diagnostics = await this.context.actions.loadCollectors();
      this.lastLoaded = Date.now();
      this.render();
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const metrics = this.context.store.latestMetrics;
    const rows = this.diagnostics.map(item => {
      const prefix = `monitor/collector/${item.name}`;
      return {
        ...item,
        up: metrics[`${prefix}/up`] ?? 0,
        stale: metrics[`${prefix}/stale`] ?? 0,
        failures: metrics[`${prefix}/failures_total`] ?? 0,
        duration: metrics[`${prefix}/duration_ms`],
      };
    });
    this.table.setRows(rows, this.columns, "Collector diagnostics unavailable");
  }

  private openDetails(row: CollectorRow): void {
    this.dialog.querySelector("h2")!.textContent = row.name;
    this.dialog.querySelector("pre")!.textContent = JSON.stringify(
      {
        required: row.required,
        deadline_seconds: row.deadline_seconds,
        max_stale_seconds: row.max_stale_seconds,
        refresh_seconds: row.refresh_seconds,
        last_success_at: row.last_success_at,
        last_failure_at: row.last_failure_at,
        last_error: row.last_error,
        options: row.options,
      },
      null,
      2,
    );
    this.dialog.showModal();
  }
}

function stateBadge(row: CollectorRow): HTMLElement {
  const state = row.up ? (row.stale ? "stale" : "up") : "down";
  const badge = document.createElement("span");
  badge.className = `state state-${state}`;
  badge.textContent = state;
  return badge;
}

function format(value: number | undefined, unit: string): string {
  return Number.isFinite(value) ? `${value!.toFixed(1)} ${unit}` : "--";
}

function formatTimestamp(value: number | null): string {
  if (!value) return "--";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value * 1000));
}
