import type {
  CollectorPanelDefinition,
  MetricsPanelDefinition,
  StatPanelDefinition,
  TasksPanelDefinition,
  TimeSeriesPanelDefinition,
  SystemPanelDefinition,
} from "../domain/types";
import { CollectorPanel } from "./collector-panel";
import { PanelRegistry } from "./panel";
import { MetricExplorerPanel } from "./metric-explorer-panel";
import { StatPanel } from "./stat-panel";
import { TasksPanel } from "./tasks-panel";
import { TimeSeriesPanel } from "./timeseries-panel";
import { SystemPanel } from "./system-panel";

export function createPanelRegistry(): PanelRegistry {
  return new PanelRegistry()
    .register(
      "stats",
      (definition, context) =>
        new StatPanel(definition as StatPanelDefinition, context),
    )
    .register(
      "timeseries",
      (definition, context) =>
        new TimeSeriesPanel(definition as TimeSeriesPanelDefinition, context),
    )
    .register(
      "collectors",
      (definition, context) =>
        new CollectorPanel(definition as CollectorPanelDefinition, context),
    )
    .register(
      "tasks",
      (definition, context) =>
        new TasksPanel(definition as TasksPanelDefinition, context),
    )
    .register(
      "metrics",
      (definition, context) =>
        new MetricExplorerPanel(definition as MetricsPanelDefinition, context),
    )
    .register(
      "system",
      (definition, context) =>
        new SystemPanel(definition as SystemPanelDefinition, context),
    );
}
