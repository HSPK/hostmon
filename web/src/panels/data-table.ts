export interface DataColumn<T> {
  id: string;
  label: string;
  sortValue?: string;
  className?: string;
  render(row: T): string | Node;
}

export class DataTable<T> {
  readonly element: HTMLElement;
  private readonly body: HTMLTableSectionElement;

  constructor(
    columns: DataColumn<T>[],
    className = "",
    onSort?: (value: string) => void,
    private readonly onRowDoubleClick?: (row: T) => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "table-scroll";
    const table = document.createElement("table");
    table.className = `metric-table ${className}`.trim();
    const head = document.createElement("thead");
    const row = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("th");
      if (column.sortValue && onSort) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = column.label;
        button.addEventListener("click", () => onSort(column.sortValue!));
        cell.append(button);
      } else {
        cell.textContent = column.label;
      }
      row.append(cell);
    }
    head.append(row);
    this.body = document.createElement("tbody");
    table.append(head, this.body);
    this.element.append(table);
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
          if (column.className) cell.className = column.className;
          const value = column.render(item);
          if (typeof value === "string") cell.textContent = value;
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
