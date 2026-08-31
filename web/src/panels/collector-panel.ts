import type {
  CollectorDiagnostic,
  CollectorPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import {
  compareByPath,
  configuredColumns,
  DataTable,
  type DataColumn,
  type SortDirection,
} from "./data-table";

type CollectorRow = CollectorDiagnostic;

export class CollectorPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly table: DataTable<CollectorRow>;
  private readonly columns: DataColumn<CollectorRow>[];
  private readonly dialog: HTMLDialogElement;
  private diagnostics: CollectorDiagnostic[] = [];
  private lastLoaded = 0;
  private loading = false;
  private sort = "";
  private direction: SortDirection = "asc";

  constructor(
    definition: CollectorPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "collector-panel");
    this.element = shell.element;
    this.columns = configuredColumns(
      definition.columns ?? [],
      {
        details: row => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "table-action";
          button.textContent = "View";
          button.addEventListener("click", () => this.openDetails(row));
          return button;
        },
      },
    );
    this.table = new DataTable(
      this.columns,
      "health-table",
      (value, direction) => {
        this.sort = value;
        this.direction = direction;
        this.render();
      },
    );
    shell.body.append(this.table.element);
    this.dialog = document.createElement("dialog");
    this.dialog.className = "collector-dialog";
    this.dialog.setAttribute("aria-label", "Collector details");
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
    const rows = [...this.diagnostics];
    if (this.sort) {
      rows.sort((left, right) =>
        compareByPath(left, right, this.sort, this.direction),
      );
    }
    this.table.setRows(
      rows,
      this.columns,
      "Collector diagnostics unavailable",
    );
  }

  private openDetails(row: CollectorRow): void {
    this.dialog.setAttribute(
      "aria-label",
      `${row.name} collector details`,
    );
    this.dialog.querySelector("h2")!.textContent = row.name;
    this.dialog.querySelector("pre")!.textContent = JSON.stringify(
      {
        state: row.state,
        required: row.required,
        last_refresh_duration_ms: row.duration,
        failures: row.failures,
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
