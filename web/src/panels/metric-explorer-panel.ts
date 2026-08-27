import type {
  MetricCatalogEntry,
  MetricsPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

type SortKey = "name" | "current" | "average" | "p95" | "maximum";

export class MetricExplorerPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly tableBody: HTMLTableSectionElement;
  private readonly search: HTMLInputElement;
  private readonly sort: HTMLSelectElement;
  private readonly create: HTMLButtonElement;
  private readonly count: HTMLElement;
  private catalog: MetricCatalogEntry[] = [];
  private readonly selected = new Set<string>();
  private lastLoaded = 0;
  private loading = false;

  constructor(
    definition: MetricsPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "metric-explorer-panel");
    this.element = shell.element;
    const controls = document.createElement("div");
    controls.className = "table-controls";
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.placeholder = "Filter metrics";
    this.search.autocomplete = "off";
    this.search.addEventListener("input", () => this.render());
    this.sort = document.createElement("select");
    const sortOptions: Array<[SortKey, string]> = [
      ["name", "Name"],
      ["current", "Current"],
      ["average", "Average"],
      ["p95", "P95"],
      ["maximum", "Maximum"],
    ];
    for (const [value, label] of sortOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = `Sort: ${label}`;
      this.sort.append(option);
    }
    this.sort.addEventListener("change", () => this.render());
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
    controls.append(this.search, this.sort, this.count, this.create);

    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";
    const table = document.createElement("table");
    table.className = "metric-table";
    const head = document.createElement("thead");
    head.innerHTML = `
      <tr><th></th><th>Metric</th><th>Current</th><th>Min</th>
      <th>Average</th><th>P95</th><th>Max</th><th>Samples</th></tr>
    `;
    this.tableBody = document.createElement("tbody");
    table.append(head, this.tableBody);
    wrapper.append(table);
    shell.body.append(controls, wrapper);
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
    const sort = this.sort.value as SortKey;
    const filtered = this.catalog
      .filter(item => !query || item.name.toLowerCase().includes(query))
      .sort((left, right) =>
        sort === "name"
          ? left.name.localeCompare(right.name)
          : right[sort] - left[sort],
      );
    this.count.textContent = `${filtered.length} / ${this.catalog.length}`;
    const fragment = document.createDocumentFragment();
    for (const item of filtered) {
      const row = document.createElement("tr");
      const selectCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = this.selected.has(item.name);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(item.name);
        else this.selected.delete(item.name);
        this.create.disabled = this.selected.size === 0;
      });
      selectCell.append(checkbox);
      row.append(
        selectCell,
        cell(item.name, "metric-name"),
        cell(format(item.current, item.metadata.unit)),
        cell(format(item.minimum, item.metadata.unit)),
        cell(format(item.average, item.metadata.unit)),
        cell(format(item.p95, item.metadata.unit)),
        cell(format(item.maximum, item.metadata.unit)),
        cell(String(item.samples)),
      );
      row.addEventListener("dblclick", () =>
        this.context.actions.createChart([item.name]),
      );
      fragment.append(row);
    }
    this.tableBody.replaceChildren(fragment);
  }
}

function cell(value: string, className = ""): HTMLTableCellElement {
  const output = document.createElement("td");
  output.className = className;
  output.textContent = value;
  return output;
}

function format(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "--";
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)}${unit ? ` ${unit}` : ""}`;
}
