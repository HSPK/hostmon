import { describe, expect, it } from "vitest";

import { formatItemCount } from "./table-controls";

describe("formatItemCount", () => {
  it("uses singular and plural labels", () => {
    expect(formatItemCount(0, "workload")).toBe("0 workloads");
    expect(formatItemCount(1, "workload")).toBe("1 workload");
    expect(formatItemCount(2, "workload")).toBe("2 workloads");
  });

  it("supports irregular plurals", () => {
    expect(formatItemCount(2, "person", "people")).toBe("2 people");
  });
});
