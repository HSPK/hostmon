import type { StatPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

export class StatPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly values = new Map<string, HTMLElement>();

  constructor(
    private readonly definition: StatPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "stat-panel");
    this.element = shell.element;
    const grid = document.createElement("div");
    grid.className = "stat-grid";
    for (const item of definition.metrics) {
      const card = document.createElement("article");
      card.className = "stat-card";
      const label = document.createElement("span");
      label.className = "stat-label";
      label.textContent = item.label;
      const value = document.createElement("strong");
      value.className = "stat-value";
      value.textContent = "--";
      card.append(label, value);
      grid.append(card);
      this.values.set(item.metric, value);
    }
    shell.body.append(grid);
    this.update();
  }

  update(): void {
    for (const item of this.definition.metrics) {
      const output = this.values.get(item.metric);
      if (!output) continue;
      const value = this.context.store.latestMetrics[item.metric];
      output.textContent = typeof value === "number" && Number.isFinite(value)
        ? `${value.toFixed(item.decimals ?? 1)} ${item.unit}`.trim()
        : "--";
    }
  }

  destroy(): void {
    this.values.clear();
  }
}
