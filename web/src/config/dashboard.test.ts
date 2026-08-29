import { describe, expect, it } from "vitest";

import pluginDashboard from "../../../plugins/cluster-gpu/dashboard.json";
import { assertDashboard, DASHBOARD } from "./dashboard";

describe("dashboard definition", () => {
  it("has unique panel IDs and registered panel types", () => {
    const ids = DASHBOARD.panels.map(panel => panel.id);
    const supported = new Set([
      "stats",
      "timeseries",
      "collectors",
      "tasks",
      "metrics",
      "system",
      "plugin-summary",
      "plugin-records",
      "rules",
      "web-settings",
    ]);

    expect(new Set(ids).size).toBe(ids.length);
    expect(DASHBOARD.panels.every(panel => supported.has(panel.type))).toBe(true);
    expect(new Set(DASHBOARD.panels.map(panel => panel.page))).toEqual(
      new Set(DASHBOARD.navigation.map(item => item.id)),
    );
  });

  it("uses valid time-series metric lists", () => {
    const panels = DASHBOARD.panels.filter(
      panel => panel.type === "timeseries",
    );

    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every(panel => panel.metrics.length > 0)).toBe(true);
  });

  it("validates the repository-local plugin dashboard", () => {
    expect(() => assertDashboard(pluginDashboard)).not.toThrow();
    expect(pluginDashboard.panels.some(
      panel => panel.type === "plugin-summary",
    )).toBe(true);
  });
});
