import type {
  ClusterGPUReport,
  ClusterGPUUsageRow,
  GPUSubmittersPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

export class GPUSubmittersPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly tableBody: HTMLTableSectionElement;
  private readonly search: HTMLInputElement;
  private readonly queue: HTMLSelectElement;
  private readonly count: HTMLElement;
  private report: ClusterGPUReport | null = null;
  private lastLoaded = 0;
  private loading = false;

  constructor(
    definition: GPUSubmittersPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "gpu-submitters-panel");
    this.element = shell.element;
    const controls = document.createElement("div");
    controls.className = "table-controls";
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.placeholder = "Filter submitter or creator ID";
    this.search.addEventListener("input", () => this.renderRows());
    this.queue = document.createElement("select");
    this.queue.addEventListener("change", () => this.renderRows());
    this.count = document.createElement("span");
    this.count.className = "table-count";
    controls.append(this.search, this.queue, this.count);

    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "metric-table submitter-table";
    const head = document.createElement("thead");
    head.innerHTML = `
      <tr><th>Queue</th><th>Submitter</th><th>Creator ID</th>
      <th>Running pods</th><th>Running GPUs</th><th>GPU nodes</th>
      <th>Pending pods</th><th>Pending GPUs</th></tr>
    `;
    this.tableBody = document.createElement("tbody");
    table.append(head, this.tableBody);
    wrapper.append(table);
    shell.body.append(controls, wrapper);
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
      const queues = ["all", ...this.report.capacity.map(row => row.queue)];
      const selected = this.queue.value || "all";
      this.queue.replaceChildren(
        ...queues.map(value => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value === "all" ? "All queues" : value;
          return option;
        }),
      );
      this.queue.value = queues.includes(selected) ? selected : "all";
      this.renderRows();
    } finally {
      this.loading = false;
    }
  }

  private renderRows(): void {
    if (!this.report) return;
    const query = this.search.value.trim().toLowerCase();
    const queue = this.queue.value;
    const rows = this.report.usage
      .filter(
        row =>
          (queue === "all" || row.queue === queue) &&
          (!query ||
            row.submitter.toLowerCase().includes(query) ||
            row.creator_id.toLowerCase().includes(query)),
      )
      .sort(
        (left, right) =>
          right.running_gpus - left.running_gpus ||
          right.pending_gpus - left.pending_gpus ||
          left.submitter.localeCompare(right.submitter),
      );
    this.count.textContent = `${rows.length} submitters`;
    this.tableBody.replaceChildren(...rows.map(usageRow));
  }
}

function usageRow(row: ClusterGPUUsageRow): HTMLTableRowElement {
  const output = document.createElement("tr");
  for (const value of [
    row.queue,
    row.submitter,
    row.creator_id,
    row.running_pods,
    row.running_gpus,
    row.running_gpu_nodes,
    row.pending_pods,
    row.pending_gpus,
  ]) {
    const cell = document.createElement("td");
    cell.textContent = String(value);
    output.append(cell);
  }
  return output;
}
