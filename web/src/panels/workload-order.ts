import type { ClusterGPUWorkloadRow } from "../domain/types";

export type WorkloadSort =
  | "running-gpus"
  | "pending-gpus"
  | "name"
  | "submitter"
  | "queue";

export function compareWorkloads(
  left: ClusterGPUWorkloadRow,
  right: ClusterGPUWorkloadRow,
  sort: WorkloadSort,
): number {
  if (sort === "pending-gpus") {
    return (
      right.pending_gpus - left.pending_gpus ||
      right.running_gpus - left.running_gpus ||
      left.name.localeCompare(right.name)
    );
  }
  if (sort === "name") return left.name.localeCompare(right.name);
  if (sort === "submitter") {
    return (
      left.submitter.localeCompare(right.submitter) ||
      left.name.localeCompare(right.name)
    );
  }
  if (sort === "queue") {
    return (
      left.queue.localeCompare(right.queue) ||
      right.running_gpus - left.running_gpus ||
      left.name.localeCompare(right.name)
    );
  }
  return (
    right.running_gpus - left.running_gpus ||
    right.pending_gpus - left.pending_gpus ||
    left.name.localeCompare(right.name)
  );
}
