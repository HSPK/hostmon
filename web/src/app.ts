import { notifyAppearanceChanged } from "./core/appearance";
import { ApiClient } from "./core/api-client";
import {
  PREFERENCE_FIELDS,
  PreferenceStore,
  type PreferenceField,
} from "./core/preferences";
import { TimeSeriesStore } from "./core/time-series-store";
import { RealtimeClient } from "./core/websocket-client";
import type {
  ConnectionState,
  DashboardDefinition,
  DashboardPreferences,
  MetricCatalogEntry,
  PageId,
  PanelDefinition,
  TimeSeriesPanelDefinition,
} from "./domain/types";
import type { PanelRenderer } from "./panels/panel";
import { createPanelRegistry } from "./panels/registry";

export class DashboardApp {
  private readonly api: ApiClient;
  private readonly preferences: PreferenceStore;
  private readonly dashboard: DashboardDefinition;
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
  private operationLatency!: HTMLElement;
  private refreshController: AbortController | null = null;
  private catalogCache: { loadedAt: number; entries: MetricCatalogEntry[] } | null =
    null;
  private readonly pluginCache = new Map<
    string,
    {loadedAt: number; document: unknown}
  >();
  private updateQueued = false;
  private renderGeneration = 0;
  private paused = false;
  private editingPanel: TimeSeriesPanelDefinition | null = null;
  private preferenceSaveRunning = false;
  private readonly preferenceSaveFields = new Set<PreferenceField>();
  private preferenceSaveRetry: number | null = null;
  private preferenceReplacePending = false;
  private serverPreferencesLoaded = false;
  private serverPreferences: DashboardPreferences | null = null;
  private readonly handlePopState = (): void => {
    this.navigate(this.pageFromLocation() ?? "overview", false);
  };

  constructor(root: HTMLElement, dashboard: DashboardDefinition) {
    this.root = root;
    this.dashboard = dashboard;
    this.preferences = new PreferenceStore(dashboard);
    this.api = new ApiClient((_url, milliseconds) => {
      if (this.operationLatency) {
        this.operationLatency.textContent = `API ${milliseconds.toFixed(1)} ms`;
      }
    });
    this.store = new TimeSeriesStore(
      30 * 24 * 60 * 60,
      this.trackedPanelMetrics(),
      2400,
    );
    this.realtime = new RealtimeClient({
      onSnapshot: snapshot => {
        this.store.append(snapshot);
        this.catalogCache = null;
        this.pluginCache.clear();
      },
      onState: state => this.setConnectionState(state),
    });
  }

  async start(): Promise<void> {
    this.applyAppearance();
    await this.hydratePreferences();
    this.applyAppearance();
    this.buildShell();
    const routedPage = this.pageFromLocation();
    if (routedPage) {
      this.preferences.setActivePage(routedPage, false);
    } else {
      this.updatePageRoute(this.preferences.get().activePage, true);
    }
    this.preferences.setPersistence((_value, fields, replace) =>
      this.queuePreferenceSave(fields, replace),
    );
    const pending = this.preferences.pendingFields();
    if (pending.length) {
      this.queuePreferenceSave(
        pending,
        this.serverPreferencesLoaded && this.serverPreferences === null,
      );
    }
    this.store.track(this.trackedPanelMetrics());
    const preferences = this.preferences.get();
    this.store.setWindow(preferences.windowSeconds);
    this.bindControls();
    this.store.subscribe(() => this.queuePanelUpdate());
    await this.reloadData();
    this.renderNavigation();
    this.renderPanels();
    this.realtime.start();
    window.addEventListener("popstate", this.handlePopState);
    window.addEventListener("beforeunload", () => this.destroy(), { once: true });
  }

  private async hydratePreferences(): Promise<void> {
    try {
      const preferences = await this.api.preferences();
      this.serverPreferencesLoaded = true;
      this.serverPreferences = preferences;
      if (preferences) this.preferences.hydrate(preferences);
      else if (this.preferences.hasLocalPreferences()) {
        this.preferences.markPending(PREFERENCE_FIELDS);
      }
    } catch (error) {
      console.error("Dashboard preferences could not be loaded", error);
    }
  }

