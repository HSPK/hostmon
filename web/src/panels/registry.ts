import type {
  CollectorPanelDefinition,
  StatPanelDefinition,
  TasksPanelDefinition,
  TimeSeriesPanelDefinition,
} from "../domain/types";
import { CollectorPanel } from "./collector-panel";
import { PanelRegistry } from "./panel";
import { StatPanel } from "./stat-panel";
import { TasksPanel } from "./tasks-panel";
import { TimeSeriesPanel } from "./timeseries-panel";

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
    );
}
