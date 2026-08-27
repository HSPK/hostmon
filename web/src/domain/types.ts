export type MetricName = string;

export interface MetricSnapshot {
  timestamp: number;
  host: string;
  metrics: Record<MetricName, number>;
  fields: Record<string, string | number | boolean | null>;
}

export interface StatusResponse {
  host: string;
  updated_at: number;
  metrics: Record<MetricName, number>;
  fields: Record<string, string | number | boolean | null>;
  websocket_clients: number;
}

export interface HistoryResponse {
  from: number | null;
  to: number | null;
  timestamps: number[];
  series: Record<MetricName, Array<number | null>>;
  metadata: Record<MetricName, MetricMetadata>;
}

export interface MetricMetadata {
  label: string;
  unit: string;
  color: string;
}

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "paused"
  | "offline";

export interface StatMetric {
  metric: MetricName;
  label: string;
  unit: string;
  decimals?: number;
}

export interface BasePanelDefinition {
  id: string;
  title: string;
  type: string;
  columnSpan?: 1 | 2;
}

export interface StatPanelDefinition extends BasePanelDefinition {
  type: "stats";
  metrics: StatMetric[];
}

export interface TimeSeriesPanelDefinition extends BasePanelDefinition {
  type: "timeseries";
  metrics: MetricName[];
  range?: [number, number];
}

export interface CollectorPanelDefinition extends BasePanelDefinition {
  type: "collectors";
}

export interface TasksPanelDefinition extends BasePanelDefinition {
  type: "tasks";
}

export type PanelDefinition =
  | StatPanelDefinition
  | TimeSeriesPanelDefinition
  | CollectorPanelDefinition
  | TasksPanelDefinition;

export interface DashboardDefinition {
  title: string;
  defaultWindowSeconds: number;
  panels: PanelDefinition[];
}

export interface DashboardPreferences {
  hiddenPanels: string[];
  panelOrder: string[];
  windowSeconds: number;
}
