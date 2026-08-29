import type {
  DashboardDefinition,
  DashboardPreferences,
  NavigationSection,
  PanelDefinition,
  PageId,
  TimeSeriesPanelDefinition,
} from "../domain/types";

const STORAGE_KEY = "hostmon.dashboard.preferences.v2";
const PENDING_KEY = "hostmon.dashboard.preferences.pending.v1";
export type PreferenceField = keyof DashboardPreferences;
export const PREFERENCE_FIELDS: PreferenceField[] = [
  "hiddenPanels",
  "panelOrder",
  "windowSeconds",
  "activePage",
  "panelState",
  "panelColumns",
  "theme",
  "density",
  "customPanels",
  "navigationSections",
];

export class PreferenceStore {
  private value: DashboardPreferences;
  private readonly hadLocalPreferences: boolean;
  private readonly pending = loadPendingFields();
  private onChange?: (
    value: DashboardPreferences,
    fields: PreferenceField[],
    replace: boolean,
  ) => void;

  constructor(private readonly definition: DashboardDefinition) {
    this.hadLocalPreferences = hasStoredPreferences();
    this.value = this.load();
  }

  get(): DashboardPreferences {
    return {
      hiddenPanels: [...this.value.hiddenPanels],
      panelOrder: [...this.value.panelOrder],
      windowSeconds: this.value.windowSeconds,
      activePage: this.value.activePage,
      panelState: Object.fromEntries(
        Object.entries(this.value.panelState).map(([id, state]) => [
          id,
          {...state},
        ]),
      ),
      panelColumns: Object.fromEntries(
        Object.entries(this.value.panelColumns).map(([id, columns]) => [
          id,
          [...columns],
        ]),
      ),
      theme: this.value.theme,
      density: this.value.density,
      customPanels: this.value.customPanels.map(panel => ({...panel})),
      navigationSections: this.value.navigationSections.map(section => ({
        ...section,
        pages: [...section.pages],
      })),
    };
  }

  hydrate(value: DashboardPreferences): void {
    const local = this.get();
    const merged = {...value} as DashboardPreferences;
    for (const field of this.pending) {
      Object.assign(merged, {[field]: local[field]});
    }
    this.value = this.normalize(merged);
    this.saveLocal();
  }

  setPersistence(
    onChange: (
      value: DashboardPreferences,
      fields: PreferenceField[],
      replace: boolean,
    ) => void,
  ): void {
    this.onChange = onChange;
  }

  hasLocalPreferences(): boolean {
    return this.hadLocalPreferences;
  }

  pendingFields(): PreferenceField[] {
    return [...this.pending];
  }

  markPending(fields: PreferenceField[]): void {
    for (const field of fields) this.pending.add(field);
    this.savePending();
  }

