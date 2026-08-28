import type {
  MetricCatalogEntry,
  ClusterGPUReport,
  PanelDefinition,
  TimeSeriesPanelDefinition,
  WorkloadSelection,
  WorkloadView,
  AlertRuleConfig,
  DashboardPreferences,
  CollectorDiagnostic,
} from "../domain/types";
import type { TimeSeriesStore } from "../core/time-series-store";

export interface PanelContext {
  store: TimeSeriesStore;
  actions: {
    loadCatalog(): Promise<MetricCatalogEntry[]>;
    loadClusterGPU(): Promise<ClusterGPUReport>;
    selectedWorkload(): WorkloadSelection | null;
    selectWorkload(
      selection: WorkloadSelection | null,
      replace?: boolean,
    ): void;
    workloadView(): WorkloadView;
    setWorkloadView(view: WorkloadView): void;
    loadRules(): Promise<AlertRuleConfig[]>;
    createRule(rule: AlertRuleConfig): Promise<void>;
    updateRule(name: string, rule: AlertRuleConfig): Promise<void>;
    deleteRule(name: string): Promise<void>;
    loadCollectors(): Promise<CollectorDiagnostic[]>;
    appearance(): Pick<DashboardPreferences, "theme" | "density">;
    setAppearance(
      theme: DashboardPreferences["theme"],
      density: DashboardPreferences["density"],
    ): void;
    openPanelSettings(): void;
    createChart(metrics?: string[]): void;
    editChart(panel: TimeSeriesPanelDefinition): void;
    removeChart(panelId: string): void;
  };
}

export interface PanelRenderer {
  readonly element: HTMLElement;
  update(): void;
  destroy(): void;
}

export type PanelFactory<T extends PanelDefinition = PanelDefinition> = (
  definition: T,
  context: PanelContext,
) => PanelRenderer;

export class PanelRegistry {
  private readonly factories = new Map<string, PanelFactory>();

  register(type: string, factory: PanelFactory): this {
    if (this.factories.has(type)) {
      throw new Error(`Panel renderer already registered: ${type}`);
    }
    this.factories.set(type, factory);
    return this;
  }

  create(
    definition: PanelDefinition,
    context: PanelContext,
  ): PanelRenderer {
    const factory = this.factories.get(definition.type);
    if (!factory) throw new Error(`Unknown panel type: ${definition.type}`);
    return factory(definition, context);
  }
}

export function panelShell(
  definition: PanelDefinition,
  className = "",
): { element: HTMLElement; header: HTMLElement; body: HTMLElement } {
  const element = document.createElement("section");
  element.className = `panel ${className}`.trim();
  element.dataset.panelId = definition.id;
  if (definition.columnSpan === 2) element.classList.add("panel-wide");

  const header = document.createElement("header");
  header.className = "panel-header";
  const title = document.createElement("h2");
  title.textContent = definition.title;
  header.append(title);

  const body = document.createElement("div");
  body.className = "panel-body";
  element.append(header, body);
  return { element, header, body };
}