  private queuePreferenceSave(
    fields: PreferenceField[] = [],
    replace = false,
  ): void {
    for (const field of fields) this.preferenceSaveFields.add(field);
    this.preferenceReplacePending =
      this.preferenceReplacePending || replace;
    if (
      this.preferenceSaveRunning ||
      this.preferenceSaveRetry !== null ||
      !this.preferenceSaveFields.size
    ) {
      return;
    }
    this.preferenceSaveRunning = true;
    void this.flushPreferenceSaves();
  }

  private async flushPreferenceSaves(): Promise<void> {
    let failed = false;
    let replaceInFlight = false;
    try {
      while (this.preferenceSaveFields.size) {
        if (!this.serverPreferencesLoaded) {
          const preferences = await this.api.preferences();
          this.serverPreferencesLoaded = true;
          this.serverPreferences = preferences;
          if (preferences) this.preferences.hydrate(preferences);
        }
        const fields = [...this.preferenceSaveFields];
        this.preferenceSaveFields.clear();
        const current = this.preferences.get();
        const snapshot = Object.fromEntries(
          fields.map(field => [field, current[field]]),
        ) as Partial<DashboardPreferences>;
        const changes = this.preferencePatch(current, fields);
        const replace =
          this.preferenceReplacePending || this.serverPreferences === null;
        this.preferenceReplacePending = false;
        replaceInFlight = replace;
        this.serverPreferences =
          replace
            ? await this.api.savePreferences(current)
            : await this.api.patchPreferences(changes);
        const latest = this.preferences.get();
        const confirmed = fields.filter(
          field =>
            JSON.stringify(latest[field]) === JSON.stringify(snapshot[field]),
        );
        this.preferences.markPersisted(confirmed);
        this.preferences.hydrate(this.serverPreferences);
        replaceInFlight = false;
      }
    } catch (error) {
      failed = true;
      console.error("Dashboard preferences could not be saved", error);
      if (this.operationLatency) {
        this.operationLatency.textContent = "Preferences save failed";
      }
      for (const field of this.preferences.pendingFields()) {
        this.preferenceSaveFields.add(field);
      }
      this.preferenceReplacePending =
        this.preferenceReplacePending || replaceInFlight;
    } finally {
      this.preferenceSaveRunning = false;
      if (failed) {
        this.preferenceSaveRetry = window.setTimeout(() => {
          this.preferenceSaveRetry = null;
          this.queuePreferenceSave();
        }, 1000);
      } else if (this.preferenceSaveFields.size) {
        this.queuePreferenceSave();
      }
    }
  }

