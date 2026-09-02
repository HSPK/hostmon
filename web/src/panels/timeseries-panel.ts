import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { APPEARANCE_CHANGED_EVENT } from "../core/appearance";
import type { TimeSeriesPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelActionButton, panelShell } from "./panel";

const cursorSync = uPlot.sync("hostmon-dashboard");

export class TimeSeriesPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly chartHost: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly legendItems = new Map<string, HTMLElement>();
  private plot: uPlot;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastRevision = -1;
  private lastScaleKey = "";
  private axisColor = themeColor("--chart-axis", "#8290a3");
  private gridColor = themeColor("--chart-grid", "#273241");
  private readonly redrawForAppearance = (): void => {
    this.axisColor = themeColor("--chart-axis", "#8290a3");
    this.gridColor = themeColor("--chart-grid", "#273241");
    this.plot.redraw(false, true);
  };

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
      this.legendItems.set(metric, item);
      legend.append(item);
    }
    shell.header.append(legend);
    const actions = document.createElement("div");
    actions.className = "panel-actions";
    const edit = panelActionButton(
      "Edit",
      () => context.actions.editPanel(definition),
    );
    actions.append(edit);
    if (definition.custom) {
      const remove = panelActionButton("Delete", () =>
        context.actions.removePanel(definition.id),
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
    window.addEventListener(
      APPEARANCE_CHANGED_EVENT,
      this.redrawForAppearance,
    );
    this.update();
  }

  update(): void {
    const revision = this.context.store.revision();
    const dataChanged = revision !== this.lastRevision;
    if (dataChanged) {
      this.lastRevision = revision;
      this.updateLegend();
      this.plot.setData(this.data(), false);
    }
    const latest =
      this.context.store.latestTimestamp || Date.now() / 1000;
    const scaleKey = `${latest}:${this.context.store.windowSeconds}`;
    if (scaleKey === this.lastScaleKey && !dataChanged) return;
    this.lastScaleKey = scaleKey;
    this.plot.setScale("x", {
      min: latest - this.context.store.windowSeconds,
      max: latest,
    });
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener(
      APPEARANCE_CHANGED_EVENT,
      this.redrawForAppearance,
    );
    this.plot.destroy();
  }

  private data(): uPlot.AlignedData {
    return this.context.store.alignedData(
      this.definition.metrics,
    ) as uPlot.AlignedData;
  }

  private updateLegend(): void {
    for (const metric of this.definition.metrics) {
      const item = this.legendItems.get(metric);
      if (!item) continue;
      const configured = this.definition.series?.[metric];
      const metadata = this.context.store.metadata.get(metric);
      item.textContent = configured?.label ?? metadata?.label ?? metric;
      item.style.setProperty("--series-color", this.seriesColor(metric));
    }
  }

  private seriesColor(metric: string): string {
    return (
      this.definition.series?.[metric]?.color ??
      this.context.store.metadata.get(metric)?.color ??
      "#7dd3fc"
    );
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
          stroke: () => this.axisColor,
          grid: {
            stroke: () => this.gridColor,
            width: 1,
          },
          ticks: {
            stroke: () => this.gridColor,
          },
          font: "11px ui-monospace, monospace",
        },
        {
          stroke: () => this.axisColor,
          grid: {
            stroke: () => this.gridColor,
            width: 1,
          },
          ticks: {
            stroke: () => this.gridColor,
          },
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
            stroke: () => this.seriesColor(metric),
            width: this.definition.lineWidth ?? 1.5,
            spanGaps: true,
            points: { show: false },
          };
          if (this.definition.style === "area") {
            series.fill = () => `${this.seriesColor(metric)}24`;
          }
          return series;
        }),
      ],
    };
  }
}

function themeColor(variable: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(variable)
      .trim() || fallback
  );
}
