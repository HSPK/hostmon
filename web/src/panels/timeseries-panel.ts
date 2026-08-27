import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import type { TimeSeriesPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

const cursorSync = uPlot.sync("hostmon-dashboard");

export class TimeSeriesPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly chartHost: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private plot: uPlot;

  constructor(
    private readonly definition: TimeSeriesPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "timeseries-panel");
    this.element = shell.element;
    const legend = document.createElement("div");
    legend.className = "series-legend";
    for (const metric of definition.metrics) {
      const metadata = context.store.metadata.get(metric);
      const item = document.createElement("span");
      item.textContent = metadata?.label ?? metric;
      item.style.setProperty("--series-color", metadata?.color ?? "#7dd3fc");
      legend.append(item);
    }
    shell.header.append(legend);
    if (definition.custom) {
      const actions = document.createElement("div");
      actions.className = "panel-actions";
      const edit = actionButton("Edit", () => context.actions.editChart(definition));
      const remove = actionButton("Delete", () =>
        context.actions.removeChart(definition.id),
      );
      actions.append(edit, remove);
      shell.header.append(actions);
    }
    this.chartHost = document.createElement("div");
    this.chartHost.className = "chart-host";
    shell.body.append(this.chartHost);
    this.plot = new uPlot(
      this.options(),
      this.data(),
      this.chartHost,
    );
    this.resizeObserver = new ResizeObserver(entries => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.max(240, Math.floor(entry.contentRect.width));
      const height = Math.max(220, Math.floor(entry.contentRect.height));
      this.plot.setSize({ width, height });
    });
    this.resizeObserver.observe(this.chartHost);
    this.update();
  }

  update(): void {
    this.plot.setData(this.data(), false);
    const latest =
      this.context.store.latestTimestamp || Date.now() / 1000;
    this.plot.setScale("x", {
      min: latest - this.context.store.windowSeconds,
      max: latest,
    });
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    this.plot.destroy();
  }

  private data(): uPlot.AlignedData {
    return this.context.store.alignedData(
      this.definition.metrics,
    ) as uPlot.AlignedData;
  }

  private options(): uPlot.Options {
    const range = this.definition.range;
    return {
      width: 640,
      height: 250,
      pxAlign: 1,
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false },
        sync: { key: cursorSync.key },
      },
      scales: {
        x: { time: true },
        y: range ? { range: () => range } : { auto: true },
      },
      axes: [
        {
          stroke: "#8290a3",
          grid: { stroke: "#273241", width: 1 },
          ticks: { stroke: "#273241" },
          font: "11px ui-monospace, monospace",
        },
        {
          stroke: "#8290a3",
          grid: { stroke: "#273241", width: 1 },
          ticks: { stroke: "#273241" },
          font: "11px ui-monospace, monospace",
          size: 48,
        },
      ],
      series: [
        {},
        ...this.definition.metrics.map(metric => {
          const metadata = this.context.store.metadata.get(metric);
          const series: uPlot.Series = {
            label: metadata?.label ?? metric,
            stroke: metadata?.color ?? "#7dd3fc",
            width: 1.5,
            spanGaps: true,
            points: { show: false },
          };
          if (this.definition.style === "area" && metadata?.color) {
            series.fill = `${metadata.color}24`;
          }
          return series;
        }),
      ],
    };
  }
}

function actionButton(label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "table-action";
  button.textContent = label;
  button.addEventListener("click", action);
  return button;
}