  markPersisted(fields: PreferenceField[]): void {
    for (const field of fields) this.pending.delete(field);
    this.savePending();
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
      return columns && panel.columns
        ? {
            ...panel,
            columns: panel.columns.filter(column =>
              columns.includes(column.id),
            ),
          }
        : panel;
    });
  }

  setVisible(panelId: string, visible: boolean): void {
    const hidden = new Set(this.value.hiddenPanels);
    if (visible) hidden.delete(panelId);
    else hidden.add(panelId);
    this.value.hiddenPanels = [...hidden];
    this.save("hiddenPanels");
  }

  move(panelId: string, direction: -1 | 1): void {
    const order = [...this.value.panelOrder];
    const index = order.indexOf(panelId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    this.value.panelOrder = order;
    this.save("panelOrder");
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
    this.save("panelOrder");
  }

  setWindow(seconds: number): void {
    this.value.windowSeconds = seconds;
    this.save("windowSeconds");
  }

  setActivePage(page: PageId, persist = true): void {
    this.value.activePage = page;
    if (persist) this.save("activePage");
  }

  addNavigationSection(
    label: string,
    placement: NavigationSection["placement"],
  ): string | null {
    const normalized = label.trim().slice(0, 64);
    if (!normalized) return null;
    const base = `custom-${slug(normalized) || "section"}`;
    let id = base;
    let suffix = 2;
    while (this.value.navigationSections.some(section => section.id === id)) {
      id = `${base}-${suffix++}`;
    }
    this.value.navigationSections.push({
      id,
      label: normalized,
      placement,
      pages: [],
    });
    this.save("navigationSections");
    return id;
  }

  updateNavigationSection(
    sectionId: string,
    changes: Partial<Pick<NavigationSection, "label" | "placement">>,
  ): void {
    const section = this.value.navigationSections.find(
      item => item.id === sectionId,
    );
    if (!section) return;
    const label =
      changes.label === undefined
        ? section.label
        : changes.label.trim().slice(0, 64);
    const placement = changes.placement ?? section.placement;
    if (section.label === label && section.placement === placement) return;
    section.label = label;
    section.placement = placement;
    this.save("navigationSections");
  }

  moveNavigationSection(sectionId: string, direction: -1 | 1): void {
    const section = this.value.navigationSections.find(
      item => item.id === sectionId,
    );
    if (!section) return;
    const peers = this.value.navigationSections.filter(
      item => item.placement === section.placement,
    );
    const index = peers.findIndex(item => item.id === sectionId);
    const target = peers[index + direction];
    if (index < 0 || !target) return;
    const sourceIndex = this.value.navigationSections.indexOf(section);
    const targetIndex = this.value.navigationSections.indexOf(target);
    [
      this.value.navigationSections[sourceIndex],
      this.value.navigationSections[targetIndex],
    ] = [
      this.value.navigationSections[targetIndex]!,
      this.value.navigationSections[sourceIndex]!,
    ];
    this.save("navigationSections");
  }

  removeNavigationSection(sectionId: string): boolean {
    const sections = this.value.navigationSections;
    if (sections.length <= 1) return false;
    const index = sections.findIndex(section => section.id === sectionId);
    if (index < 0) return false;
    const removed = sections[index]!;
    const fallback =
      sections.find(
        section =>
          section.id !== sectionId &&
          section.placement === removed.placement,
      ) ?? sections.find(section => section.id !== sectionId);
    if (!fallback) return false;
    fallback.pages = [...new Set([...fallback.pages, ...removed.pages])];
    sections.splice(index, 1);
    this.save("navigationSections");
    return true;
  }

  setPageNavigationSection(page: PageId, sectionId: string): void {
    const target = this.value.navigationSections.find(
      section => section.id === sectionId,
    );
    if (
      !this.definition.navigation.some(item => item.id === page) ||
      !target
    ) {
      return;
    }
    for (const section of this.value.navigationSections) {
      section.pages = section.pages.filter(item => item !== page);
    }
    target.pages.push(page);
    this.save("navigationSections");
  }

  panelState<T extends Record<string, string | number | boolean | null>>(
    panelId: string,
    fallback: T,
  ): T {
    return {
      ...fallback,
      ...(this.value.panelState[panelId] ?? {}),
    } as T;
  }

  setPanelState(
    panelId: string,
    state: Record<string, string | number | boolean | null>,
  ): void {
    this.value.panelState[panelId] = {...state};
    this.save("panelState");
  }

  setPanelColumns(panelId: string, columns: string[]): void {
    this.value.panelColumns[panelId] = [...columns];
    this.save("panelColumns");
  }

  setAppearance(
    theme: DashboardPreferences["theme"],
    density: DashboardPreferences["density"],
  ): void {
    const fields: PreferenceField[] = [];
    if (this.value.theme !== theme) fields.push("theme");
    if (this.value.density !== density) fields.push("density");
    this.value.theme = theme;
    this.value.density = density;
    if (fields.length) this.save(...fields);
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
    this.save("customPanels", "panelOrder");
  }

  removeCustomPanel(panelId: string): void {
    this.value.customPanels = this.value.customPanels.filter(
      panel => panel.id !== panelId,
    );
    this.value.panelOrder = this.value.panelOrder.filter(id => id !== panelId);
    this.value.hiddenPanels = this.value.hiddenPanels.filter(id => id !== panelId);
    this.save("customPanels", "panelOrder", "hiddenPanels");
  }

  reset(): void {
    this.value = this.defaults();
    this.persist(PREFERENCE_FIELDS, true);
  }

  private defaults(): DashboardPreferences {
    return {
      hiddenPanels: [],
      panelOrder: this.definition.panels.map(panel => panel.id),
      windowSeconds: this.definition.defaultWindowSeconds,
      activePage: "overview",
      panelState: {},
      panelColumns: {},
      theme: "dark",
      density: "compact",
      customPanels: [],
      navigationSections: defaultNavigationSections(this.definition),
    };
  }

  private load(): DashboardPreferences {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return this.defaults();
      return this.normalize(JSON.parse(raw));
    } catch {
      return this.defaults();
    }
  }

  private normalize(value: unknown): DashboardPreferences {
    const parsed =
      value && typeof value === "object"
        ? value as Partial<DashboardPreferences>
        : {};
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
        panelState: parsePanelState(parsed),
        panelColumns: isPanelColumns(parsed.panelColumns)
          ? Object.fromEntries(
              Object.entries(parsed.panelColumns).map(([id, columns]) => [
                id,
                [...columns],
              ]),
            )
          : {},
        theme:
          parsed.theme === "dark" ||
          parsed.theme === "light" ||
          parsed.theme === "system"
            ? parsed.theme
            : "dark",
        density:
          parsed.density === "comfortable" ? "comfortable" : "compact",
        customPanels: Array.isArray(parsed.customPanels)
          ? parsed.customPanels.filter(panel =>
              isCustomPanel(panel, this.definition),
            ).map(normalizeCustomPanel)
          : [],
        navigationSections: normalizeNavigationSections(
          parsed.navigationSections,
          this.definition,
        ),
    };
  }

  private save(...fields: PreferenceField[]): void {
    this.persist(fields, false);
  }

  private persist(fields: PreferenceField[], replace: boolean): void {
    for (const field of fields) this.pending.add(field);
    this.saveLocal();
    this.savePending();
    this.onChange?.(this.get(), fields, replace);
  }

  private saveLocal(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
  }

  private savePending(): void {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify([...this.pending]));
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
  }
}

