import type {
  ClusterGPUReport,
  ClusterGPUWorkloadRow,
  GPUSubmittersPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import { pageButton, TABLE_PAGE_SIZE } from "./table-controls";

export class GPUSubmittersPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly tableBody: HTMLTableSectionElement;
  private readonly search: HTMLInputElement;
  private readonly queue: HTMLSelectElement;
  private readonly count: HTMLElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly drawer: HTMLElement;
  private readonly backdrop: HTMLElement;
  private readonly closeOnEscape: (event: KeyboardEvent) => void;
  private report: ClusterGPUReport | null = null;
  private lastLoaded = 0;
  private loading = false;
  private page = 0;

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
    this.search.placeholder = "Filter workload, submitter, or creator ID";
    this.search.addEventListener("input", () => {
      this.page = 0;
      this.renderRows();
    });
    this.queue = document.createElement("select");
    this.queue.addEventListener("change", () => {
      this.page = 0;
      this.renderRows();
    });
    this.count = document.createElement("span");
    this.count.className = "table-count";
    this.previous = pageButton("Previous", () => {
      this.page = Math.max(0, this.page - 1);
      this.renderRows();
    });
    this.next = pageButton("Next", () => {
      this.page++;
      this.renderRows();
    });
    controls.append(
      this.search,
      this.queue,
      this.count,
      this.previous,
      this.next,
    );

    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "metric-table submitter-table";
    const head = document.createElement("thead");
    head.innerHTML = `
      <tr><th>Queue</th><th>Workload</th><th>State</th><th>Submitter</th>
      <th>Running GPUs</th><th>GPU nodes</th><th>Pending GPUs</th></tr>
    `;
    this.tableBody = document.createElement("tbody");
    table.append(head, this.tableBody);
    wrapper.append(table);
    shell.body.append(controls, wrapper);

    this.drawer = document.createElement("aside");
    this.drawer.className = "workload-drawer";
    this.drawer.setAttribute("aria-hidden", "true");
    this.drawer.setAttribute("aria-label", "Workload details");
    this.backdrop = document.createElement("div");
    this.backdrop.className = "workload-backdrop";
    this.backdrop.addEventListener("click", () => this.closeDetails());
    this.closeOnEscape = event => {
      if (event.key === "Escape") this.closeDetails();
    };
    window.addEventListener("keydown", this.closeOnEscape);
    document.body.append(this.backdrop, this.drawer);
    void this.load();
  }

  update(): void {
    if (Date.now() - this.lastLoaded > 30_000) void this.load();
  }

  destroy(): void {
    window.removeEventListener("keydown", this.closeOnEscape);
    this.drawer.remove();
    this.backdrop.remove();
  }

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
    const rows = (this.report.workloads ?? [])
      .filter(
        row =>
          (queue === "all" || row.queue === queue) &&
          (!query ||
            row.name.toLowerCase().includes(query) ||
            row.submitter.toLowerCase().includes(query) ||
            row.creator_id.toLowerCase().includes(query)),
      )
      .sort(
        (left, right) =>
          right.running_gpus - left.running_gpus ||
          right.pending_gpus - left.pending_gpus ||
          left.submitter.localeCompare(right.submitter),
      );
    const pages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    const pageRows = rows.slice(
      this.page * TABLE_PAGE_SIZE,
      (this.page + 1) * TABLE_PAGE_SIZE,
    );
    this.count.textContent =
      `${rows.length} workloads | ${this.page + 1}/${pages}`;
    this.previous.disabled = this.page === 0;
    this.next.disabled = this.page >= pages - 1;
    this.tableBody.replaceChildren(
      ...pageRows.map(row =>
        workloadRow(row, selected => this.openDetails(selected)),
      ),
    );
  }

  private openDetails(row: ClusterGPUWorkloadRow): void {
    const header = document.createElement("header");
    const heading = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.className = "drawer-eyebrow";
    eyebrow.textContent = `${row.queue} / ${row.status}`;
    const title = document.createElement("h2");
    title.textContent = row.name;
    heading.append(eyebrow, title);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-button";
    close.textContent = "Close";
    close.addEventListener("click", () => this.closeDetails());
    header.append(heading, close);

    const grid = document.createElement("div");
    grid.className = "workload-detail-grid";
    grid.append(
      detailCell("Submitter", row.submitter),
      detailCell("Creator ID", row.creator_id),
      detailCell("Running GPUs", row.running_gpus),
      detailCell("GPU nodes", row.running_gpu_nodes),
      detailCell("Running pods", row.running_pods),
      detailCell("Pending GPUs", row.pending_gpus),
      detailCell("Pending pods", row.pending_pods),
    );
    this.drawer.replaceChildren(header, grid);
    this.drawer.classList.add("open");
    this.drawer.setAttribute("aria-hidden", "false");
    this.backdrop.classList.add("open");
    close.focus();
  }

  private closeDetails(): void {
    this.drawer.classList.remove("open");
    this.drawer.setAttribute("aria-hidden", "true");
    this.backdrop.classList.remove("open");
  }
}

function workloadRow(
  row: ClusterGPUWorkloadRow,
  select: (row: ClusterGPUWorkloadRow) => void,
): HTMLTableRowElement {
  const output = document.createElement("tr");
  const values = [
    row.queue,
    row.name,
    row.status,
    row.submitter,
    row.running_gpus,
    row.running_gpu_nodes,
    row.pending_gpus,
  ];
  for (const [index, value] of values.entries()) {
    const cell = document.createElement("td");
    if (index === 1) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workload-link";
      button.textContent = String(value);
      button.addEventListener("click", () => select(row));
      cell.append(button);
    } else if (index === 2) {
      const state = document.createElement("span");
      state.className = `state ${
        value === "Running"
          ? "state-up"
          : value === "Pending"
            ? "state-stale"
            : "state-mixed"
      }`;
      state.textContent = String(value);
      cell.append(state);
    } else {
      cell.textContent = String(value);
    }
    output.append(cell);
  }
  return output;
}

function detailCell(label: string, value: string | number): HTMLElement {
  const cell = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  const output = document.createElement("strong");
  output.textContent = String(value);
  cell.append(name, output);
  return cell;
}
