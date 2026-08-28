import type {
  MetricCatalogEntry,
  MetricsPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import {
  DataTable,
  type DataColumn,
  type SortDirection,
} from "./data-table";
import {
  pageButton,
  tableFooter,
  TABLE_PAGE_SIZE,
} from "./table-controls";

type SortKey = "name" | "current" | "average" | "p95" | "maximum";

export class MetricExplorerPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly table: DataTable<MetricCatalogEntry>;
  private readonly columns: DataColumn<MetricCatalogEntry>[];
  private readonly search: HTMLInputElement;
  private sort: SortKey = "name";
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
      this.render();
    });
    this.next = pageButton("Next", () => {
      this.page++;
      this.render();
    });
    controls.append(this.search, this.create);

    this.columns = this.metricColumns(
      definition.columns ?? [
        "select",
        "name",
        "current",
        "minimum",
        "average",
        "p95",
        "maximum",
        "samples",
      ],
    );
    this.table = new DataTable(
      this.columns,
      "metric-explorer-table",
      (value, direction) => {
        this.sort = value as SortKey;
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
      .sort((left, right) => {
        const result = this.sort === "name"
          ? left.name.localeCompare(right.name)
          : left[this.sort] - right[this.sort];
        return this.sortDirection === "asc" ? result : -result;
      });
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

  private metricColumns(ids: string[]): DataColumn<MetricCatalogEntry>[] {
    const columns: Record<string, DataColumn<MetricCatalogEntry>> = {
      select: {
        id: "select",
        label: "",
        width: "48px",
        render: item => {
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
      name: {
        id: "name",
        label: "Metric",
        sortValue: "name",
        className: "metric-name",
        width: "480px",
        pinned: true,
        render: item => item.name,
      },
      current: metricValueColumn("current", "Current"),
      minimum: metricValueColumn("minimum", "Min"),
      average: metricValueColumn("average", "Average"),
      p95: metricValueColumn("p95", "P95"),
      maximum: metricValueColumn("maximum", "Max"),
      samples: {
        id: "samples",
        label: "Samples",
        width: "90px",
        render: item => String(item.samples),
      },
    };
    return ids.map(id => columns[id]).filter(
      (column): column is DataColumn<MetricCatalogEntry> => column !== undefined,
    );
  }
}

function metricValueColumn(
  id: "current" | "minimum" | "average" | "p95" | "maximum",
  label: string,
): DataColumn<MetricCatalogEntry> {
  return {
    id,
    label,
    width: "140px",
    ...(id === "minimum" ? {} : {sortValue: id}),
    render: item => format(item[id], item.metadata.unit),
  };
}

function format(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "--";
  if (unit === "bytes") return formatBytes(value);
  if (unit === "s" && value >= 120) return formatDuration(value);
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)}${unit ? ` ${unit}` : ""}`;
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = Math.abs(value);
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index++;
  }
  const sign = value < 0 ? "-" : "";
  return `${sign}${scaled.toFixed(scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDuration(value: number): string {
  if (value >= 86400) return `${(value / 86400).toFixed(1)} d`;
  if (value >= 3600) return `${(value / 3600).toFixed(1)} h`;
  return `${(value / 60).toFixed(1)} min`;
}
