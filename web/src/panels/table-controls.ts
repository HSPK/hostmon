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

export function tableFooter(
  count: HTMLElement,
  ...actions: HTMLElement[]
): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "data-grid-footer";
  const controls = document.createElement("div");
  controls.className = "data-grid-pagination";
  controls.append(...actions);
  footer.append(count, controls);
  return footer;
}
