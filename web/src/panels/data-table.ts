import type { TableColumnDefinition } from "../domain/types";

export interface DataColumn<T> {
  id: string;
  label: string;
  sortValue?: string;
  className?: string;
  width?: string;
  align?: "left" | "center" | "right";
  pinned?: "left" | "right";
  pinnedOffset?: number;
  render(row: T): string | Node;
}

export type SortDirection = "asc" | "desc";
export type ColumnAction<T> = (row: T) => string | Node;

export function configuredColumns<T extends object>(
  definitions: TableColumnDefinition[],
  actions: Record<string, ColumnAction<T>> = {},
): DataColumn<T>[] {
  return withPinnedOffsets(
    definitions.map(definition => ({
      id: definition.id,
      label: definition.label,
      ...(definition.width ? {width: definition.width} : {}),
      ...(definition.align ? {align: definition.align} : {}),
      ...(definition.pinned
        ? {
            pinned:
              definition.pinned === true ? "left" : definition.pinned,
          }
        : {}),
      ...(definition.sort ? {sortValue: definition.sort} : {}),
      render: row => {
        if (definition.action && actions[definition.action]) {
          return actions[definition.action]!(row);
        }
        const value = readPath(row, definition.path ?? definition.id);
        return formatConfiguredValue(
          value,
          definition.format,
          row,
          definition.unit ?? "",
          definition.fallback ?? "--",
        );
      },
    })),
  );
}

export function readPath(value: object, path: string): unknown {
  let current: unknown = value;
  for (const component of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[component];
  }
  return current;
}

export function compareByPath(
  left: object,
  right: object,
  path: string,
  direction: SortDirection,
): number {
  const first = readPath(left, path);
  const second = readPath(right, path);
  const result =
    typeof first === "number" && typeof second === "number"
      ? first - second
      : String(first ?? "").localeCompare(String(second ?? ""));
  return direction === "asc" ? result : -result;
}

export function formatConfiguredValue(
  value: unknown,
  format: TableColumnDefinition["format"],
  row: object,
  unit: string,
  fallback: string,
): string | Node {
  if (format === "state") {
    const state = document.createElement("span");
    const text = String(value ?? "unknown");
    const normalized = text.toLowerCase();
    const kind =
      ["up", "running", "enabled", "ok"].includes(normalized)
        ? "up"
        : ["stale", "pending", "warning"].includes(normalized)
          ? "stale"
          : ["mixed", "info"].includes(normalized)
            ? "mixed"
            : "down";
    state.className = `state state-${kind}`;
    state.textContent = text;
    return state;
  }
  if (format === "timestamp") {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(value * 1000));
  }
  if (format === "duration") {
    return typeof value === "number" && Number.isFinite(value)
      ? `${value.toFixed(1)} s`
      : fallback;
  }
  if (format === "metric") {
    const unit = readPath(row, "metadata.unit");
    return formatNumber(value, typeof unit === "string" ? unit : "", fallback);
  }
  if (format === "number") return formatNumber(value, unit, fallback);
  return value === undefined || value === null ? fallback : String(value);
}

function formatNumber(
  value: unknown,
  unit: string,
  fallback = "--",
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (unit === "bytes") return formatBytes(value);
  if (unit === "s" && value >= 120) return formatDuration(value);
  const magnitude = Math.abs(value);
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)}${unit ? ` ${unit}` : ""}`;
}

function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = Math.abs(value);
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index++;
  }
  const sign = value < 0 ? "-" : "";
  const decimals = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${sign}${scaled.toFixed(decimals)} ${units[index]}`;
}

function formatDuration(value: number): string {
  if (value >= 86400) return `${(value / 86400).toFixed(1)} d`;
  if (value >= 3600) return `${(value / 3600).toFixed(1)} h`;
  return `${(value / 60).toFixed(1)} min`;
}

export class DataTable<T> {
  readonly element: HTMLElement;
  readonly viewport: HTMLElement;
  private readonly body: HTMLTableSectionElement;
  private readonly sortHeaders = new Map<
    string,
    HTMLTableCellElement
  >();
  private sortValue = "";
  private sortDirection: SortDirection = "asc";

