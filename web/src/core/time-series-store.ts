import type {
  HistoryResponse,
  MetricMetadata,
  MetricSnapshot,
  StatusResponse,
} from "../domain/types";

export type StoreListener = () => void;

export class TimeSeriesStore {
  readonly timestamps: number[] = [];
  readonly series = new Map<string, Array<number | null>>();
  readonly metadata = new Map<string, MetricMetadata>();
  latestMetrics: Record<string, number> = {};
  latestFields: Record<string, string | number | boolean | null> = {};
  host = "";
  version = "";
  latestTimestamp = 0;
  windowSeconds = 3600;
  private readonly listeners = new Set<StoreListener>();
  private readonly trackedMetrics: Set<string>;
  private seriesRevision = 0;

  constructor(
    private readonly maximumHistorySeconds = 30 * 24 * 60 * 60,
    trackedMetrics: string[] = [],
    private readonly maximumPoints = 2400,
  ) {
    this.trackedMetrics = new Set(trackedMetrics);
    for (const metric of this.trackedMetrics) this.series.set(metric, []);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  track(metrics: string[]): void {
    for (const metric of metrics) {
      if (this.trackedMetrics.has(metric)) continue;
      this.trackedMetrics.add(metric);
      this.series.set(
        metric,
        Array(this.timestamps.length).fill(null) as Array<number | null>,
      );
    }
  }

  tracked(): string[] {
    return [...this.trackedMetrics];
  }

  replaceHistory(history: HistoryResponse): void {
    this.timestamps.splice(0, this.timestamps.length, ...history.timestamps);
    this.series.clear();
    for (const [name, values] of Object.entries(history.series)) {
      this.series.set(name, [...values]);
    }
    this.metadata.clear();
    for (const [name, metadata] of Object.entries(history.metadata)) {
      this.metadata.set(name, metadata);
    }
    this.seriesRevision++;
    this.notify();
  }

  applyStatus(status: StatusResponse): void {
    this.host = status.host;
    this.version = status.version;
    this.latestTimestamp = status.updated_at;
    this.latestMetrics = status.metrics;
    this.latestFields = status.fields;
    this.notify();
  }

  append(snapshot: MetricSnapshot): void {
    if (snapshot.timestamp <= this.latestTimestamp) return;
    this.latestTimestamp = snapshot.timestamp;
    this.host = snapshot.host;
    this.latestMetrics = snapshot.metrics;
    this.latestFields = snapshot.fields;
    this.timestamps.push(snapshot.timestamp);
    const names = this.trackedMetrics.size
      ? this.trackedMetrics
      : new Set([...this.series.keys(), ...Object.keys(snapshot.metrics)]);
    for (const name of names) {
      let values = this.series.get(name);
      if (!values) {
        values = Array(this.timestamps.length - 1).fill(null) as Array<number | null>;
        this.series.set(name, values);
      }
      const value = snapshot.metrics[name];
      values.push(
        typeof value === "number" && Number.isFinite(value) ? value : null,
      );
    }
    this.trim(snapshot.timestamp - this.maximumHistorySeconds);
    this.seriesRevision++;
    this.notify();
  }

  setWindow(seconds: number): void {
    this.windowSeconds = seconds;
    this.notify();
  }

  alignedData(metrics: string[]): Array<Array<number | null>> {
    return [
      this.timestamps,
      ...metrics.map(
        name =>
          this.series.get(name) ??
          (Array(this.timestamps.length).fill(null) as Array<number | null>),
      ),
    ];
  }

  revision(): number {
    return this.seriesRevision;
  }

  exportCsv(metrics: string[]): string {
    const header = ["timestamp", ...metrics].join(",");
    const rows = this.timestamps.map((timestamp, index) => {
      const values = metrics.map(name => this.series.get(name)?.[index] ?? "");
      return [new Date(timestamp * 1000).toISOString(), ...values].join(",");
    });
    return [header, ...rows].join("\n");
  }

  private trim(cutoff: number): void {
    let remove = 0;
    while (remove < this.timestamps.length && this.timestamps[remove]! < cutoff) {
      remove++;
    }
    if (remove) {
      this.timestamps.splice(0, remove);
      for (const values of this.series.values()) values.splice(0, remove);
    }
    const excess = this.timestamps.length - this.maximumPoints;
    if (excess <= 0) return;
    this.timestamps.splice(0, excess);
    for (const values of this.series.values()) values.splice(0, excess);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
