import rawDashboard from "./dashboard.json";
import type {
  DashboardDefinition,
  NavigationItem,
  PanelDefinition,
} from "../domain/types";

assertDashboard(rawDashboard);

export const DASHBOARD: DashboardDefinition = rawDashboard;
export const NAVIGATION: NavigationItem[] = DASHBOARD.navigation;

export async function loadDashboard(): Promise<DashboardDefinition> {
  const response = await fetch("/dashboard.json", {cache: "no-store"});
  if (!response.ok) return DASHBOARD;
  const value: unknown = await response.json();
  assertDashboard(value);
  return value;
}

export function assertDashboard(
  value: unknown,
): asserts value is DashboardDefinition {
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
      value.metrics.every(metric => typeof metric === "string") &&
      (value.series === undefined ||
        (isRecord(value.series) &&
          Object.values(value.series).every(
            metadata =>
              isRecord(metadata) &&
              ["label", "unit", "color"].every(
                key =>
                  metadata[key] === undefined ||
                  typeof metadata[key] === "string",
              ),
          )))
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
      !value.columns.every(
        column =>
          isRecord(column) &&
          typeof column.id === "string" &&
          typeof column.label === "string" &&
          (column.path === undefined || typeof column.path === "string") &&
          (column.width === undefined || typeof column.width === "string") &&
          (column.mobileWidth === undefined ||
            typeof column.mobileWidth === "string") &&
          (column.align === undefined ||
            ["left", "center", "right"].includes(String(column.align))) &&
          (column.pinned === undefined ||
            typeof column.pinned === "boolean" ||
            ["left", "right"].includes(String(column.pinned))) &&
          (column.sort === undefined || typeof column.sort === "string") &&
          (column.action === undefined || typeof column.action === "string") &&
          (column.unit === undefined || typeof column.unit === "string") &&
          (column.fallback === undefined ||
            typeof column.fallback === "string") &&
          (column.format === undefined ||
            ["text", "number", "state", "metric", "timestamp", "duration"]
              .includes(String(column.format))),
      ))
  ) {
    return false;
  }
  if (
    value.type === "tasks" &&
    (!Array.isArray(value.items) || !value.items.every(isDisplayItem))
  ) {
    return false;
  }
  if (
    value.type === "system" &&
    (!Array.isArray(value.items) || !value.items.every(isDisplayItem))
  ) {
    return false;
  }
  if (
    value.type === "plugin-summary" &&
    (!Array.isArray(value.summary) ||
      typeof value.plugin !== "string" ||
      !value.summary.every(
        item =>
          isRecord(item) &&
          typeof item.label === "string" &&
          typeof item.path === "string",
      ))
  ) {
    return false;
  }
  return [
    "collectors",
    "tasks",
    "metrics",
    "system",
    "plugin-summary",
    "plugin-records",
    "rules",
    "web-settings",
  ].includes(value.type) &&
    (!["plugin-summary", "plugin-records"].includes(value.type) ||
      typeof value.plugin === "string");
}

function isDisplayItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.template === "string" &&
    isRecord(value.values) &&
    Object.values(value.values).every(
      source =>
        isRecord(source) &&
        ["metric", "field", "system", "static", "metricMatch"].includes(
          String(source.source),
        ),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
