export interface DataColumn<T> {
  id: string;
  label: string;
  sortValue?: string;
  className?: string;
  width?: string;
  pinned?: boolean;
  render(row: T): string | Node;
}

export type SortDirection = "asc" | "desc";

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
      if (column.pinned) cell.classList.add("column-pinned");
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
          if (column.pinned) cell.classList.add("column-pinned");
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
