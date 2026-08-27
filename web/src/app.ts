import { DASHBOARD } from "./config/dashboard";
import { ApiClient } from "./core/api-client";
import { FrameScheduler } from "./core/frame-scheduler";
import { PreferenceStore } from "./core/preferences";
import { TimeSeriesStore } from "./core/time-series-store";
import { RealtimeClient } from "./core/websocket-client";
import type { ConnectionState, PanelDefinition } from "./domain/types";
import type { PanelRenderer } from "./panels/panel";
import { createPanelRegistry } from "./panels/registry";

export class DashboardApp {
  private readonly api = new ApiClient();
  private readonly store = new TimeSeriesStore(
    21600,
    DASHBOARD.panels.flatMap(panel =>
      panel.type === "timeseries" ? panel.metrics : [],
    ),
  );
  private readonly preferences = new PreferenceStore(DASHBOARD);
  private readonly frames = new FrameScheduler();
  private readonly registry = createPanelRegistry();
  private readonly realtime = new RealtimeClient({
    onSnapshot: snapshot => this.store.append(snapshot),
    onState: state => this.setConnectionState(state),
  });
  private readonly panels: PanelRenderer[] = [];
  private readonly root: HTMLElement;
  private panelsRoot!: HTMLElement;
  private settingsDrawer!: HTMLElement;
  private connectionDot!: HTMLElement;
  private connectionText!: HTMLElement;
  private hostText!: HTMLElement;
  private sampleAge!: HTMLElement;
  private pauseButton!: HTMLButtonElement;
  private refreshController: AbortController | null = null;
  private updateQueued = false;
  private paused = false;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  async start(): Promise<void> {
    this.buildShell();
    const preferences = this.preferences.get();
    this.store.setWindow(preferences.windowSeconds);
    this.bindControls();
    this.store.subscribe(() => this.queuePanelUpdate());
    await this.reloadData();
    this.renderPanels();
    this.realtime.start();
    window.setInterval(() => this.updateSampleAge(), 1000);
    window.addEventListener("beforeunload", () => this.destroy(), { once: true });
  }

  private buildShell(): void {
    this.root.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true"></div>
          <div><h1>${DASHBOARD.title}</h1><p id="host-text">waiting for data</p></div>
        </div>
        <div class="toolbar">
          <div class="connection">
            <span id="connection-dot" class="connection-dot"></span>
            <span id="connection-text">connecting</span>
            <span id="sample-age">--</span>
          </div>
          <label class="control">Window
            <select id="window-select">
              <option value="900">15m</option>
              <option value="3600">1h</option>
              <option value="21600">6h</option>
            </select>
          </label>
          <button id="pause-button" class="button" type="button">Pause</button>
          <button id="export-button" class="button" type="button">Export CSV</button>
          <button id="customize-button" class="button button-primary" type="button">Customize</button>
        </div>
      </header>
      <main>
        <div id="panels" class="panel-grid"></div>
      </main>
      <aside id="settings-drawer" class="settings-drawer" aria-hidden="true">
        <header><div><h2>Dashboard layout</h2><p>Stored locally in this browser.</p></div>
          <button id="settings-close" class="icon-button" type="button" aria-label="Close">x</button>
        </header>
        <div id="panel-settings" class="panel-settings"></div>
        <footer><button id="settings-reset" class="button" type="button">Reset layout</button></footer>
      </aside>
      <div id="drawer-backdrop" class="drawer-backdrop"></div>
    `;
    this.panelsRoot = this.required("panels");
    this.settingsDrawer = this.required("settings-drawer");
    this.connectionDot = this.required("connection-dot");
    this.connectionText = this.required("connection-text");
    this.hostText = this.required("host-text");
    this.sampleAge = this.required("sample-age");
    this.pauseButton = this.required("pause-button") as HTMLButtonElement;
    const select = this.required("window-select") as HTMLSelectElement;
    select.value = String(this.preferences.get().windowSeconds);
    this.renderSettings();
  }

  private bindControls(): void {
    this.required("window-select").addEventListener("change", event => {
      const seconds = Number((event.target as HTMLSelectElement).value);
      this.preferences.setWindow(seconds);
      this.store.setWindow(seconds);
      void this.reloadData();
    });
    this.pauseButton.addEventListener("click", () => {
      this.paused = !this.paused;
      this.pauseButton.textContent = this.paused ? "Resume" : "Pause";
      this.realtime.setPaused(this.paused);
      if (!this.paused) void this.reloadData();
    });
    this.required("export-button").addEventListener("click", () => this.exportCsv());
    this.required("customize-button").addEventListener("click", () => this.toggleDrawer(true));
    this.required("settings-close").addEventListener("click", () => this.toggleDrawer(false));
    this.required("drawer-backdrop").addEventListener("click", () => this.toggleDrawer(false));
    this.required("settings-reset").addEventListener("click", () => {
      this.preferences.reset();
      const preferences = this.preferences.get();
      this.store.setWindow(preferences.windowSeconds);
      (this.required("window-select") as HTMLSelectElement).value =
        String(preferences.windowSeconds);
      this.renderSettings();
      this.renderPanels();
      void this.reloadData();
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
        this.api.history(this.store.windowSeconds, 1800, controller.signal),
        this.api.status(controller.signal),
      ]);
      if (controller.signal.aborted) return;
      this.store.replaceHistory(history);
      this.store.applyStatus(status);
      this.hostText.textContent = status.host;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.setConnectionState("offline");
        console.error(error);
      }
    }
  }

  private renderPanels(): void {
    for (const panel of this.panels) panel.destroy();
    this.panels.length = 0;
    const fragment = document.createDocumentFragment();
    for (const definition of this.preferences.visiblePanels()) {
      const panel = this.registry.create(definition, {
        store: this.store,
        frames: this.frames,
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
    for (const definition of orderedDefinitions(preferences.panelOrder)) {
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
      label.append(checkbox, document.createTextNode(definition.title));
      const actions = document.createElement("div");
      actions.className = "order-actions";
      actions.append(
        orderButton("up", () => this.movePanel(definition.id, -1)),
        orderButton("down", () => this.movePanel(definition.id, 1)),
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
    const metrics = new Set<string>();
    for (const panel of DASHBOARD.panels) {
      if (panel.type === "timeseries") {
        for (const metric of panel.metrics) metrics.add(metric);
      }
    }
    const blob = new Blob([this.store.exportCsv([...metrics])], {
      type: "text/csv;charset=utf-8",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `hostmon-${new Date().toISOString()}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  private required(id: string): HTMLElement {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing dashboard element: ${id}`);
    return element;
  }

  private destroy(): void {
    this.refreshController?.abort();
    this.realtime.stop();
    this.frames.stop();
    for (const panel of this.panels) panel.destroy();
  }
}

function orderedDefinitions(order: string[]): PanelDefinition[] {
  const definitions = new Map(DASHBOARD.panels.map(panel => [panel.id, panel]));
  const ordered = order
    .map(id => definitions.get(id))
    .filter((panel): panel is PanelDefinition => panel !== undefined);
  for (const panel of DASHBOARD.panels) {
    if (!ordered.some(item => item.id === panel.id)) ordered.push(panel);
  }
  return ordered;
}

function orderButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}
