import type {
  DashboardDefinition,
  DashboardPreferences,
  PanelDefinition,
} from "../domain/types";

const STORAGE_KEY = "hostmon.dashboard.preferences.v1";

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
    };
  }

  visiblePanels(): PanelDefinition[] {
    const panels = new Map(this.definition.panels.map(panel => [panel.id, panel]));
    const ordered = this.value.panelOrder
      .map(id => panels.get(id))
      .filter((panel): panel is PanelDefinition => panel !== undefined);
    for (const panel of this.definition.panels) {
      if (!ordered.some(item => item.id === panel.id)) ordered.push(panel);
    }
    return ordered.filter(panel => !this.value.hiddenPanels.includes(panel.id));
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

  setWindow(seconds: number): void {
    this.value.windowSeconds = seconds;
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
