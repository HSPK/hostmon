import type {
  HistoryResponse,
  AlertRuleConfig,
  PluginDocument,
  MetricCatalogResponse,
  StatusResponse,
} from "../domain/types";

export class ApiClient {
  constructor(
    private readonly onTiming?: (url: string, milliseconds: number) => void,
  ) {}

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

  async rules(): Promise<AlertRuleConfig[]> {
    const response = await this.getJson<{rules: AlertRuleConfig[]}>(
      "/api/rules",
    );
    return response.rules;
  }

  async createRule(rule: AlertRuleConfig): Promise<void> {
    await this.sendJson("/api/rules", "POST", rule);
  }

  async updateRule(name: string, rule: AlertRuleConfig): Promise<void> {
    await this.sendJson(
      `/api/rules/${encodeURIComponent(name)}`,
      "PUT",
      rule,
    );
  }

  async deleteRule(name: string): Promise<void> {
    await this.sendJson(
      `/api/rules/${encodeURIComponent(name)}`,
      "DELETE",
    );
  }

  private async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const started = performance.now();
    const options: RequestInit = {
      cache: "no-store",
      headers: { Accept: "application/json" },
    };
    if (signal) options.signal = signal;
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`${url} returned HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      this.onTiming?.(url, performance.now() - started);
    }
  }

  private async sendJson(
    url: string,
    method: "POST" | "PUT" | "DELETE",
    body?: unknown,
  ): Promise<void> {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method,
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `${url} returned HTTP ${response.status}`);
      }
    } finally {
      this.onTiming?.(url, performance.now() - started);
    }
  }
}
