import { beforeEach, describe, expect, it } from "vitest";

import { DASHBOARD } from "../config/dashboard";
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

    const restored = new PreferenceStore(DASHBOARD);

    expect(restored.get().hiddenPanels).toContain("network");
    expect(restored.get().windowSeconds).toBe(900);
    expect(restored.visiblePanels().some(panel => panel.id === "network")).toBe(false);
  });

  it("recovers from invalid stored data", () => {
    localStorage.setItem("hostmon.dashboard.preferences.v1", "{invalid");

    const preferences = new PreferenceStore(DASHBOARD).get();

    expect(preferences.panelOrder).toEqual(
      DASHBOARD.panels.map(panel => panel.id),
    );
  });
});
