import rawDashboard from "./dashboard.json";
import type {
  DashboardDefinition,
  NavigationItem,
  PanelDefinition,
} from "../domain/types";

assertDashboard(rawDashboard);

export const DASHBOARD: DashboardDefinition = rawDashboard;
export const NAVIGATION: NavigationItem[] = DASHBOARD.navigation;

function assertDashboard(value: unknown): asserts value is DashboardDefinition {
  if (!isRecord(value)) throw new Error("Dashboard config must be an object");
  if (
    typeof value.title !== "string" ||
    typeof value.defaultWindowSeconds !== "number" ||
    !Array.isArray(value.navigation) ||
    !Array.isArray(value.panels)
  ) {
    throw new Error("Dashboard config is missing required fields");
  }
  const pages = new Set<string>();
  for (const item of value.navigation) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.label !== "string" ||
      pages.has(item.id)
    ) {
      throw new Error("Dashboard navigation entries must have unique ids");
    }
    pages.add(item.id);
  }
  if (!value.panels.every(panel => isPanel(panel, pages))) {
    throw new Error("Dashboard contains an invalid panel definition");
  }
}

function isPanel(value: unknown, pages: Set<string>): value is PanelDefinition {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.type !== "string" ||
    typeof value.page !== "string" ||
    !pages.has(value.page)
  ) {
    return false;
  }
  if (value.type === "timeseries") {
    return (
      Array.isArray(value.metrics) &&
      value.metrics.every(metric => typeof metric === "string")
    );
  }
  if (value.type === "stats") {
    return (
      Array.isArray(value.metrics) &&
      value.metrics.every(
        metric =>
          isRecord(metric) &&
          typeof metric.metric === "string" &&
          typeof metric.label === "string" &&
          typeof metric.unit === "string",
      )
    );
  }
  if (
    value.columns !== undefined &&
    (!Array.isArray(value.columns) ||
      !value.columns.every(column => typeof column === "string"))
  ) {
    return false;
  }
  return [
    "collectors",
    "tasks",
    "metrics",
    "system",
    "gpu-fleet",
    "gpu-submitters",
    "rules",
    "web-settings",
  ].includes(value.type);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