function hasStoredPreferences(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function loadPendingFields(): Set<PreferenceField> {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
    if (!Array.isArray(value)) return new Set();
    return new Set(
      value.filter((item): item is PreferenceField =>
        PREFERENCE_FIELDS.includes(item as PreferenceField),
      ),
    );
  } catch {
    return new Set();
  }
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

function parsePanelState(
  value: Partial<DashboardPreferences> & {workloadView?: unknown},
): DashboardPreferences["panelState"] {
  const state = isPanelState(value.panelState) ? value.panelState : {};
  const normalized = Object.fromEntries(
    Object.entries(state).map(([id, item]) => [id, {...item}]),
  );
  if (
    __HOSTMON_PLUGIN_UI__ &&
    !normalized["gpu-submitters"] &&
    isLegacyWorkloadView(value.workloadView)
  ) {
    normalized["gpu-submitters"] = {...value.workloadView};
  }
  return normalized;
}

function isPanelState(
  value: unknown,
): value is DashboardPreferences["panelState"] {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).every(
      state =>
        state !== null &&
        typeof state === "object" &&
        Object.values(state).every(
          item =>
            item === null ||
            ["string", "number", "boolean"].includes(typeof item),
        ),
    )
  );
}

function isLegacyWorkloadView(
  value: unknown,
): value is Record<string, string> {
  if (!value || typeof value !== "object") return false;
  const view = value as Record<string, unknown>;
  return ["queue", "state", "sort", "sortDirection"].every(
    key => typeof view[key] === "string",
  );
}

