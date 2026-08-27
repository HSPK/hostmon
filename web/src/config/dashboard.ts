import type { DashboardDefinition } from "../domain/types";

export const DASHBOARD: DashboardDefinition = {
  title: "hostmon operations",
  defaultWindowSeconds: 3600,
  panels: [
    {
      id: "overview",
      type: "stats",
      title: "Current resource state",
      columnSpan: 2,
      metrics: [
        { metric: "cpu/percent", label: "CPU", unit: "%", decimals: 1 },
        { metric: "memory/percent", label: "Memory", unit: "%", decimals: 1 },
        { metric: "disk/percent", label: "Disk", unit: "%", decimals: 1 },
        { metric: "gpu/percent", label: "GPU", unit: "%", decimals: 1 },
        {
          metric: "gpu/memory_percent",
          label: "GPU memory",
          unit: "%",
          decimals: 1,
        },
        {
          metric: "gpu/temperature_c",
          label: "GPU temperature",
          unit: "C",
          decimals: 0,
        },
        {
          metric: "network/rx_mbps",
          label: "Network RX",
          unit: "Mbps",
          decimals: 2,
        },
        {
          metric: "network/tx_mbps",
          label: "Network TX",
          unit: "Mbps",
          decimals: 2,
        },
      ],
    },
    {
      id: "host-utilization",
      type: "timeseries",
      title: "Host utilization",
      metrics: ["cpu/percent", "memory/percent", "disk/percent"],
      range: [0, 100],
    },
    {
      id: "network",
      type: "timeseries",
      title: "Network throughput",
      metrics: ["network/rx_mbps", "network/tx_mbps"],
    },
    {
      id: "gpu",
      type: "timeseries",
      title: "GPU",
      metrics: [
        "gpu/percent",
        "gpu/memory_percent",
        "gpu/temperature_c",
      ],
      range: [0, 100],
    },
    {
      id: "kubernetes",
      type: "timeseries",
      title: "Kubernetes GPU nodes",
      metrics: ["k8s/occupied_gpu_nodes", "k8s/quota_nodes"],
    },
    {
      id: "collectors",
      type: "collectors",
      title: "Collector health",
      columnSpan: 2,
    },
    {
      id: "tasks",
      type: "tasks",
      title: "Kubernetes task state",
      columnSpan: 2,
    },
  ],
};
