import type { CollectorPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

interface CollectorHealth {
  name: string;
  up: number;
  stale: number;
  failures: number;
  age: number | undefined;
  duration: number | undefined;
}

export class CollectorPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly tableBody: HTMLTableSectionElement;

  constructor(
    definition: CollectorPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "collector-panel");
    this.element = shell.element;
    const table = document.createElement("table");
    table.className = "health-table";
    table.innerHTML = `
      <thead><tr>
        <th>Collector</th><th>State</th><th>Duration</th>
        <th>Last success</th><th>Failures</th>
      </tr></thead>
    `;
    this.tableBody = document.createElement("tbody");
    table.append(this.tableBody);
    shell.body.append(table);
    this.update();
  }

  update(): void {
    const rows = this.collectors();
    const fragment = document.createDocumentFragment();
    for (const row of rows) {
      const tr = document.createElement("tr");
      const state = row.up ? (row.stale ? "stale" : "up") : "down";
      tr.innerHTML = `
        <td>${escapeHtml(row.name)}</td>
        <td><span class="state state-${state}">${state}</span></td>
        <td>${format(row.duration, "ms")}</td>
        <td>${format(row.age, "s")}</td>
        <td>${row.failures.toFixed(0)}</td>
      `;
      fragment.append(tr);
    }
    this.tableBody.replaceChildren(fragment);
  }

  destroy(): void {}

  private collectors(): CollectorHealth[] {
    const metrics = this.context.store.latestMetrics;
    const prefix = "monitor/collector/";
    const names = new Set<string>();
    for (const metric of Object.keys(metrics)) {
      if (!metric.startsWith(prefix)) continue;
      const tail = metric.slice(prefix.length);
      const slash = tail.indexOf("/");
      if (slash > 0) names.add(tail.slice(0, slash));
    }
    return [...names].sort().map(name => ({
      name,
      up: metrics[`${prefix}${name}/up`] ?? 0,
      stale: metrics[`${prefix}${name}/stale`] ?? 0,
      failures: metrics[`${prefix}${name}/failures_total`] ?? 0,
      age: metrics[`${prefix}${name}/last_success_age_seconds`],
      duration: metrics[`${prefix}${name}/duration_ms`],
    }));
  }
}

function format(value: number | undefined, unit: string): string {
  return Number.isFinite(value) ? `${value!.toFixed(1)} ${unit}` : "--";
}

function escapeHtml(value: string): string {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}
