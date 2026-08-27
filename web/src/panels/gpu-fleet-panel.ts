import type {
  ClusterGPUCapacityRow,
  ClusterGPUReport,
  GPUFleetPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

export class GPUFleetPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private report: ClusterGPUReport | null = null;
  private lastLoaded = 0;
  private loading = false;

  constructor(
    definition: GPUFleetPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "gpu-fleet-panel");
    this.element = shell.element;
    this.body = shell.body;
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
    const utilization =
      total.capacity_gpus > 0
        ? total.allocated_gpus / total.capacity_gpus * 100
        : 0;
    const summary = document.createElement("div");
    summary.className = "fleet-summary";
    summary.append(
      summaryCell("GPU allocation", `${total.allocated_gpus} / ${total.capacity_gpus}`),
      summaryCell("Utilization", `${utilization.toFixed(1)} %`),
      summaryCell("Pending GPUs", String(total.pending_gpus)),
      summaryCell("No-job GPUs", String(total.no_job_gpus)),
      summaryCell("No-job nodes", String(total.no_job_node_equivalents)),
      summaryCell("Free CPUs", formatNumber(total.free_cpus)),
    );

    const table = document.createElement("table");
    table.className = "metric-table fleet-table";
    const head = document.createElement("thead");
    head.innerHTML = `
      <tr><th>Queue</th><th>GPU allocation</th><th>Usage</th><th>Pending</th>
      <th>Free now</th><th>No-job GPUs</th><th>No-job nodes</th>
      <th>CPU allocation</th><th>Free CPUs</th></tr>
    `;
    const body = document.createElement("tbody");
    for (const row of [...this.report.capacity, total]) {
      body.append(capacityRow(row));
    }
    table.append(head, body);
    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll fleet-table-scroll";
    wrapper.append(table);
    this.body.replaceChildren(summary, wrapper);
  }
}

function summaryCell(label: string, value: string): HTMLElement {
  const cell = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  const output = document.createElement("strong");
  output.textContent = value;
  cell.append(name, output);
  return cell;
}

function capacityRow(row: ClusterGPUCapacityRow): HTMLTableRowElement {
  const utilization =
    row.capacity_gpus > 0
      ? row.allocated_gpus / row.capacity_gpus * 100
      : 0;
  const output = document.createElement("tr");
  for (const value of [
    row.queue,
    `${row.allocated_gpus} / ${row.capacity_gpus}`,
    `${utilization.toFixed(1)} %`,
    row.pending_gpus,
    row.unallocated_gpus,
    row.no_job_gpus,
    row.no_job_node_equivalents,
    `${formatNumber(row.allocated_cpus)} / ${formatNumber(row.capacity_cpus)}`,
    formatNumber(row.free_cpus),
  ]) {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    output.append(cell);
  }
  return output;
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