  private preferencePatch(
    current: DashboardPreferences,
    fields: PreferenceField[],
  ): Partial<DashboardPreferences> {
    const changes: Partial<DashboardPreferences> = {};
    for (const field of fields) {
      if (field === "panelState" || field === "panelColumns") {
        const currentValues = current[field];
        const serverValues = this.serverPreferences?.[field] ?? {};
        Object.assign(changes, {
          [field]: Object.fromEntries(
            Object.entries(currentValues).filter(
              ([key, value]) =>
                JSON.stringify(value) !==
                JSON.stringify(serverValues[key]),
            ),
          ),
        });
      } else {
        Object.assign(changes, {[field]: current[field]});
      }
    }
    return changes;
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
              <input id="chart-search" class="toolbar-search" type="search" placeholder="Find chart" aria-label="Find chart">
              <label class="control">Window<select id="window-select"><option value="900">15m</option><option value="3600">1h</option><option value="21600">6h</option><option value="43200">12h</option><option value="86400">24h</option><option value="604800">7d</option><option value="2592000">30d</option></select></label>
              <button id="refresh-button" class="button" type="button">Refresh</button>
              <button id="pause-button" class="button" type="button">Pause</button>
              <button id="add-chart-button" class="button" type="button">Add chart</button>
              <button id="export-button" class="button" type="button">Export</button>
            </div>
          </header>
          <main><div id="panels" class="panel-sections"></div></main>
          <footer class="statusbar">
            <div class="connection"><span id="connection-dot" class="connection-dot"></span><span id="connection-text">connecting</span></div>
            <span id="operation-latency">API -- ms</span>
            <span id="sample-age">Updated -- (UTC+8)</span>
          </footer>
        </section>
      </div>
      <aside id="settings-drawer" class="settings-drawer" aria-hidden="true">
        <header><div><h2>Dashboard layout</h2><p>Navigation, panels, and chart changes are saved by this hostmon service.</p></div><button id="settings-close" class="icon-button" type="button">Close</button></header>
        <section class="layout-settings-section">
          <div class="layout-settings-heading"><div><h3>Navigation sections</h3><p>Group pages and control their sidebar order.</p></div></div>
          <form id="navigation-section-form" class="navigation-section-form">
            <input id="navigation-section-name" aria-label="New section name" maxlength="64" placeholder="New section" required>
            <select id="navigation-section-placement" aria-label="New section placement"><option value="main">Main</option><option value="bottom">Bottom</option></select>
            <button class="button" type="submit">Add section</button>
          </form>
          <div id="navigation-settings" class="navigation-settings"></div>
        </section>
        <section class="layout-settings-section">
          <div class="layout-settings-heading"><div><h3>Panels</h3><p>Control visibility, order, and table columns.</p></div></div>
          <div id="panel-settings" class="panel-settings"></div>
        </section>
        <footer><button id="settings-reset" class="button" type="button">Reset layout</button></footer>
      </aside>
      <div id="drawer-backdrop" class="drawer-backdrop"></div>
      <dialog id="chart-dialog" class="chart-dialog">
        <form id="chart-form" method="dialog">
          <header><div><h2 id="chart-dialog-title">Create chart</h2><p>Choose up to eight metrics.</p></div><button id="chart-close" class="icon-button" type="button">Close</button></header>
          <div class="chart-dialog-body">
            <div class="form-grid">
              <label class="chart-title-label">Title<input id="chart-title" required maxlength="80"></label>
              <label class="chart-page-label">Dashboard page<select id="chart-page"></select></label>
              <label>Style<select id="chart-style"><option value="line">Line</option><option value="area">Area</option></select></label>
              <label>Width<select id="chart-width"><option value="1">One column</option><option value="2">Full width</option></select></label>
              <label>Height<select id="chart-height"><option value="220">Compact</option><option value="270">Standard</option><option value="360">Tall</option><option value="480">Extra tall</option></select></label>
              <label>Line width<input id="chart-line-width" type="number" min="0.5" max="5" step="0.5"></label>
              <label>Y minimum<input id="chart-min" type="number" step="any" placeholder="Auto"></label>
              <label>Y maximum<input id="chart-max" type="number" step="any" placeholder="Auto"></label>
              <label class="metric-filter-label">Filter metrics<input id="chart-metric-filter" type="search" placeholder="cpu, gpu, latency..."></label>
            </div>
            <div class="metric-picker-layout">
              <section><h3>Search results</h3><div id="chart-metric-results" class="metric-list"></div></section>
              <section><h3>Selected metrics</h3><div id="chart-metric-selected" class="metric-list"></div></section>
            </div>
          </div>
          <footer><span id="chart-selection-count">0 selected</span><div><button id="chart-cancel" class="button" type="button">Cancel</button><button id="chart-save" class="button button-primary" value="default">Save chart</button></div></footer>
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
    this.operationLatency = this.required("operation-latency");
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
    this.required("navigation-section-form").addEventListener(
      "submit",
      event => {
        event.preventDefault();
        const name = this.required(
          "navigation-section-name",
        ) as HTMLInputElement;
        const placement = (
          this.required(
            "navigation-section-placement",
          ) as HTMLSelectElement
        ).value as "main" | "bottom";
        if (!this.preferences.addNavigationSection(name.value, placement)) {
          return;
        }
        name.value = "";
        this.renderNavigation();
        this.renderSettings();
      },
    );
    this.required("export-button").addEventListener("click", () => this.exportCsv());
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
    this.required("chart-search").addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      const query = (event.target as HTMLInputElement).value
        .trim()
        .toLowerCase();
      const panel = this.allPanels().find(item => {
        const metrics =
          item.type === "timeseries"
            ? item.metrics
            : item.type === "stats"
              ? item.metrics.map(metric => metric.metric)
              : [];
        return (
          item.title.toLowerCase().includes(query) ||
          item.id.toLowerCase().includes(query) ||
          metrics.some(metric => metric.toLowerCase().includes(query))
        );
      });
      if (!panel) return;
      this.navigate(panel.page);
      this.focusPanel(panel.id);
    });
    this.required("mobile-menu").addEventListener("click", () =>
      document.querySelector(".sidebar")?.classList.toggle("open"),
    );
    this.required("chart-metric-filter").addEventListener("input", () =>
      this.renderMetricPicker(),
    );
    for (const id of ["chart-close", "chart-cancel"]) {
      this.required(id).addEventListener("click", () =>
        this.chartDialog.close(),
      );
    }
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
          this.historyPointBudget(),
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
    const response = await this.api.catalog(
      Math.min(this.store.windowSeconds, 21600),
    );
    this.catalogCache = {loadedAt: Date.now(), entries: response.metrics};
    return response.metrics;
  }

  private async loadPlugin<T>(name: string): Promise<T> {
    const cached = this.pluginCache.get(name);
    if (cached && Date.now() - cached.loadedAt < 5000) {
      return cached.document as T;
    }
    const response = await this.api.plugin<T>(name);
    this.pluginCache.set(name, {
      loadedAt: Date.now(),
      document: response.document,
    });
    return response.document;
  }

  private historyPointBudget(): number {
    const pixels = window.innerWidth * window.devicePixelRatio;
    return Math.min(2400, Math.max(300, Math.ceil(pixels * 1.25)));
  }

  private renderNavigation(): void {
    const preferences = this.preferences.get();
    const active = preferences.activePage;
    const root = this.required("navigation");
    const fragment = document.createDocumentFragment();
    const items = new Map(
      this.dashboard.navigation.map(item => [item.id, item]),
    );
    const sections = preferences.navigationSections;
    for (const placement of ["main", "bottom"] as const) {
      const container = document.createElement("div");
      container.className = `nav-${placement}`;
      const placed = sections.filter(
        section => section.placement === placement,
      );
      if (!placed.length) continue;
      for (const section of placed) {
        const sectionRoot = document.createElement("div");
        sectionRoot.className = "nav-section";
        sectionRoot.dataset.navigationSectionId = section.id;
        if (section.label) {
          const title = document.createElement("h3");
          title.textContent = section.label;
          sectionRoot.append(title);
        }
        for (const page of section.pages) {
          const item = items.get(page);
          if (!item) continue;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "nav-item";
          button.classList.toggle("active", item.id === active);
          button.textContent = item.label;
          button.addEventListener("click", () => this.navigate(item.id));
          sectionRoot.append(button);
        }
        container.append(sectionRoot);
      }
      fragment.append(container);
    }
    root.replaceChildren(fragment);
    const current = this.dashboard.navigation.find(item => item.id === active);
    this.required("page-title").textContent = current?.label ?? "Overview";
  }

  private navigate(page: PageId, updateHistory = true): void {
    const changed = this.preferences.get().activePage !== page;
    this.preferences.setActivePage(page);
    if (updateHistory && changed) this.updatePageRoute(page);
    this.renderNavigation();
    this.renderPanels();
    document.querySelector(".sidebar")?.classList.remove("open");
  }

  private pageFromLocation(): PageId | null {
    const requested = new URL(window.location.href).searchParams.get("page");
    return (
      this.dashboard.navigation.find(item => item.id === requested)?.id ?? null
    );
  }

  private updatePageRoute(page: PageId, replace = false): void {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("page", page);
    this.commitRoute(url, {page}, replace);
  }

  private commitRoute(
    url: URL,
    state: Record<string, unknown>,
    replace: boolean,
  ): void {
    const target = `${url.pathname}${url.search}${url.hash}`;
    if (replace) window.history.replaceState(state, "", target);
    else window.history.pushState(state, "", target);
  }

  private renderPanels(): void {
    const generation = ++this.renderGeneration;
    for (const panel of this.panels) panel.destroy();
    this.panels.length = 0;
    this.panelsRoot.replaceChildren();
    const definitions = this.preferences.visiblePanels();
    document.body.classList.toggle(
      "table-page",
      definitions.length > 0 &&
        definitions.every(definition => this.panelSection(definition) === "Tables"),
    );
    const sections = new Map<string, HTMLElement>();
    for (const definition of definitions) {
      const name = this.panelSection(definition);
      if (sections.has(name)) continue;
      const section = document.createElement("section");
      section.className = "panel-section";
      section.dataset.section = name;
      const title = document.createElement("h2");
      title.className = "panel-section-title";
      title.textContent = name;
      const grid = document.createElement("div");
      grid.className = "panel-grid";
      section.append(title, grid);
      sections.set(name, grid);
      this.panelsRoot.append(section);
    }
    const renderNext = (index: number): void => {
      if (generation !== this.renderGeneration || index >= definitions.length) {
        return;
      }

      const definition = definitions[index]!;
      const panel = this.registry.create(definition, {
        store: this.store,
        actions: {
          loadCatalog: () => this.loadCatalog(),
          loadPlugin: name => this.loadPlugin(name),
          panelState: (panelId, fallback) =>
            this.preferences.panelState(panelId, fallback),
          setPanelState: (panelId, state) =>
            this.preferences.setPanelState(panelId, state),
          loadRules: () => this.api.rules(),
          createRule: rule => this.api.createRule(rule),
          updateRule: (name, rule) => this.api.updateRule(name, rule),
          deleteRule: name => this.api.deleteRule(name),
          loadCollectors: () => this.api.collectors(),
          appearance: () => {
            const {theme, density} = this.preferences.get();
            return {theme, density};
          },
          setAppearance: (theme, density) => {
            this.preferences.setAppearance(theme, density);
            this.applyAppearance();
          },
          openPanelSettings: () => this.toggleDrawer(true),
          createChart: metrics => this.openChartEditor(undefined, metrics),
          editChart: chart => this.openChartEditor(chart),
          removeChart: id => this.removeChart(id),
        },
      });
      this.panels.push(panel);
      sections.get(this.panelSection(definition))?.append(panel.element);
      this.bindPanelDrag(panel.element, definition.id);
      panel.update();
      if (index + 1 < definitions.length) {
        requestAnimationFrame(() => renderNext(index + 1));
      }
    };
    renderNext(0);
  }

  private panelSection(definition: PanelDefinition): string {
    if (definition.section) return definition.section;
    if (definition.type === "timeseries") return "Charts";
    if (definition.type === "stats") return "Summary";
    return "Tables";
  }

  private applyAppearance(): void {
    const {theme, density} = this.preferences.get();
    const resolved =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : theme;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.density = density;
    notifyAppearanceChanged();
  }

  private focusPanel(panelId: string, attempts = 20): void {
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-panel-id="${CSS.escape(panelId)}"]`,
      );
      if (!target && attempts > 1) {
        this.focusPanel(panelId, attempts - 1);
        return;
      }
      target?.scrollIntoView({behavior: "smooth", block: "start"});
      target?.classList.add("panel-highlight");
      window.setTimeout(
        () => target?.classList.remove("panel-highlight"),
        1200,
      );
    });
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
    const preferences = this.preferences.get();
    this.renderNavigationSettings(preferences);
    const root = this.required("panel-settings");
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
      const available = this.dashboard.panels.find(
        panel => panel.id === definition.id,
      )?.columns;
      if (available?.length) {
        const details = document.createElement("details");
        details.className = "column-setting";
        const summary = document.createElement("summary");
        summary.textContent = "Columns";
        const options = document.createElement("div");
        options.className = "column-options";
        const selected = new Set(
          preferences.panelColumns[definition.id] ??
            definition.columns?.map(column => column.id),
        );
        for (const column of available) {
          const option = document.createElement("label");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.checked = selected.has(column.id);
          input.addEventListener("change", () => {
            if (input.checked) selected.add(column.id);
            else selected.delete(column.id);
            if (!selected.size) {
              input.checked = true;
              selected.add(column.id);
              return;
            }
            this.preferences.setPanelColumns(
              definition.id,
              available
                .filter(item => selected.has(item.id))
                .map(item => item.id),
            );
            this.renderPanels();
          });
          option.append(input, document.createTextNode(column.label));
          options.append(option);
        }
        details.append(summary, options);
        row.append(details);
      }
      fragment.append(row);
    }
    root.replaceChildren(fragment);
  }

  private renderNavigationSettings(
    preferences: DashboardPreferences,
  ): void {
    const root = this.required("navigation-settings");
    const sections = preferences.navigationSections;
    const fragment = document.createDocumentFragment();
    const sectionList = document.createElement("div");
    sectionList.className = "navigation-section-list";
    for (const section of sections) {
      const row = document.createElement("div");
      row.className = "navigation-setting";
      row.dataset.navigationSectionId = section.id;
      const fields = document.createElement("div");
      fields.className = "navigation-setting-fields";
      const name = document.createElement("input");
      name.value = section.label;
      name.maxLength = 64;
      name.placeholder = "Unlabeled section";
      name.setAttribute(
        "aria-label",
        `Name for ${section.label || "unlabeled"} section`,
      );
      name.addEventListener("change", () => {
        this.preferences.updateNavigationSection(section.id, {
          label: name.value,
        });
        this.renderNavigation();
        this.renderSettings();
      });
      const placement = document.createElement("select");
      placement.setAttribute(
        "aria-label",
        `Placement for ${section.label || "unlabeled"} section`,
      );
      for (const value of ["main", "bottom"] as const) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === "main" ? "Main" : "Bottom";
        placement.append(option);
      }
      placement.value = section.placement;
      placement.addEventListener("change", () => {
        this.preferences.updateNavigationSection(section.id, {
          placement: placement.value as "main" | "bottom",
        });
        this.renderNavigation();
        this.renderSettings();
      });
      const count = document.createElement("span");
      count.className = "navigation-page-count";
      count.textContent = `${section.pages.length} page${
        section.pages.length === 1 ? "" : "s"
      }`;
      fields.append(name, placement, count);
      const actions = document.createElement("div");
      actions.className = "order-actions";
      const remove = orderButton("Delete", () => {
        if (
          !window.confirm(
            `Delete the ${section.label || "unlabeled"} navigation section? Its pages will be moved to another section.`,
          )
        ) {
          return;
        }
        if (!this.preferences.removeNavigationSection(section.id)) return;
        this.renderNavigation();
        this.renderSettings();
      });
      remove.disabled = sections.length <= 1;
      actions.append(
        orderButton("Up", () => this.moveNavigationSection(section.id, -1)),
        orderButton("Down", () => this.moveNavigationSection(section.id, 1)),
        remove,
      );
      row.append(fields, actions);
      sectionList.append(row);
    }
    const assignments = document.createElement("div");
    assignments.className = "navigation-page-assignments";
    const heading = document.createElement("h4");
    heading.textContent = "Page assignment";
    assignments.append(heading);
    for (const item of this.dashboard.navigation) {
      const row = document.createElement("label");
      row.className = "navigation-page-setting";
      const label = document.createElement("span");
      label.textContent = item.label;
      const select = document.createElement("select");
      select.setAttribute("aria-label", `Section for ${item.label}`);
      for (const section of sections) {
        const option = document.createElement("option");
        option.value = section.id;
        option.textContent = section.label || "Unlabeled";
        select.append(option);
      }
      select.value =
        sections.find(section => section.pages.includes(item.id))?.id ??
        sections[0]?.id ??
        "";
      select.addEventListener("change", () => {
        this.preferences.setPageNavigationSection(item.id, select.value);
        this.renderNavigation();
        this.renderSettings();
      });
      row.append(label, select);
      assignments.append(row);
    }
    fragment.append(sectionList, assignments);
    root.replaceChildren(fragment);
  }

  private moveNavigationSection(id: string, direction: -1 | 1): void {
    this.preferences.moveNavigationSection(id, direction);
    this.renderNavigation();
    this.renderSettings();
  }

  private movePanel(id: string, direction: -1 | 1): void {
    this.preferences.move(id, direction);
    this.renderSettings();
    this.renderPanels();
  }

  private bindPanelDrag(element: HTMLElement, panelId: string): void {
    const handle = element.querySelector<HTMLElement>(".panel-header");
    if (!handle) return;
    handle.draggable = true;
    handle.addEventListener("dragstart", event => {
      event.dataTransfer?.setData("text/x-hostmon-panel", panelId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      element.classList.add("dragging");
    });
    handle.addEventListener("dragend", () => {
      element.classList.remove("dragging");
      for (const panel of this.panelsRoot.querySelectorAll(".drag-over")) {
        panel.classList.remove("drag-over");
      }
    });
    element.addEventListener("dragover", event => {
      if (!event.dataTransfer?.types.includes("text/x-hostmon-panel")) return;
      event.preventDefault();
      element.classList.add("drag-over");
    });
    element.addEventListener("dragleave", () =>
      element.classList.remove("drag-over"),
    );
    element.addEventListener("drop", event => {
      event.preventDefault();
      element.classList.remove("drag-over");
      const source = event.dataTransfer?.getData("text/x-hostmon-panel");
      if (!source || source === panelId) return;
      this.preferences.moveBefore(source, panelId);
      this.renderSettings();
      this.renderPanels();
    });
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
    this.renderChartDestinations(panel?.page ?? this.defaultChartPage());
    (this.required("chart-style") as HTMLSelectElement).value =
      panel?.style ?? "line";
    (this.required("chart-width") as HTMLSelectElement).value = String(
      panel?.columnSpan ?? 1,
    );
    (this.required("chart-height") as HTMLSelectElement).value = String(
      panel?.height ?? 270,
    );
    (this.required("chart-line-width") as HTMLInputElement).value = String(
      panel?.lineWidth ?? 1.5,
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

  private renderChartDestinations(selectedPage: PageId): void {
    const select = this.required("chart-page") as HTMLSelectElement;
    const items = new Map(
      this.dashboard.navigation.map(item => [item.id, item]),
    );
    const fragment = document.createDocumentFragment();
    for (const section of this.preferences.get().navigationSections) {
      const pages = section.pages
        .map(page => items.get(page))
        .filter(item => item !== undefined);
      if (!pages.length) continue;
      const group = document.createElement("optgroup");
      group.label =
        section.label ||
        (section.placement === "bottom" ? "Bottom" : "Ungrouped");
      for (const item of pages) {
        const option = document.createElement("option");
        option.value = item.id;
        option.textContent = item.label;
        group.append(option);
      }
      fragment.append(group);
    }
    select.replaceChildren(fragment);
    select.value = selectedPage;
    if (!select.value && select.options.length) {
      select.value = select.options[0]!.value;
    }
  }

  private defaultChartPage(): PageId {
    const preferences = this.preferences.get();
    const active = preferences.activePage;
    const chartPages = new Set(
      this.dashboard.panels
        .filter(panel => panel.type === "timeseries")
        .map(panel => panel.page),
    );
    if (chartPages.has(active)) return active;
    const orderedPages = preferences.navigationSections.flatMap(
      section => section.pages,
    );
    return (
      orderedPages.find(page => chartPages.has(page)) ??
      orderedPages[0] ??
      this.dashboard.navigation[0]?.id ??
      active
    );
  }

  private renderMetricPicker(): void {
    const filter = (
      this.required("chart-metric-filter") as HTMLInputElement
    ).value.toLowerCase();
    const selected = JSON.parse(
      this.chartDialog.dataset.selected ?? "[]",
    ) as string[];
    const selectedSet = new Set<string>(
      selected,
    );
    const results = Object.keys(this.store.latestMetrics)
      .filter(
        name =>
          !selectedSet.has(name) &&
          (!filter || name.toLowerCase().includes(filter)),
      )
      .sort()
      .slice(0, 100);
    const resultFragment = document.createDocumentFragment();
    for (const metric of results) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "metric-option";
      button.textContent = metric;
      button.disabled = selected.length >= 8;
      button.addEventListener("click", () => {
        this.chartDialog.dataset.selected = JSON.stringify([
          ...selected,
          metric,
        ]);
        this.renderMetricPicker();
      });
      resultFragment.append(button);
    }
    const selectedFragment = document.createDocumentFragment();
    for (const metric of selected) {
      const item = document.createElement("div");
      item.className = "selected-metric";
      const name = document.createElement("span");
      name.textContent = metric;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "table-action";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        this.chartDialog.dataset.selected = JSON.stringify(
          selected.filter(item => item !== metric),
        );
        this.renderMetricPicker();
      });
      item.append(name, remove);
      selectedFragment.append(item);
    }
    this.required("chart-metric-results").replaceChildren(resultFragment);
    this.required("chart-metric-selected").replaceChildren(selectedFragment);
    this.required("chart-selection-count").textContent =
      `${selected.length} selected`;
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
      page: (this.required("chart-page") as HTMLSelectElement).value,
      custom: true,
      title,
      metrics,
      ...(this.editingPanel?.section !== undefined
        ? {section: this.editingPanel.section}
        : {}),
      ...(this.editingPanel?.series
        ? {series: this.editingPanel.series}
        : {}),
      style: (this.required("chart-style") as HTMLSelectElement).value as
        | "line"
        | "area",
      lineWidth: Math.min(
        5,
        Math.max(
          0.5,
          Number(
            (this.required("chart-line-width") as HTMLInputElement).value,
          ) || 1.5,
        ),
      ),
      height: Number(
        (this.required("chart-height") as HTMLSelectElement).value,
      ),
      columnSpan: Number(
        (this.required("chart-width") as HTMLSelectElement).value,
      ) as 1 | 2,
      ...(range ? {range} : {}),
    };
    this.preferences.saveCustomPanel(panel);
    this.store.track(metrics);
    this.chartDialog.close();
    this.navigate(panel.page);
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
      this.sampleAge.textContent = "Updated -- (UTC+8)";
      return;
    }
    const updated = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(this.store.latestTimestamp * 1000));
    this.sampleAge.textContent = `Updated ${updated} (UTC+8)`;
    this.sampleAge.classList.toggle(
      "stale",
      Date.now() / 1000 - this.store.latestTimestamp > 30,
    );
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
    return [
      ...this.dashboard.panels,
      ...this.preferences.get().customPanels,
    ];
  }

  private trackedPanelMetrics(): string[] {
    return this.allPanels()
      .filter(
        (panel): panel is TimeSeriesPanelDefinition =>
          panel.type === "timeseries",
      )
      .flatMap(panel => panel.metrics);
  }

  private required(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing dashboard element: ${id}`);
    return element;
  }

  private destroy(): void {
    this.refreshController?.abort();
    this.realtime.stop();
    window.removeEventListener("popstate", this.handlePopState);
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
