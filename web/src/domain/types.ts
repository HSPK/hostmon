export type MetricName = string;

export interface MetricSnapshot {
  timestamp: number;
  host: string;
  metrics: Record<MetricName, number>;
  fields: Record<string, string | number | boolean | null>;
}

export interface StatusResponse {
  host: string;
  version: string;
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

export interface MetricCatalogEntry {
  name: MetricName;
  metadata: MetricMetadata;
  current: number;
  minimum: number;
  maximum: number;
  average: number;
  p95: number;
  samples: number;
}

export interface MetricCatalogResponse {
  seconds: number;
  metrics: MetricCatalogEntry[];
}

export interface ClusterGPUUsageRow {
  queue: string;
  submitter: string;
  creator_id: string;
  running_pods: number;
  running_gpus: number;
  running_gpu_nodes: number;
  pending_pods: number;
  pending_gpus: number;
}

export interface ClusterGPUWorkloadRow extends ClusterGPUUsageRow {
  name: string;
  status: "Running" | "Pending" | "Mixed";
  running_nodes: string[];
}

export interface WorkloadSelection {
  queue: string;
  name: string;
}

export interface ClusterGPUCapacityRow {
  queue: string;
  capacity_gpus: number;
  allocated_gpus: number;
  pending_gpus: number;
  unallocated_gpus: number;
  no_job_gpus: number;
  no_job_node_equivalents: number;
  capacity_cpus: number;
  allocated_cpus: number;
  free_cpus: number;
}

export interface ClusterGPUReport {
  gpus_per_node: number;
  usage: ClusterGPUUsageRow[];
  workloads: ClusterGPUWorkloadRow[];
  capacity: ClusterGPUCapacityRow[];
  total_capacity: ClusterGPUCapacityRow;
}

export interface PluginDocument<T> {
  name: string;
  updated_at: number;
  document: T;
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
  page: PageId;
  columnSpan?: 1 | 2;
  custom?: boolean;
}

export interface StatPanelDefinition extends BasePanelDefinition {
  type: "stats";
  metrics: StatMetric[];
}

export interface TimeSeriesPanelDefinition extends BasePanelDefinition {
  type: "timeseries";
  metrics: MetricName[];
  range?: [number, number];
  style?: "line" | "area";
  lineWidth?: number;
}

export interface CollectorPanelDefinition extends BasePanelDefinition {
  type: "collectors";
}

export interface TasksPanelDefinition extends BasePanelDefinition {
  type: "tasks";
}

export interface MetricsPanelDefinition extends BasePanelDefinition {
  type: "metrics";
}

export interface SystemPanelDefinition extends BasePanelDefinition {
  type: "system";
}

export interface GPUFleetPanelDefinition extends BasePanelDefinition {
  type: "gpu-fleet";
}

export interface GPUSubmittersPanelDefinition extends BasePanelDefinition {
  type: "gpu-submitters";
}

export type PanelDefinition =
  | StatPanelDefinition
  | TimeSeriesPanelDefinition
  | CollectorPanelDefinition
  | TasksPanelDefinition
  | MetricsPanelDefinition
  | SystemPanelDefinition
  | GPUFleetPanelDefinition
  | GPUSubmittersPanelDefinition;

export type PageId =
  | "overview"
  | "gpu-fleet"
  | "workloads"
  | "metrics"
  | "collectors"
  | "kubernetes"
  | "system";

export interface DashboardDefinition {
  title: string;
  defaultWindowSeconds: number;
  panels: PanelDefinition[];
}

export interface DashboardPreferences {
  hiddenPanels: string[];
  panelOrder: string[];
  windowSeconds: number;
  activePage: PageId;
  customPanels: TimeSeriesPanelDefinition[];
}
