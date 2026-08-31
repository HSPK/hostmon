export type MetricName = string;

export interface MetricSnapshot {
  timestamp: number;
  host: string;
  metrics: Record<MetricName, number>;
  fields: Record<string, string | number | boolean | null>;
}

export interface SummaryFieldDefinition {
  label: string;
  path: string;
  format?: TableColumnDefinition["format"];
  unit?: string;
  fallback?: string;
}

export interface StatusResponse {
  host: string;
  version: string;
  updated_at: number;
  metrics: Record<MetricName, number>;
  fields: Record<string, string | number | boolean | null>;
  websocket_clients: number;
  websocket_inactivity_timeout_seconds: number;
}

export interface HistoryResponse {
  from: number | null;
  to: number | null;
  timestamps: number[];
  series: Record<MetricName, Array<number | null>>;
  metadata: Record<MetricName, MetricMetadata>;
  resolution_seconds?: number;
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

export type WorkloadStateFilter =
  | "all"
  | "attention"
  | "Running"
  | "Pending"
  | "Mixed";

export type WorkloadSort = string;

export interface WorkloadView {
  query: string;
  queue: string;
  state: WorkloadStateFilter;
  sort: WorkloadSort;
  sortDirection: "asc" | "desc";
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
  gpu_allocation: string;
  utilization_percent: number;
  cpu_allocation: string;
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
  schema_version: number | null;
  refresh_seconds: number;
  refresh_after_seconds: number;
  document: T;
}

export interface AlertRuleConfig {
  alert: string;
  expr: string;
  level: string;
  title: string;
  message: string;
  enabled: boolean;
  [key: string]: unknown;
}

export interface CollectorDiagnostic {
  name: string;
  enabled: boolean;
  required: boolean;
  refresh_seconds: number;
  deadline_seconds: number;
  max_stale_seconds: number;
  last_success_at: number | null;
  last_failure_at: number | null;
  last_error: string | null;
  state: "up" | "stale" | "down";
  duration: number | null;
  failures: number;
  options: Record<string, unknown>;
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
  section?: string;
  columns?: TableColumnDefinition[];
  columnSpan?: 1 | 2;
  custom?: boolean;
}

export interface TableColumnDefinition {
  id: string;
  label: string;
  path?: string;
  width?: string;
  mobileWidth?: string;
  align?: "left" | "center" | "right";
  pinned?: boolean | "left" | "right";
  sort?: string;
  format?: "text" | "number" | "state" | "metric" | "timestamp" | "duration";
  unit?: string;
  fallback?: string;
  action?: string;
}

export interface DisplayValueSource {
  source: "metric" | "field" | "system" | "static" | "metricMatch";
  format?: "timestamp";
  key?: string;
  value?: string | number;
  prefix?: string;
  suffix?: string;
  equals?: number;
  fallback?: string;
}

export interface DisplayItemDefinition {
  label: string;
  template: string;
  values: Record<string, DisplayValueSource>;
}

export interface StatPanelDefinition extends BasePanelDefinition {
  type: "stats";
  metrics: StatMetric[];
}

export interface TimeSeriesPanelDefinition extends BasePanelDefinition {
  type: "timeseries";
  metrics: MetricName[];
  series?: Record<string, Partial<MetricMetadata>>;
  range?: [number, number];
  style?: "line" | "area";
  lineWidth?: number;
  height?: number;
}

export interface CollectorPanelDefinition extends BasePanelDefinition {
  type: "collectors";
}

export interface TasksPanelDefinition extends BasePanelDefinition {
  type: "tasks";
  items: DisplayItemDefinition[];
}

export interface MetricsPanelDefinition extends BasePanelDefinition {
  type: "metrics";
}

export interface SystemPanelDefinition extends BasePanelDefinition {
  type: "system";
  items: DisplayItemDefinition[];
  metricFilter?: {prefix?: string; suffix?: string};
}

export interface GPUFleetPanelDefinition extends BasePanelDefinition {
  type: "plugin-summary";
  plugin: string;
  summary: SummaryFieldDefinition[];
}

export interface GPUSubmittersPanelDefinition extends BasePanelDefinition {
  type: "plugin-records";
  plugin: string;
  defaultSort?: string;
  defaultSortDirection?: "asc" | "desc";
}

export interface RulesPanelDefinition extends BasePanelDefinition {
  type: "rules";
}

export interface WebSettingsPanelDefinition extends BasePanelDefinition {
  type: "web-settings";
}

export interface SectionsPanelDefinition extends BasePanelDefinition {
  type: "sections";
}

export type PanelDefinition =
  | StatPanelDefinition
  | TimeSeriesPanelDefinition
  | CollectorPanelDefinition
  | TasksPanelDefinition
  | MetricsPanelDefinition
  | SystemPanelDefinition
  | GPUFleetPanelDefinition
  | GPUSubmittersPanelDefinition
  | RulesPanelDefinition
  | WebSettingsPanelDefinition
  | SectionsPanelDefinition;

export type PageId = string;

export interface NavigationItem {
  id: PageId;
  label: string;
  group?: string;
  placement?: "main" | "bottom";
}

export interface NavigationSection {
  id: string;
  label: string;
  placement: "main" | "bottom";
  pages: PageId[];
}

export interface CustomPageDefinition {
  id: PageId;
  label: string;
}

export interface ChartDefaults {
  style: "line" | "area";
  columnSpan: 1 | 2;
  height: number;
  lineWidth: number;
}

export interface DashboardDefinition {
  title: string;
  defaultWindowSeconds: number;
  navigation: NavigationItem[];
  panels: PanelDefinition[];
}

export interface DashboardPreferences {
  hiddenPanels: string[];
  panelOrder: string[];
  windowSeconds: number;
  activePage: PageId;
  panelState: Record<string, Record<string, string | number | boolean | null>>;
  panelColumns: Record<string, string[]>;
  theme: "dark" | "light" | "system";
  density: "compact" | "comfortable";
  customPanels: TimeSeriesPanelDefinition[];
  navigationSections: NavigationSection[];
  hiddenPages: PageId[];
  pageLabels: Record<PageId, string>;
  customPages: CustomPageDefinition[];
  chartDefaults: ChartDefaults;
}
