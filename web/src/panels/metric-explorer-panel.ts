import type {
  MetricCatalogEntry,
  MetricsPanelDefinition,
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

export class MetricExplorerPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly table: DataTable<MetricCatalogEntry>;
  private readonly columns: DataColumn<MetricCatalogEntry>[];
  private readonly search: HTMLInputElement;
  private sort = "name";
  private sortDirection: SortDirection = "asc";
  private readonly create: HTMLButtonElement;
  private readonly count: HTMLElement;
  private readonly previous: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private catalog: MetricCatalogEntry[] = [];
  private readonly selected = new Set<string>();
  private lastLoaded = 0;
  private loading = false;
  private page = 0;

  constructor(
    definition: MetricsPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "metric-explorer-panel");
    this.element = shell.element;
    const controls = document.createElement("div");
    controls.className = "table-controls data-grid-toolbar";
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.placeholder = "Filter metrics";
    this.search.autocomplete = "off";
    this.search.addEventListener("input", () => {
      this.page = 0;
      this.table.scrollToTop();
      this.render();
    });
    this.create = document.createElement("button");
    this.create.type = "button";
    this.create.className = "button button-primary";
    this.create.textContent = "Create chart";
    this.create.disabled = true;
    this.create.addEventListener("click", () =>
      context.actions.createChart([...this.selected]),
    );
    this.count = document.createElement("span");
    this.count.className = "table-count";
    this.previous = pageButton("Previous", () => {
      this.page = Math.max(0, this.page - 1);
      this.table.scrollToTop();
      this.render();
    });
    this.next = pageButton("Next", () => {
      this.page++;
      this.table.scrollToTop();
      this.render();
    });
    controls.append(this.search, this.create);

    this.columns = configuredColumns(
      definition.columns ?? [],
      {
        select: item => {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = this.selected.has(item.name);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) this.selected.add(item.name);
            else this.selected.delete(item.name);
            this.create.disabled = this.selected.size === 0;
          });
          return checkbox;
        },
      },
    );
    this.table = new DataTable(
      this.columns,
      "metric-explorer-table",
      (value, direction) => {
        this.sort = value;
        this.sortDirection = direction;
        this.page = 0;
        this.render();
      },
      item => this.context.actions.createChart([item.name]),
      {value: this.sort, direction: this.sortDirection},
    );
    this.table.element.append(
      tableFooter(this.count, this.previous, this.next),
    );
    shell.body.append(controls, this.table.element);
    void this.load();
  }

  update(): void {
    if (Date.now() - this.lastLoaded > 10_000) void this.load();
  }

  destroy(): void {}

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.catalog = await this.context.actions.loadCatalog();
      this.lastLoaded = Date.now();
      this.render();
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const query = this.search.value.trim().toLowerCase();
    const filtered = this.catalog
      .filter(item => !query || item.name.toLowerCase().includes(query))
      .sort((left, right) =>
        compareByPath(left, right, this.sort, this.sortDirection),
      );
    const pages = Math.max(1, Math.ceil(filtered.length / TABLE_PAGE_SIZE));
    this.page = Math.min(this.page, pages - 1);
    const pageRows = filtered.slice(
      this.page * TABLE_PAGE_SIZE,
      (this.page + 1) * TABLE_PAGE_SIZE,
    );
    this.count.textContent =
      `${filtered.length} / ${this.catalog.length} | ${this.page + 1}/${pages}`;
    this.previous.disabled = this.page === 0;
    this.next.disabled = this.page >= pages - 1;
    this.table.setRows(pageRows, this.columns, "No metrics match the filter");
  }

}
