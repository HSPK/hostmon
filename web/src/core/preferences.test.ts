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
  it("persists visibility, order, and time window", () => {
    const first = new PreferenceStore(DASHBOARD);
    first.setVisible("network", false);
    first.move("tasks", -1);
    first.setWindow(900);
    first.setWorkloadView({
      queue: "queue-a",
      state: "attention",
      sort: "pending-gpus",
    });

    const restored = new PreferenceStore(DASHBOARD);

    expect(restored.get().hiddenPanels).toContain("network");
    expect(restored.get().windowSeconds).toBe(900);
    expect(restored.get().workloadView).toEqual({
      queue: "queue-a",
      state: "attention",
      sort: "pending-gpus",
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
      page: "metrics",
      title: "Latency",
      metrics: ["custom/latency_ms"],
      custom: true,
    });

    const restored = new PreferenceStore(DASHBOARD);
    expect(restored.get().customPanels).toHaveLength(1);
    expect(restored.visiblePanels("metrics").some(
      panel => panel.id === "custom-latency",
    )).toBe(true);

    restored.removeCustomPanel("custom-latency");
    expect(restored.get().customPanels).toHaveLength(0);
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

    const panels = preferences
      .visiblePanels("overview")
      .filter(panel => panel.id === "host-utilization");

    expect(panels).toHaveLength(1);
    expect(panels[0]?.title).toBe("Edited utilization");
  });
});
