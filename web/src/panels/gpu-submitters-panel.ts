import type {
  ClusterGPUReport,
  ClusterGPUWorkloadRow,
  GPUSubmittersPanelDefinition,
  WorkloadSelection,
  WorkloadSort,
  WorkloadStateFilter,
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
import {
  pageButton,
  tableFooter,
  TABLE_PAGE_SIZE,
} from "./table-controls";

export class GPUSubmittersPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly table: DataTable<ClusterGPUWorkloadRow>;
  private readonly columns: DataColumn<ClusterGPUWorkloadRow>[];
  private readonly search: HTMLInputElement;
  private readonly queue: HTMLSelectElement;
  private readonly state: HTMLSelectElement;
  private sort: WorkloadSort;
  private sortDirection: SortDirection;
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
  private activeSelection: WorkloadSelection | null = null;

  constructor(
    definition: GPUSubmittersPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "gpu-submitters-panel");
    this.element = shell.element;
    const controls = document.createElement("div");
    controls.className = "table-controls data-grid-toolbar";
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.placeholder = "Filter workload, submitter, or creator ID";
    this.search.addEventListener("input", () => {
      this.page = 0;
      this.renderRows();
    });
    this.queue = document.createElement("select");
    this.queue.setAttribute("aria-label", "Queue");
    this.queue.addEventListener("change", () => {
      this.page = 0;
      this.persistView();
      this.renderRows();
    });
    this.state = selectControl("Workload state", [
      ["all", "State: All"],
      ["attention", "Needs attention"],
      ["Running", "Running"],
      ["Pending", "Pending"],
      ["Mixed", "Mixed"],
    ]);
    this.state.addEventListener("change", () => {
      this.page = 0;
      this.persistView();
      this.renderRows();
    });
    const view = this.context.actions.workloadView();
    this.state.value = view.state;
    this.sort = view.sort;
    this.sortDirection = view.sortDirection;
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
    controls.append(this.search, this.queue, this.state);

    this.columns = configuredColumns(
      definition.columns ?? [],
      {
        details: row => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "workload-link";
          button.textContent = row.name;
          button.addEventListener("click", () => this.openDetails(row));
          return button;
        },
      },
    );
    this.table = new DataTable(
      this.columns,
      "submitter-table",
      (value, direction) => {
        this.sort = value as WorkloadSort;
        this.sortDirection = direction;
        this.page = 0;
        this.persistView();
        this.renderRows();
      },
      undefined,
      {value: this.sort, direction: this.sortDirection},
    );
    this.table.element.append(
      tableFooter(this.count, this.previous, this.next),
    );
    shell.body.append(controls, this.table.element);

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
      const selected = this.queue.value || this.context.actions.workloadView().queue;
      this.queue.replaceChildren(
        ...queues.map(value => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value === "all" ? "All queues" : value;
          return option;
        }),
      );
      this.queue.value = queues.includes(selected) ? selected : "all";
      if (this.queue.value !== selected) this.persistView();
      this.renderRows();
      this.syncSelectedDetails();
    } finally {
      this.loading = false;
    }
  }

  private renderRows(): void {
    if (!this.report) return;
    const query = this.search.value.trim().toLowerCase();
    const queue = this.queue.value;
    const state = this.state.value;
    const rows = (this.report.workloads ?? [])
      .filter(
        row =>
          (queue === "all" || row.queue === queue) &&
          (state === "all" ||
            (state === "attention"
              ? row.pending_gpus > 0 || row.status !== "Running"
              : row.status === state)) &&
          (!query ||
            row.name.toLowerCase().includes(query) ||
            row.submitter.toLowerCase().includes(query) ||
            row.creator_id.toLowerCase().includes(query)),
      )
      .sort((left, right) =>
        compareByPath(left, right, this.sort, this.sortDirection),
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
    this.table.setRows(
      pageRows,
      this.columns,
      "No workloads match the current filters",
    );
  }

  private persistView(): void {
    this.context.actions.setWorkloadView({
      queue: this.queue.value || "all",
      state: this.state.value as WorkloadStateFilter,
      sort: this.sort,
      sortDirection: this.sortDirection,
    });
  }

  private syncSelectedDetails(): void {
    if (!this.report) return;
    const selected = this.context.actions.selectedWorkload();
    if (!selected) {
      this.closeDetails(false);
      return;
    }
    const row = (this.report.workloads ?? []).find(
      item => item.queue === selected.queue && item.name === selected.name,
    );
    if (row) {
      this.openDetails(row, false);
      return;
    }
    this.closeDetails(false);
    this.context.actions.selectWorkload(null, true);
  }

  private openDetails(
    row: ClusterGPUWorkloadRow,
    updateRoute = true,
  ): void {
    const selection = {queue: row.queue, name: row.name};
    const changed =
      this.activeSelection?.queue !== selection.queue ||
      this.activeSelection.name !== selection.name;
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
      detailCell("State", row.status),
      detailCell("Running GPUs", row.running_gpus),
      detailCell("GPU nodes", row.running_gpu_nodes),
      detailCell("Running pods", row.running_pods),
      detailCell("Pending GPUs", row.pending_gpus),
      detailCell("Pending pods", row.pending_pods),
      detailCell(
        "GPU node names",
        row.running_nodes?.join(", ") || "--",
        "detail-wide",
      ),
    );
    this.drawer.replaceChildren(header, grid);
    this.drawer.classList.add("open");
    this.drawer.setAttribute("aria-hidden", "false");
    this.backdrop.classList.add("open");
    this.activeSelection = selection;
    if (updateRoute) this.context.actions.selectWorkload(selection);
    if (changed) close.focus();
  }

  private closeDetails(updateRoute = true): void {
    if (!this.activeSelection && updateRoute) return;
    this.drawer.classList.remove("open");
    this.drawer.setAttribute("aria-hidden", "true");
    this.backdrop.classList.remove("open");
    this.activeSelection = null;
    if (updateRoute) this.context.actions.selectWorkload(null);
  }
}

function selectControl(
  label: string,
  options: Array<[string, string]>,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  select.replaceChildren(
    ...options.map(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      return option;
    }),
  );
  return select;
}

function detailCell(
  label: string,
  value: string | number,
  className = "",
): HTMLElement {
  const cell = document.createElement("div");
  cell.className = className;
  const name = document.createElement("span");
  name.textContent = label;
  const output = document.createElement("strong");
  output.textContent = String(value);
  cell.append(name, output);
  return cell;
}
