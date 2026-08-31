import { beforeEach, describe, expect, it } from "vitest";

import { DASHBOARD } from "../config/dashboard";
import type { TimeSeriesPanelDefinition } from "../domain/types";
import { PreferenceStore } from "./preferences";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

describe("PreferenceStore", () => {
  it("distinguishes existing local preferences from defaults", () => {
    expect(new PreferenceStore(DASHBOARD).hasLocalPreferences()).toBe(false);
    localStorage.setItem(
      "hostmon.dashboard.preferences.v2",
      JSON.stringify({theme: "light"}),
    );
    expect(new PreferenceStore(DASHBOARD).hasLocalPreferences()).toBe(true);
  });

  it("preserves unconfirmed local fields while hydrating server state", () => {
    const local = new PreferenceStore(DASHBOARD);
    local.setWindow(900);
    const restored = new PreferenceStore(DASHBOARD);
    const server = {
      ...restored.get(),
      windowSeconds: 3600,
      theme: "light" as const,
    };

    restored.hydrate(server);

    expect(restored.get().windowSeconds).toBe(900);
    expect(restored.get().theme).toBe("light");
    expect(restored.pendingFields()).toContain("windowSeconds");
    restored.markPersisted(["windowSeconds"]);
    expect(restored.pendingFields()).not.toContain("windowSeconds");
  });

  it("marks only appearance fields that actually changed", () => {
    const preferences = new PreferenceStore(DASHBOARD);

    preferences.setAppearance("dark", "comfortable");

    expect(preferences.pendingFields()).toEqual(["density"]);
  });

  it("does not mutate hydrated server preference objects", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    const server = {
      ...preferences.get(),
      panelState: {records: {filter: "all"}},
      panelColumns: {collectors: ["name"]},
    };
    preferences.hydrate(server);

    preferences.setPanelState("records", {filter: "active"});
    preferences.setPanelColumns("collectors", ["name", "state"]);

    expect(server.panelState.records.filter).toBe("all");
    expect(server.panelColumns.collectors).toEqual(["name"]);
  });

  it("normalizes legacy zero-height chart overrides", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    preferences.hydrate({
      ...preferences.get(),
      customPanels: [
        {
          id: "host-utilization",
          type: "timeseries",
          page: "overview",
          title: "Legacy chart",
          metrics: ["cpu/percent"],
          custom: true,
          height: 0,
          lineWidth: 0,
        },
      ],
    });

    expect(preferences.get().customPanels[0]?.height).toBe(270);
    expect(preferences.get().customPanels[0]?.lineWidth).toBe(1.5);
  });

  it("persists visibility, order, and time window", () => {
    const first = new PreferenceStore(DASHBOARD);
    first.setVisible("network", false);
    first.move("tasks", -1);
    first.setWindow(900);
    first.setPanelState("records", {
      filter: "attention",
      sort: "pending_gpus",
      sortDirection: "desc",
    });

    const restored = new PreferenceStore(DASHBOARD);

    expect(restored.get().hiddenPanels).toContain("network");
    expect(restored.get().windowSeconds).toBe(900);
    expect(restored.get().panelState.records).toEqual({
      filter: "attention",
      sort: "pending_gpus",
      sortDirection: "desc",
    });
    expect(restored.visiblePanels().some(panel => panel.id === "network")).toBe(false);
  });

  it("recovers from invalid stored data", () => {
    localStorage.setItem("hostmon.dashboard.preferences.v1", "{invalid");

    const preferences = new PreferenceStore(DASHBOARD).get();

    expect(preferences.panelOrder).toEqual(
      DASHBOARD.panels.map(panel => panel.id),
    );
  });

  it("persists and removes custom charts", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    preferences.saveCustomPanel({
      id: "custom-latency",
      type: "timeseries",
      page: "overview",
      title: "Latency",
      metrics: ["custom/latency_ms"],
      custom: true,
    });

    const restored = new PreferenceStore(DASHBOARD);
    expect(restored.get().customPanels).toHaveLength(1);
    expect(restored.visiblePanels("overview").some(
      panel => panel.id === "custom-latency",
    )).toBe(true);

    restored.removeCustomPanel("custom-latency");
    expect(restored.get().customPanels).toHaveLength(0);
  });

  it("persists configurable navigation sections without losing pages", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    const sectionId = preferences.addNavigationSection(
      "Operations",
      "main",
    );
    expect(sectionId).not.toBeNull();
    preferences.setPageNavigationSection("metrics", sectionId!);
    preferences.moveNavigationSection(sectionId!, -1);

    const restored = new PreferenceStore(DASHBOARD);
    const section = restored.get().navigationSections.find(
      item => item.id === sectionId,
    );
    expect(section?.pages).toContain("metrics");
    expect(
      restored
        .get()
        .navigationSections.filter(item => item.placement === "main")
        .map(item => item.label),
    ).toEqual(["Charts", "Tables", "Operations", "Manage"]);
    const charts = restored.get().navigationSections.find(
      item => item.label === "Charts",
    )!;
    restored.moveNavigationSectionRelative(sectionId!, charts.id, false);
    expect(
      restored
        .get()
        .navigationSections.filter(item => item.placement === "main")
        .map(item => item.label),
    ).toEqual(["Operations", "Charts", "Tables", "Manage"]);
    expect(restored.removeNavigationSection(sectionId!)).toBe(true);
    expect(
      restored.get().navigationSections.flatMap(item => item.pages),
    ).toContain("metrics");
  });

  it("creates, updates, and removes metric pages safely", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    const charts = preferences.get().navigationSections.find(
      section => section.label === "Charts",
    )!;
    const tables = preferences.get().navigationSections.find(
      section => section.label === "Tables",
    )!;
    const pageId = preferences.addPage("Experiments", charts.id);
    expect(pageId).toBe("page-experiments");
    preferences.saveCustomPanel({
      id: "custom-experiment",
      type: "timeseries",
      page: pageId!,
      title: "Experiment metric",
      metrics: ["cpu/percent"],
      custom: true,
    });
    preferences.updatePage(pageId!, "Training runs", tables.id);

    const restored = new PreferenceStore(DASHBOARD);
    expect(restored.navigationItems()).toContainEqual({
      id: pageId,
      label: "Training runs",
    });
    expect(
      restored
        .get()
        .navigationSections.find(section => section.id === tables.id)
        ?.pages,
    ).toContain(pageId);

    expect(restored.removePage(pageId!)).toBe(true);
    expect(restored.navigationItems().some(page => page.id === pageId)).toBe(
      false,
    );
    expect(
      restored.get().customPanels.find(panel => panel.id === "custom-experiment")
        ?.page,
    ).not.toBe(pageId);
  });

  it("hides built-in pages and preserves chart defaults", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    preferences.setChartDefaults({
      style: "area",
      columnSpan: 2,
      height: 360,
      lineWidth: 2.5,
    });
    expect(preferences.removePage("metrics")).toBe(true);

    const restored = new PreferenceStore(DASHBOARD);
    expect(restored.navigationItems().some(page => page.id === "metrics")).toBe(
      false,
    );
    expect(restored.get().hiddenPages).toContain("metrics");
    expect(restored.get().chartDefaults).toEqual({
      style: "area",
      columnSpan: 2,
      height: 360,
      lineWidth: 2.5,
    });
  });

  it("persists drag ordering before a target panel", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    preferences.moveBefore("network", "host-utilization");

    const restored = new PreferenceStore(DASHBOARD);
    const ids = restored.visiblePanels("overview").map(panel => panel.id);

    expect(ids.indexOf("network")).toBeLessThan(
      ids.indexOf("host-utilization"),
    );
  });

  it("overrides a built-in chart without duplicating its order", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    const original = DASHBOARD.panels.find(
      (panel): panel is TimeSeriesPanelDefinition =>
        panel.id === "host-utilization" && panel.type === "timeseries",
    );
    expect(original).toBeDefined();
    preferences.saveCustomPanel({
      ...original!,
      title: "Edited utilization",
      custom: true,
    });

    const restored = new PreferenceStore(DASHBOARD);
    const panels = restored
      .visiblePanels("overview")
      .filter(panel => panel.id === "host-utilization");

    expect(panels).toHaveLength(1);
    expect(panels[0]?.title).toBe("Edited utilization");
  });

  it("persists configured table columns", () => {
    const preferences = new PreferenceStore(DASHBOARD);
    preferences.setPanelColumns("collectors", ["name", "state"]);

    const restored = new PreferenceStore(DASHBOARD);
    const panel = restored
      .visiblePanels("collectors")
      .find(item => item.id === "collectors");

    expect(panel?.columns?.map(column => column.id)).toEqual([
      "name",
      "state",
    ]);
  });
});
