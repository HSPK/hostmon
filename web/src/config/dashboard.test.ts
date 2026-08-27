import { describe, expect, it } from "vitest";

import { DASHBOARD } from "./dashboard";

describe("dashboard definition", () => {
  it("has unique panel IDs and registered panel types", () => {
    const ids = DASHBOARD.panels.map(panel => panel.id);
    const supported = new Set(["stats", "timeseries", "collectors", "tasks"]);

    expect(new Set(ids).size).toBe(ids.length);
    expect(DASHBOARD.panels.every(panel => supported.has(panel.type))).toBe(true);
  });

  it("uses valid time-series metric lists", () => {
    const panels = DASHBOARD.panels.filter(
      panel => panel.type === "timeseries",
    );

    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every(panel => panel.metrics.length > 0)).toBe(true);
  });
});
