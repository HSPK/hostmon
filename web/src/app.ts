import { DASHBOARD, NAVIGATION } from "./config/dashboard";
import { ApiClient } from "./core/api-client";
import { PreferenceStore } from "./core/preferences";
import { TimeSeriesStore } from "./core/time-series-store";
import { RealtimeClient } from "./core/websocket-client";
import type {
  ConnectionState,
  MetricCatalogEntry,
  PageId,
  PanelDefinition,
  TimeSeriesPanelDefinition,
} from "./domain/types";
import type { PanelRenderer } from "./panels/panel";
import { createPanelRegistry } from "./panels/registry";

export class DashboardApp {
  private readonly api = new ApiClient();
  private readonly preferences = new PreferenceStore(DASHBOARD);
  private readonly store: TimeSeriesStore;
  private readonly registry = createPanelRegistry();
  private readonly realtime: RealtimeClient;
  private readonly panels: PanelRenderer[] = [];
  private readonly root: HTMLElement;
  private panelsRoot!: HTMLElement;
  private settingsDrawer!: HTMLElement;
  private chartDialog!: HTMLDialogElement;
  private connectionDot!: HTMLElement;
  private connectionText!: HTMLElement;
  private hostText!: HTMLElement;
  private sampleAge!: HTMLElement;
  private pauseButton!: HTMLButtonElement;
  private refreshController: AbortController | null = null;
  private catalogCache: { loadedAt: number; entries: MetricCatalogEntry[] } | null =
    null;
  private updateQueued = false;
  private paused = false;
  private editingPanel: TimeSeriesPanelDefinition | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    const tracked = this.allPanels()
      .filter(
        (panel): panel is TimeSeriesPanelDefinition =>
          panel.type === "timeseries",
      )
      .flatMap(panel => panel.metrics);
    this.store = new TimeSeriesStore(21600, tracked);
    this.realtime = new RealtimeClient({
      onSnapshot: snapshot => {
        this.store.append(snapshot);
        this.catalogCache = null;
      },
      onState: state => this.setConnectionState(state),
    });
  }

  async start(): Promise<void> {
    this.buildShell();
    const preferences = this.preferences.get();
    this.store.setWindow(preferences.windowSeconds);
    this.bindControls();
    this.store.subscribe(() => this.queuePanelUpdate());
    await this.reloadData();
    this.renderNavigation();
    this.renderPanels();
    this.realtime.start();
    window.setInterval(() => this.updateSampleAge(), 1000);
    window.addEventListener("beforeunload", () => this.destroy(), { once: true });
  }

  private buildShell(): void {
    this.root.innerHTML = `
      <div class="app-shell">
        <aside class="sidebar">
          <div class="product"><span class="product-mark">HM</span><div><strong>hostmon</strong><small>operations console</small></div></div>
          <nav id="navigation" aria-label="Dashboard pages"></nav>
          <div class="sidebar-footer"><span id="sidebar-host">--</span><span id="sidebar-version">--</span></div>
        </aside>
        <section class="workspace">
          <header class="toolbar">
            <div class="toolbar-title"><button id="mobile-menu" class="icon-button mobile-menu" type="button">Menu</button><div><h1 id="page-title">Overview</h1><p id="host-text">waiting for data</p></div></div>
            <div class="toolbar-actions">
              <div class="connection"><span id="connection-dot" class="connection-dot"></span><span id="connection-text">connecting</span><span id="sample-age">--</span></div>
              <input id="metric-search" class="toolbar-search" type="search" placeholder="Find metric" aria-label="Find metric">
              <label class="control">Window<select id="window-select"><option value="900">15m</option><option value="3600">1h</option><option value="21600">6h</option></select></label>
              <button id="refresh-button" class="button" type="button">Refresh</button>
              <button id="pause-button" class="button" type="button">Pause</button>
              <button id="add-chart-button" class="button" type="button">Add chart</button>
              <button id="export-button" class="button" type="button">Export</button>
              <button id="customize-button" class="button" type="button">Layout</button>
            </div>
          </header>
          <main><div id="panels" class="panel-grid"></div></main>
        </section>
      </div>
      <aside id="settings-drawer" class="settings-drawer" aria-hidden="true">
        <header><div><h2>Panel layout</h2><p>Visibility and order are stored in this browser.</p></div><button id="settings-close" class="icon-button" type="button">Close</button></header>
        <div id="panel-settings" class="panel-settings"></div>
        <footer><button id="settings-reset" class="button" type="button">Reset layout</button></footer>
      </aside>
      <div id="drawer-backdrop" class="drawer-backdrop"></div>
      <dialog id="chart-dialog" class="chart-dialog">
        <form id="chart-form" method="dialog">
          <header><div><h2 id="chart-dialog-title">Create chart</h2><p>Choose up to eight metrics.</p></div><button class="icon-button" value="cancel">Close</button></header>
          <div class="form-grid">
            <label>Title<input id="chart-title" required maxlength="80"></label>
            <label>Style<select id="chart-style"><option value="line">Line</option><option value="area">Area</option></select></label>
            <label>Width<select id="chart-width"><option value="1">One column</option><option value="2">Full width</option></select></label>
            <label>Y minimum<input id="chart-min" type="number" step="any" placeholder="Auto"></label>
            <label>Y maximum<input id="chart-max" type="number" step="any" placeholder="Auto"></label>
            <label class="metric-filter-label">Filter metrics<input id="chart-metric-filter" type="search" placeholder="cpu, gpu, latency..."></label>
          </div>
          <div id="chart-metrics" class="metric-picker"></div>
          <footer><span id="chart-selection-count">0 selected</span><div><button class="button" value="cancel">Cancel</button><button id="chart-save" class="button button-primary" value="default">Save chart</button></div></footer>
        </form>
      </dialog>
    `;
    this.panelsRoot = this.required("panels");
    this.settingsDrawer = this.required("settings-drawer");
    this.chartDialog = this.required("chart-dialog") as HTMLDialogElement;
    this.connectionDot = this.required("connection-dot");
    this.connectionText = this.required("connection-text");
    this.hostText = this.required("host-text");
    this.sampleAge = this.required("sample-age");
    this.pauseButton = this.required("pause-button") as HTMLButtonElement;
    (this.required("window-select") as HTMLSelectElement).value = String(
      this.preferences.get().windowSeconds,
    );
    this.renderSettings();
  }

  private bindControls(): void {
    this.required("window-select").addEventListener("change", event => {
      const seconds = Number((event.target as HTMLSelectElement).value);
      this.preferences.setWindow(seconds);
      this.store.setWindow(seconds);
      this.catalogCache = null;
      void this.reloadData();
    });
    this.pauseButton.addEventListener("click", () => {
      this.paused = !this.paused;
      this.pauseButton.textContent = this.paused ? "Resume" : "Pause";
      this.realtime.setPaused(this.paused);
      if (!this.paused) void this.reloadData();
    });
    this.required("refresh-button").addEventListener("click", () => {
      this.catalogCache = null;
      void this.reloadData();
    });
    this.required("add-chart-button").addEventListener("click", () =>
      this.openChartEditor(),
    );
    this.required("export-button").addEventListener("click", () => this.exportCsv());
    this.required("customize-button").addEventListener("click", () =>
      this.toggleDrawer(true),
    );
    this.required("settings-close").addEventListener("click", () =>
      this.toggleDrawer(false),
    );
    this.required("drawer-backdrop").addEventListener("click", () =>
      this.toggleDrawer(false),
    );
    this.required("settings-reset").addEventListener("click", () => {
      this.preferences.reset();
      const preferences = this.preferences.get();
      this.store.setWindow(preferences.windowSeconds);
      (this.required("window-select") as HTMLSelectElement).value = String(
        preferences.windowSeconds,
      );
      this.renderNavigation();
      this.renderSettings();
      this.renderPanels();
      void this.reloadData();
    });
    this.required("metric-search").addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      this.navigate("metrics");
      requestAnimationFrame(() => {
        const search = document.querySelector<HTMLInputElement>(
          ".metric-explorer-panel input[type=search]",
        );
        if (!search) return;
        search.value = (event.target as HTMLInputElement).value;
        search.dispatchEvent(new Event("input"));
        search.focus();
      });
    });
    this.required("mobile-menu").addEventListener("click", () =>
      document.querySelector(".sidebar")?.classList.toggle("open"),
    );
    this.required("chart-metric-filter").addEventListener("input", () =>
      this.renderMetricPicker(),
    );
    this.required("chart-form").addEventListener("submit", event => {
      event.preventDefault();
      void this.saveChart();
    });
    window.addEventListener("keydown", event => {
      if (event.key === "Escape") this.toggleDrawer(false);
    });
  }

  private async reloadData(): Promise<void> {
    this.refreshController?.abort();
    const controller = new AbortController();
    this.refreshController = controller;
    try {
      const [history, status] = await Promise.all([
        this.api.history(
          this.store.windowSeconds,
          1800,
          controller.signal,
          this.store.tracked(),
        ),
        this.api.status(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      this.store.replaceHistory(history);
      this.store.applyStatus(status);
      this.hostText.textContent = status.host;
      this.required("sidebar-host").textContent = status.host;
      this.required("sidebar-version").textContent = `v${status.version}`;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.setConnectionState("offline");
        console.error(error);
      }
    }
  }

  private async loadCatalog(): Promise<MetricCatalogEntry[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.loadedAt < 5000) {
      return this.catalogCache.entries;
    }
    const response = await this.api.catalog(this.store.windowSeconds);
    this.catalogCache = {loadedAt: Date.now(), entries: response.metrics};
    return response.metrics;
  }

  private renderNavigation(): void {
    const active = this.preferences.get().activePage;
    const root = this.required("navigation");
    const fragment = document.createDocumentFragment();
    for (const item of NAVIGATION) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "nav-item";
      button.classList.toggle("active", item.id === active);
      button.textContent = item.label;
      button.addEventListener("click", () => this.navigate(item.id));
      fragment.append(button);
    }
    root.replaceChildren(fragment);
    const current = NAVIGATION.find(item => item.id === active);
    this.required("page-title").textContent = current?.label ?? "Overview";
  }

  private navigate(page: PageId): void {
    this.preferences.setActivePage(page);
    this.renderNavigation();
    this.renderPanels();
    document.querySelector(".sidebar")?.classList.remove("open");
  }

  private renderPanels(): void {
    for (const panel of this.panels) panel.destroy();
    this.panels.length = 0;
    const fragment = document.createDocumentFragment();
    for (const definition of this.preferences.visiblePanels()) {
      const panel = this.registry.create(definition, {
        store: this.store,
        actions: {
          loadCatalog: () => this.loadCatalog(),
          createChart: metrics => this.openChartEditor(undefined, metrics),
          editChart: chart => this.openChartEditor(chart),
          removeChart: id => this.removeChart(id),
        },
      });
      this.panels.push(panel);
      fragment.append(panel.element);
    }
    this.panelsRoot.replaceChildren(fragment);
    this.queuePanelUpdate();
  }

  private queuePanelUpdate(): void {
    if (this.updateQueued) return;
    this.updateQueued = true;
    requestAnimationFrame(() => {
      this.updateQueued = false;
      for (const panel of this.panels) panel.update();
      this.hostText.textContent = this.store.host || "localhost";
      this.updateSampleAge();
    });
  }

  private renderSettings(): void {
    const root = this.required("panel-settings");
    const preferences = this.preferences.get();
    const fragment = document.createDocumentFragment();
    for (const definition of orderedDefinitions(
      preferences.panelOrder,
      this.allPanels(),
    )) {
      const row = document.createElement("div");
      row.className = "panel-setting";
      const visible = !preferences.hiddenPanels.includes(definition.id);
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = visible;
      checkbox.addEventListener("change", () => {
        this.preferences.setVisible(definition.id, checkbox.checked);
        this.renderPanels();
      });
      label.append(
        checkbox,
        document.createTextNode(`${definition.title} (${definition.page})`),
      );
      const actions = document.createElement("div");
      actions.className = "order-actions";
      actions.append(
        orderButton("Up", () => this.movePanel(definition.id, -1)),
        orderButton("Down", () => this.movePanel(definition.id, 1)),
      );
      row.append(label, actions);
      fragment.append(row);
    }
    root.replaceChildren(fragment);
  }

  private movePanel(id: string, direction: -1 | 1): void {
    this.preferences.move(id, direction);
    this.renderSettings();
    this.renderPanels();
  }

  private openChartEditor(
    panel?: TimeSeriesPanelDefinition,
    initialMetrics: string[] = [],
  ): void {
    this.editingPanel = panel ?? null;
    this.required("chart-dialog-title").textContent = panel
      ? "Edit chart"
      : "Create chart";
    (this.required("chart-title") as HTMLInputElement).value =
      panel?.title ?? "Custom metrics";
    (this.required("chart-style") as HTMLSelectElement).value =
      panel?.style ?? "line";
    (this.required("chart-width") as HTMLSelectElement).value = String(
      panel?.columnSpan ?? 1,
    );
    (this.required("chart-min") as HTMLInputElement).value =
      panel?.range?.[0] === undefined ? "" : String(panel.range[0]);
    (this.required("chart-max") as HTMLInputElement).value =
      panel?.range?.[1] === undefined ? "" : String(panel.range[1]);
    (this.required("chart-metric-filter") as HTMLInputElement).value = "";
    this.chartDialog.dataset.selected = JSON.stringify(
      panel?.metrics ?? initialMetrics,
    );
    this.renderMetricPicker();
    this.chartDialog.showModal();
  }

  private renderMetricPicker(): void {
    const filter = (
      this.required("chart-metric-filter") as HTMLInputElement
    ).value.toLowerCase();
    const selected = new Set<string>(
      JSON.parse(this.chartDialog.dataset.selected ?? "[]") as string[],
    );
    const metrics = Object.keys(this.store.latestMetrics)
      .filter(name => !filter || name.toLowerCase().includes(filter))
      .sort();
    const fragment = document.createDocumentFragment();
    for (const metric of metrics) {
      const label = document.createElement("label");
      label.className = "metric-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(metric);
      checkbox.disabled = !checkbox.checked && selected.size >= 8;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(metric);
        else selected.delete(metric);
        this.chartDialog.dataset.selected = JSON.stringify([...selected]);
        this.renderMetricPicker();
      });
      label.append(checkbox, document.createTextNode(metric));
      fragment.append(label);
    }
    this.required("chart-metrics").replaceChildren(fragment);
    this.required("chart-selection-count").textContent =
      `${selected.size} selected`;
  }

  private async saveChart(): Promise<void> {
    const metrics = JSON.parse(
      this.chartDialog.dataset.selected ?? "[]",
    ) as string[];
    if (!metrics.length || metrics.length > 8) return;
    const title = (this.required("chart-title") as HTMLInputElement).value.trim();
    if (!title) return;
    const minimum = optionalNumber(
      (this.required("chart-min") as HTMLInputElement).value,
    );
    const maximum = optionalNumber(
      (this.required("chart-max") as HTMLInputElement).value,
    );
    const range =
      minimum !== undefined &&
      maximum !== undefined &&
      minimum < maximum
        ? ([minimum, maximum] as [number, number])
        : undefined;
    const panel: TimeSeriesPanelDefinition = {
      id:
        this.editingPanel?.id ??
        `custom-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      type: "timeseries",
      page: "metrics",
      custom: true,
      title,
      metrics,
      style: (this.required("chart-style") as HTMLSelectElement).value as
        | "line"
        | "area",
      columnSpan: Number(
        (this.required("chart-width") as HTMLSelectElement).value,
      ) as 1 | 2,
      ...(range ? {range} : {}),
    };
    this.preferences.saveCustomPanel(panel);
    this.store.track(metrics);
    this.chartDialog.close();
    this.navigate("metrics");
    await this.reloadData();
    this.renderSettings();
    this.renderPanels();
  }

  private removeChart(panelId: string): void {
    if (!window.confirm("Delete this custom chart?")) return;
    this.preferences.removeCustomPanel(panelId);
    this.renderSettings();
    this.renderPanels();
  }

  private toggleDrawer(open: boolean): void {
    this.settingsDrawer.classList.toggle("open", open);
    this.settingsDrawer.setAttribute("aria-hidden", String(!open));
    this.required("drawer-backdrop").classList.toggle("open", open);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionDot.dataset.state = state;
    this.connectionText.textContent = state;
  }

  private updateSampleAge(): void {
    if (!this.store.latestTimestamp) {
      this.sampleAge.textContent = "--";
      return;
    }
    const age = Math.max(0, Date.now() / 1000 - this.store.latestTimestamp);
    this.sampleAge.textContent = `${age.toFixed(0)}s`;
    this.sampleAge.classList.toggle("stale", age > 30);
  }

  private exportCsv(): void {
    const metrics = this.allPanels()
      .filter(
        (panel): panel is TimeSeriesPanelDefinition =>
          panel.type === "timeseries",
      )
      .flatMap(panel => panel.metrics);
    const blob = new Blob([this.store.exportCsv([...new Set(metrics)])], {
      type: "text/csv;charset=utf-8",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `hostmon-${new Date().toISOString()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private allPanels(): PanelDefinition[] {
    return [...DASHBOARD.panels, ...this.preferences.get().customPanels];
  }

  private required(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing dashboard element: ${id}`);
    return element;
  }

  private destroy(): void {
    this.refreshController?.abort();
    this.realtime.stop();
    for (const panel of this.panels) panel.destroy();
  }
}

function orderedDefinitions(
  order: string[],
  definitions: PanelDefinition[],
): PanelDefinition[] {
  const available = new Map(definitions.map(panel => [panel.id, panel]));
  const ordered = order
    .map(id => available.get(id))
    .filter((panel): panel is PanelDefinition => panel !== undefined);
  for (const panel of definitions) {
    if (!ordered.some(item => item.id === panel.id)) ordered.push(panel);
  }
  return ordered;
}

function orderButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "table-action";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