function isPageId(
  value: unknown,
  definition: DashboardDefinition,
): value is PageId {
  return definition.navigation.some(item => item.id === value);
}

function isCustomPanel(
  value: unknown,
  definition: DashboardDefinition,
): value is TimeSeriesPanelDefinition {
  if (!value || typeof value !== "object") return false;
  const panel = value as Partial<TimeSeriesPanelDefinition>;
  return (
    typeof panel.id === "string" &&
    typeof panel.title === "string" &&
    panel.type === "timeseries" &&
    typeof panel.page === "string" &&
    isPageId(panel.page, definition) &&
    Array.isArray(panel.metrics) &&
    panel.metrics.every(metric => typeof metric === "string")
  );
}

function normalizeCustomPanel(
  panel: TimeSeriesPanelDefinition,
): TimeSeriesPanelDefinition {
  return {
    ...panel,
    height:
      typeof panel.height === "number" && panel.height >= 180
        ? panel.height
        : 270,
    lineWidth:
      typeof panel.lineWidth === "number" &&
      panel.lineWidth >= 0.5 &&
      panel.lineWidth <= 5
        ? panel.lineWidth
        : 1.5,
  };
}

function defaultNavigationSections(
  definition: DashboardDefinition,
): NavigationSection[] {
  const sections: NavigationSection[] = [];
  const byGroup = new Map<string, NavigationSection>();
  const identifiers = new Set<string>();
  for (const item of definition.navigation) {
    const placement = item.placement ?? "main";
    const label = item.group ?? "";
    const key = `${placement}\u0000${label}`;
    let section = byGroup.get(key);
    if (!section) {
      const base = `default-${placement}-${slug(label) || "pages"}`;
      let id = base;
      let suffix = 2;
      while (identifiers.has(id)) id = `${base}-${suffix++}`;
      section = {id, label, placement, pages: []};
      sections.push(section);
      byGroup.set(key, section);
      identifiers.add(id);
    }
    section.pages.push(item.id);
  }
  return sections;
}

function normalizeNavigationSections(
  value: unknown,
  definition: DashboardDefinition,
): NavigationSection[] {
  const defaults = defaultNavigationSections(definition);
  if (!Array.isArray(value) || !value.length) return defaults;
  const knownPages = new Set(definition.navigation.map(item => item.id));
  const sectionIds = new Set<string>();
  const assignedPages = new Set<PageId>();
  const sections: NavigationSection[] = [];
  for (const candidate of value.slice(0, 64)) {
    if (!candidate || typeof candidate !== "object") continue;
    const section = candidate as Partial<NavigationSection>;
    if (
      typeof section.id !== "string" ||
      !section.id ||
      section.id.length > 256 ||
      sectionIds.has(section.id) ||
      typeof section.label !== "string" ||
      section.label.length > 64 ||
      (section.placement !== "main" && section.placement !== "bottom") ||
      !Array.isArray(section.pages)
    ) {
      continue;
    }
    const pages = section.pages.filter(
      (page): page is PageId =>
        typeof page === "string" &&
        knownPages.has(page) &&
        !assignedPages.has(page),
    );
    for (const page of pages) assignedPages.add(page);
    sections.push({
      id: section.id,
      label: section.label,
      placement: section.placement,
      pages,
    });
    sectionIds.add(section.id);
  }
  if (!sections.length) return defaults;
  for (const item of definition.navigation) {
    if (assignedPages.has(item.id)) continue;
    const defaultSection = defaults.find(section =>
      section.pages.includes(item.id),
    );
    const target =
      sections.find(section => section.id === defaultSection?.id) ??
      sections.find(
        section => section.placement === defaultSection?.placement,
      ) ??
      sections[0]!;
    target.pages.push(item.id);
    assignedPages.add(item.id);
  }
  return sections;
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
