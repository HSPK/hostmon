import type {
  MetricCatalogEntry,
  MetricTablePanelDefinition,
  TableColumnDefinition,
} from "../domain/types";
import type {PanelContext, PanelRenderer} from "./panel";
import {
  panelActionButton,
  panelShell,
  PanelFeedback,
} from "./panel";
import {
  compareByPath,
  configuredColumns,
  DataTable,
  type DataColumn,
  type SortDirection,
} from "./data-table";
import {catalogWindowLabel} from "./catalog-window";

const DEFAULT_COLUMNS: TableColumnDefinition[] = [
  {id: "name", label: "Metric", path: "name", width: "420px", mobileWidth: "150px", pinned: true, sort: "name"},
  {id: "current", label: "Current", path: "current", width: "130px", mobileWidth: "110px", format: "metric", sort: "current"},
  {id: "minimum", label: "Min", path: "minimum", width: "130px", mobileWidth: "110px", format: "metric", sort: "minimum"},
  {id: "average", label: "Average", path: "average", width: "130px", mobileWidth: "110px", format: "metric", sort: "average"},
  {id: "p95", label: "P95", path: "p95", width: "130px", mobileWidth: "110px", format: "metric", sort: "p95"},
  {id: "maximum", label: "Max", path: "maximum", width: "130px", mobileWidth: "110px", format: "metric", sort: "maximum"},
];

export class MetricTablePanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly table: DataTable<MetricCatalogEntry>;
  private readonly columns: DataColumn<MetricCatalogEntry>[];
  private readonly windowLabel: HTMLElement;
  private readonly feedback = new PanelFeedback();
  private rows: MetricCatalogEntry[] = [];
  private sort = "name";
  private sortDirection: SortDirection = "asc";
  private loadedWindowSeconds = 0;
  private lastLoaded = 0;
  private loading = false;
  private loadingWindowSeconds: number | null = null;
  private loadQueued = false;

  constructor(
    private readonly definition: MetricTablePanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "metric-table-panel");
    this.element = shell.element;
    this.windowLabel = document.createElement("span");
    this.windowLabel.className = "catalog-window";
    const actions = document.createElement("div");
    actions.className = "panel-actions";
    actions.append(
      panelActionButton("Edit", () => context.actions.editPanel(definition)),
    );
    if (definition.custom) {
      actions.append(
        panelActionButton(
          "Delete",
          () => context.actions.removePanel(definition.id),
        ),
      );
    }
    shell.header.append(this.windowLabel, actions);
    this.columns = configuredColumns(definition.columns ?? DEFAULT_COLUMNS);
    this.table = new DataTable(
      this.columns,
      "custom-metric-table",
      (value, direction) => {
        this.sort = value;
        this.sortDirection = direction;
        this.render();
      },
      undefined,
      {value: this.sort, direction: this.sortDirection},
    );
    shell.body.append(this.feedback.element, this.table.element);
    void this.load();
  }

  update(): void {
    if (
      this.loadedWindowSeconds !== this.context.actions.windowSeconds() ||
      Date.now() - this.lastLoaded > 10_000
    ) {
      void this.load();
    }
  }

  refresh(): void {
    void this.load(true);
  }

  destroy(): void {}

  private async load(force = false): Promise<void> {
    const requestedSeconds = this.context.actions.windowSeconds();
    if (this.loading) {
      if (force || requestedSeconds !== this.loadingWindowSeconds) {
        this.loadQueued = true;
      }
      return;
    }
    this.loading = true;
    this.loadingWindowSeconds = requestedSeconds;
    try {
      const response = await this.context.actions.loadCatalog();
      if (requestedSeconds !== this.context.actions.windowSeconds()) {
        this.loadQueued = true;
        return;
      }
      const byName = new Map(
        response.metrics.map(metric => [metric.name, metric]),
      );
      this.rows = this.definition.metrics
        .map(metric => byName.get(metric))
        .filter(row => row !== undefined);
      const label = catalogWindowLabel(
        response.seconds,
        requestedSeconds,
        "selection",
      );
      this.windowLabel.textContent = label.text;
      this.windowLabel.title = label.title;
      this.loadedWindowSeconds = requestedSeconds;
      this.lastLoaded = Date.now();
      this.feedback.clear();
      this.render();
    } catch (error) {
      if (requestedSeconds !== this.context.actions.windowSeconds()) {
        this.loadQueued = true;
      } else {
        this.feedback.show("Could not load metric table", error);
      }
    } finally {
      this.loading = false;
      this.loadingWindowSeconds = null;
      if (this.loadQueued) {
        this.loadQueued = false;
        void this.load();
      }
    }
  }

  private render(): void {
    const rows = [...this.rows].sort((left, right) =>
      compareByPath(left, right, this.sort, this.sortDirection),
    );
    this.table.setRows(rows, this.columns, "No selected metrics are available");
  }
}
