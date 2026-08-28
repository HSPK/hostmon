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
  private lastWidth = 0;
  private lastHeight = 0;
  private lastRevision = -1;
  private lastScaleKey = "";

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
      const configured = definition.series?.[metric];
      const item = document.createElement("span");
      item.textContent = configured?.label ?? metadata?.label ?? metric;
      item.style.setProperty(
        "--series-color",
        configured?.color ?? metadata?.color ?? "#7dd3fc",
      );
      legend.append(item);
    }
    shell.header.append(legend);
    const actions = document.createElement("div");
    actions.className = "panel-actions";
    const edit = actionButton("Edit", () => context.actions.editChart(definition));
    actions.append(edit);
    if (definition.custom) {
      const remove = actionButton("Delete", () =>
        context.actions.removeChart(definition.id),
      );
      actions.append(remove);
    }
    shell.header.append(actions);
    this.chartHost = document.createElement("div");
    this.chartHost.className = "chart-host";
    shell.body.style.height = `${definition.height ?? 270}px`;
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
      if (width === this.lastWidth && height === this.lastHeight) return;
      this.lastWidth = width;
      this.lastHeight = height;
      this.plot.setSize({ width, height });
    });
    this.resizeObserver.observe(this.chartHost);
    this.update();
  }

  update(): void {
    const revision = this.context.store.revision();
    if (revision !== this.lastRevision) {
      this.lastRevision = revision;
      this.plot.setData(this.data(), false);
    }
    const latest =
      this.context.store.latestTimestamp || Date.now() / 1000;
    const scaleKey = `${latest}:${this.context.store.windowSeconds}`;
    if (scaleKey === this.lastScaleKey) return;
    this.lastScaleKey = scaleKey;
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
          size: 64,
        },
      ],
      series: [
        {},
        ...this.definition.metrics.map(metric => {
          const metadata = this.context.store.metadata.get(metric);
          const configured = this.definition.series?.[metric];
          const series: uPlot.Series = {
            label: configured?.label ?? metadata?.label ?? metric,
            stroke: configured?.color ?? metadata?.color ?? "#7dd3fc",
            width: this.definition.lineWidth ?? 1.5,
            spanGaps: true,
            points: { show: false },
          };
          const color = configured?.color ?? metadata?.color;
          if (this.definition.style === "area" && color) {
            series.fill = `${color}24`;
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
