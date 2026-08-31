import type {
  ChartDefaults,
  CustomPageDefinition,
  DashboardDefinition,
  DashboardPreferences,
  NavigationItem,
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
  "hiddenPages",
  "pageLabels",
  "customPages",
  "chartDefaults",
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
      hiddenPages: [...this.value.hiddenPages],
      pageLabels: {...this.value.pageLabels},
      customPages: this.value.customPages.map(page => ({...page})),
      chartDefaults: {...this.value.chartDefaults},
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

  navigationItems(): NavigationItem[] {
    return effectiveNavigationItems(this.definition, this.value);
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
    if (!this.navigationItems().some(item => item.id === page)) return;
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

  moveNavigationSectionRelative(
    sourceId: string,
    targetId: string,
    after: boolean,
  ): void {
    if (sourceId === targetId) return;
    const sourceIndex = this.value.navigationSections.findIndex(
      section => section.id === sourceId,
    );
    const target = this.value.navigationSections.find(
      section => section.id === targetId,
    );
    if (sourceIndex < 0 || !target) return;
    const [source] = this.value.navigationSections.splice(sourceIndex, 1);
    if (!source) return;
    source.placement = target.placement;
    const targetIndex = this.value.navigationSections.findIndex(
      section => section.id === targetId,
    );
    this.value.navigationSections.splice(
      targetIndex + (after ? 1 : 0),
      0,
      source,
    );
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
      !this.navigationItems().some(item => item.id === page) ||
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

  addPage(label: string, sectionId: string): string | null {
    const normalized = label.trim().slice(0, 80);
    const section = this.value.navigationSections.find(
      item => item.id === sectionId,
    );
    if (!normalized || !section) return null;
    const known = new Set(this.navigationItems().map(item => item.id));
    const base = `page-${slug(normalized) || "metrics"}`;
    let id = base;
    let suffix = 2;
    while (known.has(id)) id = `${base}-${suffix++}`;
    this.value.customPages.push({id, label: normalized});
    section.pages.push(id);
    this.save("customPages", "navigationSections");
    return id;
  }

  updatePage(pageId: PageId, label: string, sectionId: string): void {
    const normalized = label.trim().slice(0, 80);
    const section = this.value.navigationSections.find(
      item => item.id === sectionId,
    );
    const page = this.navigationItems().find(item => item.id === pageId);
    if (!normalized || !section || !page) return;
    const custom = this.value.customPages.find(item => item.id === pageId);
    const fields: PreferenceField[] = ["navigationSections"];
    if (custom) {
      custom.label = normalized;
      fields.push("customPages");
    } else {
      const original = this.definition.navigation.find(
        item => item.id === pageId,
      );
      if (original?.label === normalized) delete this.value.pageLabels[pageId];
      else this.value.pageLabels[pageId] = normalized;
      fields.push("pageLabels");
    }
    for (const item of this.value.navigationSections) {
      item.pages = item.pages.filter(id => id !== pageId);
    }
    section.pages.push(pageId);
    this.save(...fields);
  }

  removePage(pageId: PageId): boolean {
    const pages = this.navigationItems();
    if (pages.length <= 1 || !pages.some(page => page.id === pageId)) {
      return false;
    }
    const chartPages = new Set(
      this.definition.panels
        .filter(panel => panel.type === "timeseries")
        .map(panel => panel.page),
    );
    const customPages = new Set(this.value.customPages.map(page => page.id));
    const fallback =
      pages.find(
        page =>
          page.id !== pageId &&
          (chartPages.has(page.id) || customPages.has(page.id)),
      )?.id ?? pages.find(page => page.id !== pageId)!.id;
    const customIndex = this.value.customPages.findIndex(
      page => page.id === pageId,
    );
    if (customIndex >= 0) this.value.customPages.splice(customIndex, 1);
    else if (!this.value.hiddenPages.includes(pageId)) {
      this.value.hiddenPages.push(pageId);
    }
    delete this.value.pageLabels[pageId];
    for (const section of this.value.navigationSections) {
      section.pages = section.pages.filter(id => id !== pageId);
    }
    this.value.customPanels = this.value.customPanels.map(panel =>
      panel.page === pageId ? {...panel, page: fallback} : panel,
    );
    if (this.value.activePage === pageId) this.value.activePage = fallback;
    this.save(
      "hiddenPages",
      "pageLabels",
      "customPages",
      "navigationSections",
      "customPanels",
      "activePage",
    );
    return true;
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

  setChartDefaults(defaults: ChartDefaults): void {
    this.value.chartDefaults = normalizeChartDefaults(defaults);
    this.save("chartDefaults");
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
      hiddenPages: [],
      pageLabels: {},
      customPages: [],
      chartDefaults: defaultChartDefaults(),
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
    const customPages = normalizeCustomPages(
      parsed.customPages,
      this.definition,
    );
    const hiddenPages = normalizeHiddenPages(
      parsed.hiddenPages,
      this.definition,
      customPages.length > 0,
    );
    const pageLabels = normalizePageLabels(
      parsed.pageLabels,
      this.definition,
      customPages,
    );
    const navigationItems = effectiveNavigationItems(this.definition, {
      hiddenPages,
      pageLabels,
      customPages,
    });
    const pageIds = new Set(navigationItems.map(item => item.id));
    const fallbackPage = navigationItems[0]?.id ?? "overview";
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
        activePage: isPageId(parsed.activePage, pageIds)
          ? parsed.activePage
          : fallbackPage,
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
              isCustomPanel(panel, pageIds),
            ).map(normalizeCustomPanel)
          : [],
        navigationSections: normalizeNavigationSections(
          parsed.navigationSections,
          this.definition,
          navigationItems,
        ),
        hiddenPages,
        pageLabels,
        customPages,
        chartDefaults: normalizeChartDefaults(parsed.chartDefaults),
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
  pages: Set<PageId>,
): value is PageId {
  return typeof value === "string" && pages.has(value);
}

function isCustomPanel(
  value: unknown,
  pages: Set<PageId>,
): value is TimeSeriesPanelDefinition {
  if (!value || typeof value !== "object") return false;
  const panel = value as Partial<TimeSeriesPanelDefinition>;
  return (
    typeof panel.id === "string" &&
    typeof panel.title === "string" &&
    panel.type === "timeseries" &&
    typeof panel.page === "string" &&
    isPageId(panel.page, pages) &&
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

function effectiveNavigationItems(
  definition: DashboardDefinition,
  value: Pick<
    DashboardPreferences,
    "hiddenPages" | "pageLabels" | "customPages"
  >,
): NavigationItem[] {
  return [
    ...definition.navigation
      .filter(item => !value.hiddenPages.includes(item.id))
      .map(item => ({
        ...item,
        label: value.pageLabels[item.id] ?? item.label,
      })),
    ...value.customPages.map(page => ({...page})),
  ];
}

function normalizeCustomPages(
  value: unknown,
  definition: DashboardDefinition,
): CustomPageDefinition[] {
  if (!Array.isArray(value)) return [];
  const identifiers = new Set(definition.navigation.map(item => item.id));
  const pages: CustomPageDefinition[] = [];
  for (const candidate of value.slice(0, 128)) {
    if (!candidate || typeof candidate !== "object") continue;
    const page = candidate as Partial<CustomPageDefinition>;
    if (
      typeof page.id !== "string" ||
      !page.id ||
      page.id.length > 256 ||
      identifiers.has(page.id) ||
      typeof page.label !== "string" ||
      !page.label.trim() ||
      page.label.length > 80
    ) {
      continue;
    }
    identifiers.add(page.id);
    pages.push({id: page.id, label: page.label.trim()});
  }
  return pages;
}

function normalizeHiddenPages(
  value: unknown,
  definition: DashboardDefinition,
  hasCustomPages: boolean,
): PageId[] {
  const known = new Set(definition.navigation.map(item => item.id));
  const hidden = Array.isArray(value)
    ? [...new Set(
        value.filter(
          (item): item is PageId =>
            typeof item === "string" && known.has(item),
        ),
      )]
    : [];
  if (!hasCustomPages && hidden.length >= definition.navigation.length) {
    hidden.shift();
  }
  return hidden;
}

function normalizePageLabels(
  value: unknown,
  definition: DashboardDefinition,
  customPages: CustomPageDefinition[],
): Record<PageId, string> {
  if (!value || typeof value !== "object") return {};
  const known = new Set([
    ...definition.navigation.map(item => item.id),
    ...customPages.map(item => item.id),
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([id, label]) =>
          known.has(id) &&
          typeof label === "string" &&
          Boolean(label.trim()) &&
          label.length <= 80,
      )
      .map(([id, label]) => [id, (label as string).trim()]),
  );
}

function defaultChartDefaults(): ChartDefaults {
  return {
    style: "line",
    columnSpan: 1,
    height: 270,
    lineWidth: 1.5,
  };
}

function normalizeChartDefaults(value: unknown): ChartDefaults {
  if (!value || typeof value !== "object") return defaultChartDefaults();
  const candidate = value as Partial<ChartDefaults>;
  return {
    style: candidate.style === "area" ? "area" : "line",
    columnSpan: candidate.columnSpan === 2 ? 2 : 1,
    height:
      typeof candidate.height === "number" &&
      candidate.height >= 180 &&
      candidate.height <= 720
        ? candidate.height
        : 270,
    lineWidth:
      typeof candidate.lineWidth === "number" &&
      candidate.lineWidth >= 0.5 &&
      candidate.lineWidth <= 5
        ? candidate.lineWidth
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
  navigationItems: NavigationItem[],
): NavigationSection[] {
  const knownPages = new Set(navigationItems.map(item => item.id));
  const defaults = defaultNavigationSections(definition).map(section => ({
    ...section,
    pages: section.pages.filter(page => knownPages.has(page)),
  }));
  const sectionIds = new Set<string>();
  const assignedPages = new Set<PageId>();
  const sections: NavigationSection[] = [];
  const candidates =
    Array.isArray(value) && value.length ? value.slice(0, 64) : defaults;
  for (const candidate of candidates) {
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
  if (!sections.length) {
    sections.push(...defaults);
    for (const section of defaults) {
      for (const page of section.pages) assignedPages.add(page);
    }
  }
  for (const item of navigationItems) {
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
