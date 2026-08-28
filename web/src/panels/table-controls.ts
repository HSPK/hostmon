export const TABLE_PAGE_SIZE = 75;

export function pageButton(
  label: string,
  action: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "table-action";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}

export function bindSortHeaders(
  table: HTMLTableElement,
  select: HTMLSelectElement,
): void {
  for (const button of table.querySelectorAll<HTMLButtonElement>(
    "[data-sort-value]",
  )) {
    button.addEventListener("click", () => {
      select.value = button.dataset.sortValue ?? select.value;
      select.dispatchEvent(new Event("change"));
    });
  }
}
