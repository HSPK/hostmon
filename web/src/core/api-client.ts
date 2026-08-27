import type {
  HistoryResponse,
  PluginDocument,
  MetricCatalogResponse,
  StatusResponse,
} from "../domain/types";

export class ApiClient {
  async status(signal?: AbortSignal): Promise<StatusResponse> {
    return this.getJson<StatusResponse>("/api/status", signal);
  }

  async history(
    seconds: number,
    maximumPoints = 1800,
    signal?: AbortSignal,
    metrics?: string[],
  ): Promise<HistoryResponse> {
    const query = new URLSearchParams({
      seconds: String(seconds),
      max_points: String(maximumPoints),
    });
    if (metrics?.length) query.set("metrics", metrics.join(","));
    return this.getJson<HistoryResponse>(`/api/history?${query}`, signal);
  }

  async catalog(
    seconds: number,
    signal?: AbortSignal,
  ): Promise<MetricCatalogResponse> {
    const query = new URLSearchParams({seconds: String(seconds)});
    return this.getJson<MetricCatalogResponse>(`/api/catalog?${query}`, signal);
  }

  async plugin<T>(
    name: string,
    signal?: AbortSignal,
  ): Promise<PluginDocument<T>> {
    return this.getJson<PluginDocument<T>>(
      `/api/plugins/${encodeURIComponent(name)}`,
      signal,
    );
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const options: RequestInit = {
      cache: "no-store",
      headers: { Accept: "application/json" },
    };
    if (signal) options.signal = signal;
    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
