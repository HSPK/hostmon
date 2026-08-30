import type {
  CollectorPanelDefinition,
  MetricsPanelDefinition,
  GPUFleetPanelDefinition,
  GPUSubmittersPanelDefinition,
  StatPanelDefinition,
  TasksPanelDefinition,
  TimeSeriesPanelDefinition,
  SystemPanelDefinition,
  RulesPanelDefinition,
  SectionsPanelDefinition,
  WebSettingsPanelDefinition,
} from "../domain/types";
import { CollectorPanel } from "./collector-panel";
import { PanelRegistry } from "./panel";
import { MetricExplorerPanel } from "./metric-explorer-panel";
import { GPUFleetPanel } from "./gpu-fleet-panel";
import { GPUSubmittersPanel } from "./gpu-submitters-panel";
import { StatPanel } from "./stat-panel";
import { TasksPanel } from "./tasks-panel";
import { TimeSeriesPanel } from "./timeseries-panel";
import { SystemPanel } from "./system-panel";
import { RulesPanel } from "./rules-panel";
import { WebSettingsPanel } from "./web-settings-panel";
import { SectionsPanel } from "./sections-panel";

export function createPanelRegistry(): PanelRegistry {
  const registry = new PanelRegistry()
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
    )
    .register(
      "rules",
      (definition, context) =>
        new RulesPanel(definition as RulesPanelDefinition, context),
    )
    .register(
      "web-settings",
      (definition, context) =>
        new WebSettingsPanel(
          definition as WebSettingsPanelDefinition,
          context,
        ),
    )
    .register(
      "sections",
      (definition, context) =>
        new SectionsPanel(definition as SectionsPanelDefinition, context),
    );
  if (__HOSTMON_PLUGIN_UI__) {
    registry
      .register(
        "plugin-summary",
        (definition, context) =>
          new GPUFleetPanel(definition as GPUFleetPanelDefinition, context),
      )
      .register(
        "plugin-records",
        (definition, context) =>
          new GPUSubmittersPanel(
            definition as GPUSubmittersPanelDefinition,
            context,
          ),
      );
  }
  return registry;
}
