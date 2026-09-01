import type {
  ChartDefaults,
  MetricCatalogResponse,
  PanelDefinition,
  TimeSeriesPanelDefinition,
  AlertRuleConfig,
  DashboardPreferences,
  CollectorDiagnostic,
} from "../domain/types";
import type { TimeSeriesStore } from "../core/time-series-store";

export interface PanelContext {
  store: TimeSeriesStore;
  actions: {
    loadCatalog(): Promise<MetricCatalogResponse>;
    loadPlugin<T>(name: string): Promise<T>;
    panelState<T extends Record<string, string | number | boolean | null>>(
      panelId: string,
      fallback: T,
    ): T;
    setPanelState(
      panelId: string,
      state: Record<string, string | number | boolean | null>,
    ): void;
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
    windowSeconds(): number;
    setWindow(seconds: number): void;
    chartDefaults(): ChartDefaults;
    setChartDefaults(defaults: ChartDefaults): void;
    renderNavigationEditor(root: HTMLElement): void;
    createChart(metrics?: string[]): void;
    editChart(panel: TimeSeriesPanelDefinition): void;
    removeChart(panelId: string): void;
  };
}

export interface PanelRenderer {
  readonly element: HTMLElement;
  update(): void;
  refresh?(): void;
  destroy(): void;
}

export class PanelFeedback {
  readonly element: HTMLOutputElement;

  constructor() {
    this.element = document.createElement("output");
    this.element.className = "panel-feedback";
    this.element.setAttribute("role", "alert");
    this.element.setAttribute("aria-live", "polite");
    this.element.hidden = true;
  }

  clear(): void {
    this.element.hidden = true;
    this.element.textContent = "";
  }

  show(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.element.textContent = `${message}: ${detail}`;
    this.element.hidden = false;
  }
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
