import type { SystemPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

export class SystemPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly content: HTMLElement;

  constructor(
    definition: SystemPanelDefinition,
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
      .filter(([name]) => name.startsWith("monitor/"))
      .sort(([left], [right]) => left.localeCompare(right));
    const fragment = document.createDocumentFragment();
    fragment.append(
      systemCard("Host", this.context.store.host || "--"),
      systemCard("Version", this.context.store.version || "--"),
      systemCard(
        "Latest sample",
        this.context.store.latestTimestamp
          ? new Date(this.context.store.latestTimestamp * 1000).toISOString()
          : "--",
      ),
      systemCard("Metrics endpoint", "/metrics"),
      systemCard("Status API", "/api/status"),
      systemCard("History API", "/api/history"),
      systemCard("WebSocket", "/api/ws"),
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
