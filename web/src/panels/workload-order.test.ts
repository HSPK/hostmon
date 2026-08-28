import { describe, expect, it } from "vitest";

import type { ClusterGPUWorkloadRow } from "../domain/types";
import { compareWorkloads } from "./workload-order";

const running = workload("running", 16, 0);
const pending = workload("pending", 0, 8);

describe("compareWorkloads", () => {
  it("orders by running or pending GPU demand", () => {
    expect([pending, running].sort((a, b) =>
      compareWorkloads(a, b, "running-gpus"),
    )[0]?.name).toBe("running");
    expect([running, pending].sort((a, b) =>
      compareWorkloads(a, b, "pending-gpus"),
    )[0]?.name).toBe("pending");
  });
});

function workload(
  name: string,
  runningGpus: number,
  pendingGpus: number,
): ClusterGPUWorkloadRow {
  return {
    queue: "queue-a",
    name,
    status: pendingGpus && runningGpus ? "Mixed" : pendingGpus ? "Pending" : "Running",
    submitter: "submitter",
    creator_id: "creator",
    running_pods: runningGpus ? 1 : 0,
    running_gpus: runningGpus,
    running_gpu_nodes: runningGpus ? 1 : 0,
    running_nodes: runningGpus ? ["node-a"] : [],
    pending_pods: pendingGpus ? 1 : 0,
    pending_gpus: pendingGpus,
  };
}
