import type {
  ClusterGPUReport,
  ClusterGPUWorkloadRow,
  GPUSubmittersPanelDefinition,
  WorkloadSelection,
  WorkloadSort,
  WorkloadStateFilter,
  WorkloadView,
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
  formatItemCount,
  pageButton,
  tableFooter,
  TABLE_PAGE_SIZE,
} from "./table-controls";

const SEARCH_PERSIST_DELAY_MS = 250;

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
  private readonly dialog: HTMLDialogElement;
  private report: ClusterGPUReport | null = null;
  private lastLoaded = 0;
  private loading = false;
  private searchPersistTimer: number | null = null;
  private page = 0;
  private activeSelection: WorkloadSelection | null = null;

  constructor(
    private readonly definition: GPUSubmittersPanelDefinition,
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
      this.scheduleViewPersistence();
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
    const view = this.workloadView();
    this.search.value = view.query;
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

    this.dialog = document.createElement("dialog");
    this.dialog.className = "workload-dialog";
    this.dialog.setAttribute("aria-label", "Workload details");
    this.dialog.addEventListener("cancel", event => {
      event.preventDefault();
      this.closeDetails();
    });
    document.body.append(this.dialog);
    void this.load();
  }

  update(): void {
    if (Date.now() - this.lastLoaded > 30_000) void this.load();
  }

  destroy(): void {
    if (this.searchPersistTimer !== null) {
      clearTimeout(this.searchPersistTimer);
      this.searchPersistTimer = null;
      this.persistView();
    }
    this.dialog.remove();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.report = await this.context.actions.loadPlugin<ClusterGPUReport>(
        this.definition.plugin,
      );
      this.lastLoaded = Date.now();
      const queues = ["all", ...this.report.capacity.map(row => row.queue)];
      const selected = this.queue.value || this.workloadView().queue;
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
      `${formatItemCount(rows.length, "workload")} | ` +
      `${this.page + 1}/${pages}`;
    this.previous.disabled = this.page === 0;
    this.next.disabled = this.page >= pages - 1;
    this.table.setRows(
      pageRows,
      this.columns,
      "No workloads match the current filters",
    );
  }

  private persistView(): void {
    this.context.actions.setPanelState(this.definition.id, {
      query: this.search.value,
      queue: this.queue.value || "all",
      state: this.state.value as WorkloadStateFilter,
      sort: this.sort,
      sortDirection: this.sortDirection,
    });
  }

  private scheduleViewPersistence(): void {
    if (this.searchPersistTimer !== null) {
      clearTimeout(this.searchPersistTimer);
    }
    this.searchPersistTimer = window.setTimeout(() => {
      this.searchPersistTimer = null;
      this.persistView();
    }, SEARCH_PERSIST_DELAY_MS);
  }

  private syncSelectedDetails(): void {
    if (!this.report) return;
    const selected = this.selectedWorkload();
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
    this.selectWorkload(null, true);
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
    eyebrow.className = "dialog-eyebrow";
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
    this.dialog.replaceChildren(header, grid);
    this.activeSelection = selection;
    if (updateRoute) this.selectWorkload(selection);
    if (!this.dialog.open) this.dialog.showModal();
    if (changed) close.focus();
  }

  private closeDetails(updateRoute = true): void {
    if (!this.activeSelection && updateRoute) return;
    if (this.dialog.open) this.dialog.close();
    this.activeSelection = null;
    if (updateRoute) this.selectWorkload(null);
  }

  private workloadView(): WorkloadView {
    return this.context.actions.panelState(this.definition.id, {
      query: "",
      queue: "all",
      state: "all",
      sort: this.definition.defaultSort ?? "name",
      sortDirection: this.definition.defaultSortDirection ?? "asc",
    }) as WorkloadView;
  }

  private selectedWorkload(): WorkloadSelection | null {
    const parameters = new URL(window.location.href).searchParams;
    const queue = parameters.get("queue");
    const name = parameters.get("run");
    return queue && name ? {queue, name} : null;
  }

  private selectWorkload(
    selection: WorkloadSelection | null,
    replace = false,
  ): void {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("page", this.definition.page);
    if (selection) {
      url.searchParams.set("queue", selection.queue);
      url.searchParams.set("run", selection.name);
    }
    const state = {page: this.definition.page, selection};
    if (replace) window.history.replaceState(state, "", url);
    else window.history.pushState(state, "", url);
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
