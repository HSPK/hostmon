import { describe, expect, it } from "vitest";

import { TimeSeriesStore } from "../core/time-series-store";
import type { DisplayItemDefinition } from "../domain/types";
import { renderDisplayItem } from "./display-values";

describe("renderDisplayItem", () => {
  it("formats timestamp values from configuration", () => {
    const timestamp = Date.UTC(2026, 7, 31, 4, 34, 56) / 1000;
    const store = new TimeSeriesStore();
    store.applyStatus({
      host: "test-host",
      version: "test",
      updated_at: timestamp,
      metrics: {"custom/event_timestamp": timestamp},
      fields: {},
      websocket_clients: 0,
      websocket_inactivity_timeout_seconds: 30,
    });
    const definition: DisplayItemDefinition = {
      label: "Event time",
      template: "{value}",
      values: {
        value: {
          source: "metric",
          key: "custom/event_timestamp",
          format: "timestamp",
        },
      },
    };

    expect(renderDisplayItem(definition, store)).toBe(
      "2026-08-31, 12:34:56",
    );
  });
});
