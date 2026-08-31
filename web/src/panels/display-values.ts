import type {
  DisplayItemDefinition,
  DisplayValueSource,
} from "../domain/types";
import type { TimeSeriesStore } from "../core/time-series-store";
import { formatUtc8Timestamp } from "../core/date-time";

export function renderDisplayItem(
  definition: DisplayItemDefinition,
  store: TimeSeriesStore,
): string {
  const values = Object.fromEntries(
    Object.entries(definition.values).map(([name, source]) => [
      name,
      formatDisplayValue(source, resolveValue(source, store)),
    ]),
  );
  return definition.template.replace(
    /\{([a-zA-Z0-9_]+)\}/g,
    (_match, name: string) => String(values[name] ?? "--"),
  );
}

function resolveValue(
  definition: DisplayValueSource,
  store: TimeSeriesStore,
): string | number {
  if (definition.source === "static") return definition.value ?? "--";
  if (definition.source === "system") {
    if (definition.key === "host") return store.host || "--";
    if (definition.key === "version") return store.version || "--";
    if (definition.key === "updated_at") {
      return store.latestTimestamp > 0
        ? store.latestTimestamp
        : definition.fallback ?? "--";
    }
    return "--";
  }
  if (definition.source === "field") {
    const value = definition.key
      ? store.latestFields[definition.key]
      : undefined;
    return value === undefined || value === null
      ? definition.fallback ?? "--"
      : typeof value === "number"
        ? value
        : String(value);
  }
  if (definition.source === "metric") {
    const value = definition.key
      ? store.latestMetrics[definition.key]
      : undefined;
    return typeof value === "number" && Number.isFinite(value)
      ? value
      : definition.fallback ?? "--";
  }
  const matches = Object.entries(store.latestMetrics).filter(
    ([name]) =>
      (!definition.prefix || name.startsWith(definition.prefix)) &&
      (!definition.suffix || name.endsWith(definition.suffix)),
  );
  const matched =
    definition.equals === undefined
      ? matches.length
      : matches.filter(([, value]) => value === definition.equals).length;
  return `${matched}/${matches.length}`;
}

function formatDisplayValue(
  definition: DisplayValueSource,
  value: string | number,
): string | number {
  if (definition.format !== "timestamp") return value;
  return typeof value === "number" && Number.isFinite(value)
    ? formatUtc8Timestamp(value)
    : definition.fallback ?? "--";
}
