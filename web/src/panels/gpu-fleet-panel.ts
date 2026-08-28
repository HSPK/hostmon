import type {
  ClusterGPUCapacityRow,
  ClusterGPUReport,
  GPUFleetPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import {
  configuredColumns,
  compareByPath,
  DataTable,
  formatConfiguredValue,
  readPath,
  type DataColumn,
  type SortDirection,
} from "./data-table";

export class GPUFleetPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private readonly columns: DataColumn<ClusterGPUCapacityRow>[];
  private readonly table: DataTable<ClusterGPUCapacityRow>;
  private report: ClusterGPUReport | null = null;
  private lastLoaded = 0;
  private loading = false;
  private sort = "";
  private direction: SortDirection = "asc";

  constructor(
    private readonly definition: GPUFleetPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "gpu-fleet-panel");
    this.element = shell.element;
    this.body = shell.body;
    this.columns = configuredColumns(definition.columns ?? []);
    this.table = new DataTable(
      this.columns,
      "fleet-table",
      (value, direction) => {
        this.sort = value;
        this.direction = direction;
        this.render();
      },
    );
    void this.load();
  }

  update(): void {
    if (Date.now() - this.lastLoaded > 30_000) void this.load();
  }

  destroy(): void {}

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.report = await this.context.actions.loadClusterGPU();
      this.lastLoaded = Date.now();
      this.render();
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    if (!this.report) return;
    const total = this.report.total_capacity;
    const summary = document.createElement("div");
    summary.className = "fleet-summary";
    summary.append(
      ...this.definition.summary.map(definition =>
        summaryCell(
          definition.label,
          formatConfiguredValue(
            readPath(total, definition.path),
            definition.format,
            total,
            definition.unit ?? "",
            definition.fallback ?? "--",
          ),
        ),
      ),
    );
    const rows = [...this.report.capacity, total];
    if (this.sort) {
      rows.sort((left, right) =>
        compareByPath(left, right, this.sort, this.direction),
      );
    }
    this.table.setRows(rows, this.columns, "No capacity data");
    this.body.replaceChildren(summary, this.table.element);
  }
}

function summaryCell(label: string, value: string | Node): HTMLElement {
  const cell = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  const output = document.createElement("strong");
  if (typeof value === "string") output.textContent = value;
  else output.append(value);
  cell.append(name, output);
  return cell;
}
