import type { SystemPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import { renderDisplayItem } from "./display-values";

export class SystemPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly content: HTMLElement;

  constructor(
    private readonly definition: SystemPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "system-panel");
    this.element = shell.element;
    this.content = document.createElement("div");
    this.content.className = "system-grid";
    shell.body.append(this.content);
    this.update();
  }

  update(): void {
    const metrics = this.context.store.latestMetrics;
    const internal = Object.entries(metrics)
      .filter(
        ([name]) =>
          (!this.definition.metricFilter?.prefix ||
            name.startsWith(this.definition.metricFilter.prefix)) &&
          (!this.definition.metricFilter?.suffix ||
            name.endsWith(this.definition.metricFilter.suffix)),
      )
      .sort(([left], [right]) => left.localeCompare(right));
    const fragment = document.createDocumentFragment();
    fragment.append(
      ...this.definition.items.map(definition =>
        systemCard(
          definition.label,
          renderDisplayItem(definition, this.context.store),
        ),
      ),
    );
    const table = document.createElement("table");
    table.className = "metric-table compact";
    const body = document.createElement("tbody");
    for (const [name, value] of internal) {
      const row = document.createElement("tr");
      const metric = document.createElement("td");
      metric.textContent = name;
      const output = document.createElement("td");
      output.textContent = String(value);
      row.append(metric, output);
      body.append(row);
    }
    table.append(body);
    const wrapper = document.createElement("div");
    wrapper.className = "system-metrics";
    wrapper.append(table);
    fragment.append(wrapper);
    this.content.replaceChildren(fragment);
  }

  destroy(): void {}
}

function systemCard(label: string, value: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "system-card";
  const title = document.createElement("span");
  title.textContent = label;
  const output = document.createElement("code");
  output.textContent = value;
  card.append(title, output);
  return card;
}