  constructor(
    columns: DataColumn<T>[],
    className = "",
    onSort?: (value: string, direction: SortDirection) => void,
    private readonly onRowDoubleClick?: (row: T) => void,
    initialSort?: {value: string; direction: SortDirection},
  ) {
    this.element = document.createElement("div");
    this.element.className = "data-grid";
    this.viewport = document.createElement("div");
    this.viewport.className = "table-scroll data-grid-viewport";
    const table = document.createElement("table");
    table.className = `metric-table ${className}`.trim();
    const configuredWidth = columns.reduce(
      (total, column) => total + pixelWidth(column.width),
      0,
    );
    if (configuredWidth) table.style.minWidth = `${configuredWidth}px`;
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("th");
      cell.dataset.column = column.id;
      cell.title = column.label;
      if (column.width) {
        cell.style.width = column.width;
        cell.style.minWidth = column.width;
      }
      if (column.align) cell.style.textAlign = column.align;
      applyPinnedColumn(cell, column);
      if (column.sortValue && onSort) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = column.label;
        this.sortHeaders.set(column.sortValue, cell);
        button.addEventListener("click", () => {
          const direction =
            this.sortValue === column.sortValue &&
            this.sortDirection === "asc"
              ? "desc"
              : "asc";
          this.setSort(column.sortValue!, direction);
          onSort(column.sortValue!, direction);
        });
        cell.append(button);
      } else {
        cell.textContent = column.label;
      }
      row.append(cell);
    }
    head.append(row);
    this.body = document.createElement("tbody");
    table.append(head, this.body);
    this.viewport.append(table);
    this.element.append(this.viewport);
    if (initialSort) {
      this.setSort(initialSort.value, initialSort.direction);
    }
  }

  setSort(value: string, direction: SortDirection): void {
    this.sortValue = value;
    this.sortDirection = direction;
    for (const [key, header] of this.sortHeaders) {
      header.setAttribute(
        "aria-sort",
        key === value
          ? direction === "asc"
            ? "ascending"
            : "descending"
          : "none",
      );
    }
  }

  setRows(rows: T[], columns: DataColumn<T>[], emptyMessage: string): void {
    if (!rows.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = columns.length;
      cell.className = "table-empty";
      cell.textContent = emptyMessage;
      row.append(cell);
      this.body.replaceChildren(row);
      return;
    }
    this.body.replaceChildren(
      ...rows.map(item => {
        const row = document.createElement("tr");
        for (const column of columns) {
          const cell = document.createElement("td");
          cell.dataset.column = column.id;
          if (column.className) cell.className = column.className;
          if (column.align) cell.style.textAlign = column.align;
          applyPinnedColumn(cell, column);
          const value = column.render(item);
          if (typeof value === "string") {
            cell.textContent = value;
            cell.title = value;
          }
          else cell.append(value);
          row.append(cell);
        }
        if (this.onRowDoubleClick) {
          row.addEventListener("dblclick", () => this.onRowDoubleClick?.(item));
        }
        return row;
      }),
    );
  }
}

function withPinnedOffsets<T>(columns: DataColumn<T>[]): DataColumn<T>[] {
  let left = 0;
  for (const column of columns) {
    if (column.pinned !== "left") continue;
    column.pinnedOffset = left;
    left += pixelWidth(column.width);
  }
  let right = 0;
  for (const column of [...columns].reverse()) {
    if (column.pinned !== "right") continue;
    column.pinnedOffset = right;
    right += pixelWidth(column.width);
  }
  return columns;
}

function applyPinnedColumn<T>(
  cell: HTMLTableCellElement,
  column: DataColumn<T>,
): void {
  if (!column.pinned) return;
  cell.classList.add("column-pinned", `column-pinned-${column.pinned}`);
  cell.style.setProperty(
    "--column-pin-offset",
    `${column.pinnedOffset ?? 0}px`,
  );
}

function pixelWidth(value: string | undefined): number {
  const match = value?.match(/^(\d+(?:\.\d+)?)px$/);
  return match ? Number(match[1]) : 0;
}
