import { describe, expect, it } from "vitest";

import type { HistoryResponse } from "../domain/types";
import { historyToCsv, TimeSeriesStore } from "./time-series-store";

describe("TimeSeriesStore", () => {
  it("loads columnar history and appends live snapshots", () => {
    const store = new TimeSeriesStore(60);
    const history: HistoryResponse = {
      from: 10,
      to: 20,
      timestamps: [10, 20],
      series: {"cpu/percent": [10, 20]},
      metadata: {
        "cpu/percent": {label: "CPU", unit: "%", color: "#fff"},
      },
    };
    store.replaceHistory(history);
    store.append({
      timestamp: 30,
      host: "host-a",
      metrics: {"cpu/percent": 30},
      fields: {},
    });

    expect(store.timestamps).toEqual([10, 20, 30]);
    expect(store.series.get("cpu/percent")).toEqual([10, 20, 30]);
    expect(store.latestMetrics["cpu/percent"]).toBe(30);
  });

  it("bounds history and aligns newly discovered metrics", () => {
    const store = new TimeSeriesStore(20);
    for (let timestamp = 10; timestamp <= 40; timestamp += 10) {
      store.append({
        timestamp,
        host: "host-a",
        metrics:
          timestamp === 40
            ? {"cpu/percent": timestamp, "custom/value": 1}
            : {"cpu/percent": timestamp},
        fields: {},
      });
    }

    expect(store.timestamps).toEqual([20, 30, 40]);
    expect(store.series.get("custom/value")).toEqual([null, null, 1]);
  });

  it("exports aligned CSV", () => {
    const store = new TimeSeriesStore();
    store.append({
      timestamp: 1,
      host: "host-a",
      metrics: {"cpu/percent": 25},
      fields: {},
    });

    const csv = store.exportCsv(["cpu/percent"]);

    expect(csv).toContain("timestamp,cpu/percent");
    expect(csv).toContain(",25");
  });

  it("exports a standalone history response", () => {
    const csv = historyToCsv(
      {
        timestamps: [1],
        series: {"cpu/percent": [25]},
      },
      ["cpu/percent"],
    );

    expect(csv).toContain("timestamp,cpu/percent");
    expect(csv).toContain(",25");
  });

  it("stores history only for explicitly tracked metrics", () => {
    const store = new TimeSeriesStore(60, ["cpu/percent"]);
    store.append({
      timestamp: 1,
      host: "host-a",
      metrics: {"cpu/percent": 10, "unbounded/cardinality": 99},
      fields: {},
    });

    expect(store.series.get("cpu/percent")).toEqual([10]);
    expect(store.series.has("unbounded/cardinality")).toBe(false);
    expect(store.latestMetrics["unbounded/cardinality"]).toBe(99);
  });

  it("bounds long windows by point count", () => {
    const store = new TimeSeriesStore(1000, ["cpu/percent"], 3);
    for (let timestamp = 1; timestamp <= 5; timestamp++) {
      store.append({
        timestamp,
        host: "host-a",
        metrics: {"cpu/percent": timestamp},
        fields: {},
      });
    }

    expect(store.timestamps).toEqual([3, 4, 5]);
    expect(store.series.get("cpu/percent")).toEqual([3, 4, 5]);
  });

  it("changes series revision only when chart data changes", () => {
    const store = new TimeSeriesStore();
    const initial = store.revision();
    store.applyStatus({
      host: "host-a",
      version: "test",
      updated_at: 1,
      metrics: {"cpu/percent": 10},
      fields: {},
      websocket_clients: 0,
      websocket_inactivity_timeout_seconds: 30,
    });
    expect(store.revision()).toBe(initial);
    store.append({
      timestamp: 2,
      host: "host-a",
      metrics: {"cpu/percent": 20},
      fields: {},
    });
    expect(store.revision()).toBe(initial + 1);
  });
});
