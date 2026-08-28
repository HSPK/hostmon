import type {
  DashboardDefinition,
  DashboardPreferences,
  PanelDefinition,
  PageId,
  TimeSeriesPanelDefinition,
  WorkloadView,
} from "../domain/types";

const STORAGE_KEY = "hostmon.dashboard.preferences.v2";

export class PreferenceStore {
  private value: DashboardPreferences;

  constructor(private readonly definition: DashboardDefinition) {
    this.value = this.load();
  }

  get(): DashboardPreferences {
    return {
      hiddenPanels: [...this.value.hiddenPanels],
      panelOrder: [...this.value.panelOrder],
      windowSeconds: this.value.windowSeconds,
      activePage: this.value.activePage,
      workloadView: {...this.value.workloadView},
      panelColumns: Object.fromEntries(
        Object.entries(this.value.panelColumns).map(([id, columns]) => [
          id,
          [...columns],
        ]),
      ),
      customPanels: this.value.customPanels.map(panel => ({...panel})),
    };
  }

  visiblePanels(page: PageId = this.value.activePage): PanelDefinition[] {
    const definitions = [...this.definition.panels, ...this.value.customPanels];
    const panels = new Map(definitions.map(panel => [panel.id, panel]));
    const ordered = this.value.panelOrder
      .map(id => panels.get(id))
      .filter((panel): panel is PanelDefinition => panel !== undefined);
    for (const panel of definitions) {
      if (!ordered.some(item => item.id === panel.id)) ordered.push(panel);
    }
    return ordered.filter(
      panel =>
        panel.page === page && !this.value.hiddenPanels.includes(panel.id),
    ).map(panel => {
      const columns = this.value.panelColumns[panel.id];
      return columns ? {...panel, columns: [...columns]} : panel;
    });
  }

  setVisible(panelId: string, visible: boolean): void {
    const hidden = new Set(this.value.hiddenPanels);
    if (visible) hidden.delete(panelId);
    else hidden.add(panelId);
    this.value.hiddenPanels = [...hidden];
    this.save();
  }

  move(panelId: string, direction: -1 | 1): void {
    const order = [...this.value.panelOrder];
    const index = order.indexOf(panelId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    this.value.panelOrder = order;
    this.save();
  }

  moveBefore(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    const definitions = [
      ...this.definition.panels,
      ...this.value.customPanels,
    ];
    const known = new Set(definitions.map(panel => panel.id));
    const order = this.value.panelOrder.filter(id => known.has(id));
    for (const panel of definitions) {
      if (!order.includes(panel.id)) order.push(panel.id);
    }
    const source = order.indexOf(sourceId);
    const target = order.indexOf(targetId);
    if (source < 0 || target < 0) return;
    order.splice(source, 1);
    order.splice(order.indexOf(targetId), 0, sourceId);
    this.value.panelOrder = order;
    this.save();
  }

  setWindow(seconds: number): void {
    this.value.windowSeconds = seconds;
    this.save();
  }

  setActivePage(page: PageId): void {
    this.value.activePage = page;
    this.save();
  }

  setWorkloadView(view: WorkloadView): void {
    this.value.workloadView = {...view};
    this.save();
  }

  setPanelColumns(panelId: string, columns: string[]): void {
    this.value.panelColumns[panelId] = [...columns];
    this.save();
  }

  saveCustomPanel(panel: TimeSeriesPanelDefinition): void {
    const index = this.value.customPanels.findIndex(item => item.id === panel.id);
    if (index >= 0) this.value.customPanels[index] = panel;
    else {
      this.value.customPanels.push(panel);
      if (!this.value.panelOrder.includes(panel.id)) {
        this.value.panelOrder.push(panel.id);
      }
    }
    this.save();
  }

  removeCustomPanel(panelId: string): void {
    this.value.customPanels = this.value.customPanels.filter(
      panel => panel.id !== panelId,
    );
    this.value.panelOrder = this.value.panelOrder.filter(id => id !== panelId);
    this.value.hiddenPanels = this.value.hiddenPanels.filter(id => id !== panelId);
    this.save();
  }

  reset(): void {
    this.value = this.defaults();
    this.save();
  }

  private defaults(): DashboardPreferences {
    return {
      hiddenPanels: [],
      panelOrder: this.definition.panels.map(panel => panel.id),
      windowSeconds: this.definition.defaultWindowSeconds,
      activePage: "overview",
      workloadView: defaultWorkloadView(),
      panelColumns: {},
      customPanels: [],
    };
  }

  private load(): DashboardPreferences {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.defaults();
      const parsed = JSON.parse(raw) as Partial<DashboardPreferences>;
      return {
        hiddenPanels: Array.isArray(parsed.hiddenPanels)
          ? parsed.hiddenPanels.filter(item => typeof item === "string")
          : [],
        panelOrder: Array.isArray(parsed.panelOrder)
          ? parsed.panelOrder.filter(item => typeof item === "string")
          : this.definition.panels.map(panel => panel.id),
        windowSeconds:
          typeof parsed.windowSeconds === "number"
            ? parsed.windowSeconds
            : this.definition.defaultWindowSeconds,
        activePage: isPageId(parsed.activePage, this.definition)
          ? parsed.activePage
          : "overview",
        workloadView: isWorkloadView(parsed.workloadView)
          ? parsed.workloadView
          : defaultWorkloadView(),
        panelColumns: isPanelColumns(parsed.panelColumns)
          ? parsed.panelColumns
          : {},
        customPanels: Array.isArray(parsed.customPanels)
          ? parsed.customPanels.filter(isCustomPanel)
          : [],
      };
    } catch {
      return this.defaults();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
  }

}

function defaultWorkloadView(): WorkloadView {
  return {queue: "all", state: "all", sort: "running-gpus"};
}

function isPanelColumns(
  value: unknown,
): value is Record<string, string[]> {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every(
      columns =>
        Array.isArray(columns) &&
        columns.length > 0 &&
        columns.every(column => typeof column === "string"),
    )
  );
}

function isWorkloadView(value: unknown): value is WorkloadView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<WorkloadView>;
  return (
    typeof view.queue === "string" &&
    ["all", "attention", "Running", "Pending", "Mixed"].includes(
      String(view.state),
    ) &&
    ["running-gpus", "pending-gpus", "name", "submitter", "queue"].includes(
      String(view.sort),
    )
  );
}

function isPageId(
  value: unknown,
  definition: DashboardDefinition,
): value is PageId {
  return definition.navigation.some(item => item.id === value);
}

function isCustomPanel(value: unknown): value is TimeSeriesPanelDefinition {
  if (!value || typeof value !== "object") return false;
  const panel = value as Partial<TimeSeriesPanelDefinition>;
  return (
    typeof panel.id === "string" &&
    typeof panel.title === "string" &&
    panel.type === "timeseries" &&
    panel.page === "metrics" &&
    Array.isArray(panel.metrics) &&
    panel.metrics.every(metric => typeof metric === "string")
  );
}
