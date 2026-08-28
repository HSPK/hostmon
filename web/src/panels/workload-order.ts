import type {
  ClusterGPUWorkloadRow,
  WorkloadSort,
} from "../domain/types";

export function compareWorkloads(
  left: ClusterGPUWorkloadRow,
  right: ClusterGPUWorkloadRow,
  sort: WorkloadSort,
  direction: "asc" | "desc" = "asc",
): number {
  let result: number;
  if (sort === "pending-gpus") {
    result = (
      left.pending_gpus - right.pending_gpus ||
      left.running_gpus - right.running_gpus ||
      left.name.localeCompare(right.name)
    );
  } else if (sort === "name") {
    result = left.name.localeCompare(right.name);
  } else if (sort === "submitter") {
    result = (
      left.submitter.localeCompare(right.submitter) ||
      left.name.localeCompare(right.name)
    );
  } else if (sort === "queue") {
    result = (
      left.queue.localeCompare(right.queue) ||
      left.running_gpus - right.running_gpus ||
      left.name.localeCompare(right.name)
    );
  } else {
    result = (
      left.running_gpus - right.running_gpus ||
      left.pending_gpus - right.pending_gpus ||
      left.name.localeCompare(right.name)
    );
  }
  return direction === "asc" ? result : -result;
}
