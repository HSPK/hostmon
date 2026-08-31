import { describe, expect, it } from "vitest";

import { formatUtc8Timestamp } from "./date-time";

describe("formatUtc8Timestamp", () => {
  const timestamp = Date.UTC(2026, 7, 31, 4, 34, 56) / 1000;

  it("formats a full UTC+8 timestamp", () => {
    expect(formatUtc8Timestamp(timestamp)).toBe(
      "2026-08-31, 12:34:56",
    );
  });

  it("formats a compact UTC+8 timestamp", () => {
    expect(formatUtc8Timestamp(timestamp, "compact")).toBe(
      "08-31, 12:34:56",
    );
  });
});
