import { expect, test } from "@playwright/test";

const now = Date.now() / 1000;
const metrics = {
  "cpu/percent": 42,
  "memory/percent": 51,
  "disk/percent": 37,
  "gpu/percent": 78,
  "gpu/memory_percent": 64,
  "gpu/temperature_c": 71,
  "network/rx_mbps": 12,
  "network/tx_mbps": 3,
  "k8s/occupied_gpu_nodes": 7,
  "k8s/quota_nodes": 7,
  "custom/latency_ms": 18,
  "monitor/collector/cpu/up": 1,
  "monitor/collector/cpu/stale": 0,
  "monitor/collector/cpu/failures_total": 0,
  "monitor/collector/cpu/duration_ms": 1,
  "monitor/outbox/pending": 0,
};

const fields = {
  k8s_stopped_tasks: "(none)",
  k8s_stopped_task_details: "(none)",
  k8s_failed_tasks: "(none)",
};

const clusterGPUReport = {
  gpus_per_node: 8,
  capacity: [
    {
      queue: "queue-a",
      capacity_gpus: 64,
      allocated_gpus: 56,
      pending_gpus: 8,
      unallocated_gpus: 8,
      no_job_gpus: 0,
      no_job_node_equivalents: 0,
      capacity_cpus: 880,
      allocated_cpus: 700,
      free_cpus: 180,
    },
  ],
  total_capacity: {
    queue: "TOTAL",
    capacity_gpus: 64,
    allocated_gpus: 56,
    pending_gpus: 8,
    unallocated_gpus: 8,
    no_job_gpus: 0,
    no_job_node_equivalents: 0,
    capacity_cpus: 880,
    allocated_cpus: 700,
    free_cpus: 180,
  },
  usage: [
    {
      queue: "queue-a",
      submitter: "training-run",
      creator_id: "user-a",
      running_pods: 7,
      running_gpus: 56,
      running_gpu_nodes: 7,
      pending_pods: 1,
      pending_gpus: 8,
    },
  ],
  workloads: [
    {
      queue: "queue-a",
      name: "training-job-001",
      status: "Mixed",
      submitter: "training-run",
      creator_id: "user-a",
      running_pods: 7,
      running_gpus: 56,
      running_gpu_nodes: 7,
      running_nodes: ["gpu-node-01", "gpu-node-02"],
      pending_pods: 1,
      pending_gpus: 8,
    },
    {
      queue: "queue-a",
      name: "queued-job-001",
      status: "Pending",
      submitter: "queued-run",
      creator_id: "user-c",
      running_pods: 0,
      running_gpus: 0,
      running_gpu_nodes: 0,
      running_nodes: [],
      pending_pods: 2,
      pending_gpus: 16,
    },
    ...Array.from({ length: 80 }, (_, index) => ({
      queue: "queue-a",
      name: `batch-job-${String(index).padStart(3, "0")}`,
      status: "Running" as const,
      submitter: "batch-run",
      creator_id: "user-b",
      running_pods: 1,
      running_gpus: 1,
      running_gpu_nodes: 1,
      running_nodes: [`gpu-node-${String(index + 3).padStart(2, "0")}`],
      pending_pods: 0,
      pending_gpus: 0,
    })),
  ],
};

test.beforeEach(async ({ page }) => {
  const timestamps = Array.from({ length: 60 }, (_, index) => now - 590 + index * 10);
  const metadata = Object.fromEntries(
    Object.keys(metrics).map(name => [
      name,
      { label: name, unit: name.endsWith("percent") ? "%" : "", color: "#4ea1d3" },
    ]),
  );
  await page.route("**/api/status", route =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        host: "test-host",
        version: "0.1.1.dev0",
        updated_at: now,
        metrics,
        fields,
        websocket_clients: 1,
      }),
    }),
  );
  await page.route("**/api/history?*", route => {
    const requested = new URL(route.request().url()).searchParams.get("metrics");
    const names = requested?.split(",") ?? Object.keys(metrics);
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        from: timestamps[0],
        to: timestamps.at(-1),
        timestamps,
        series: Object.fromEntries(
          names.map(name => [
            name,
            timestamps.map((_, index) => (metrics[name as keyof typeof metrics] ?? 0) + index / 100),
          ]),
        ),
        metadata: Object.fromEntries(names.map(name => [name, metadata[name]])),
      }),
    });
  });
  await page.route("**/api/catalog?*", route =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        seconds: 3600,
        metrics: Object.entries(metrics).map(([name, value]) => ({
          name,
          metadata: metadata[name],
          current: value,
          minimum: value - 1,
          maximum: value + 1,
          average: value,
          p95: value + 0.8,
          samples: 60,
        })),
      }),
    }),
  );
  await page.route("**/api/plugins/cluster_gpu_usage", route =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        name: "cluster_gpu_usage",
        updated_at: now,
        document: clusterGPUReport,
      }),
    }),
  );
  await page.routeWebSocket("**/api/ws", socket => {
    socket.send(
      JSON.stringify({
        timestamp: now + 10,
        host: "test-host",
        metrics: { ...metrics, "cpu/percent": 43 },
        fields,
      }),
    );
  });
});

test("navigates operations pages and renders live charts", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#page-title")).toHaveText("Overview");
  await expect(page.locator(".stat-card")).toHaveCount(8);
  await expect(page.locator(".uplot")).toHaveCount(4);
  await expect(page.locator("#connection-text")).toHaveText("connected");

  await page.getByRole("button", { name: "Collectors" }).click();
  await expect(page.locator("#page-title")).toHaveText("Collectors");
  await expect(page.locator(".health-table tbody tr")).toHaveCount(1);

  await page.getByRole("button", { name: "GPU Fleet" }).click();
  await expect(page.locator(".fleet-table")).toContainText("56 / 64");

  await page.getByRole("button", { name: "Workloads" }).click();
  await expect(page.locator(".submitter-table tbody tr")).toHaveCount(75);
  await expect(page.locator(".submitter-table")).toContainText("training-job-001");
  await page.getByRole("button", { name: "training-job-001" }).click();
  await expect(page).toHaveURL(
    /\?page=workloads&queue=queue-a&run=training-job-001$/,
  );
  await expect(page.locator(".workload-drawer")).toContainText("user-a");
  await expect(page.locator(".workload-drawer")).toContainText("56");
  await expect(page.locator(".workload-drawer")).toContainText("gpu-node-01");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".workload-drawer")).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  await page.getByRole("button", { name: "Kubernetes" }).click();
  await expect(page.locator("#page-title")).toHaveText("Kubernetes");
  await expect(page.locator(".task-grid")).toContainText("7 / 7");

  await page.getByRole("button", { name: "System" }).click();
  await expect(page.locator(".system-grid")).toContainText("/api/ws");
});

test("searches metrics and persists a custom chart", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Metrics" }).click();
  await expect(page.locator(".metric-table tbody tr")).toHaveCount(
    Object.keys(metrics).length,
  );

  await page.getByRole("button", { name: "Add chart" }).click();
  await page.locator("#chart-metric-filter").fill("custom/latency");
  await page.locator(".metric-option").filter({ hasText: "custom/latency_ms" }).click();
  await page.locator("#chart-title").fill("Request latency");
  await page.locator("#chart-style").selectOption("area");
  await page.getByRole("button", { name: "Save chart" }).click();

  await expect(page.locator('[data-panel-id^="custom-"]')).toContainText(
    "Request latency",
  );
  await page.reload();
  await expect(page.locator("#page-title")).toHaveText("Metrics");
  await expect(page.locator('[data-panel-id^="custom-"]')).toContainText(
    "Request latency",
  );
});

test("supports deep links and browser workspace history", async ({ page }) => {
  await page.goto("/?page=workloads");
  await expect(page.locator("#page-title")).toHaveText("Workloads");
  await expect(page.locator(".submitter-table tbody tr")).toHaveCount(75);

  await page.getByRole("button", { name: "GPU Fleet" }).click();
  await expect(page).toHaveURL(/\?page=gpu-fleet$/);
  await expect(page.locator("#page-title")).toHaveText("GPU Fleet");

  await page.goBack();
  await expect(page).toHaveURL(/\?page=workloads$/);
  await expect(page.locator("#page-title")).toHaveText("Workloads");

  await page.getByRole("button", { name: "training-job-001" }).click();
  await expect(page.locator(".workload-drawer")).toHaveAttribute(
    "aria-hidden",
    "false",
  );
  await page.goBack();
  await expect(page).toHaveURL(/\?page=workloads$/);
  await expect(page.locator(".workload-drawer")).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  await page.goto(
    "/?page=workloads&queue=queue-a&run=training-job-001",
  );
  await expect(page.locator(".workload-drawer")).toContainText(
    "training-job-001",
  );
});

test("filters and sorts workload triage views", async ({ page }) => {
  await page.goto("/?page=workloads");
  await page.getByLabel("Sort workloads").selectOption("pending-gpus");
  await expect(page.locator(".submitter-table tbody tr").first()).toContainText(
    "queued-job-001",
  );

  await page.getByLabel("Workload state").selectOption("attention");
  await expect(page.locator(".table-count")).toContainText("2 workloads");
  await expect(page.locator(".submitter-table")).toContainText(
    "training-job-001",
  );
  await expect(page.locator(".submitter-table")).toContainText(
    "queued-job-001",
  );

  await page.locator(".gpu-submitters-panel input[type=search]").fill(
    "missing-workload",
  );
  await expect(page.locator(".table-empty")).toHaveText(
    "No workloads match the current filters",
  );
});

test("remains responsive on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  await page.getByRole("button", { name: "Menu" }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/open/);
  await page.getByRole("button", { name: "Metrics" }).click();
  await expect(page.locator("#page-title")).toHaveText("Metrics");

  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Workloads" }).click();
  const tableScrollsInsidePanel = await page
    .locator(".gpu-submitters-panel .table-scroll")
    .evaluate(element => element.scrollWidth > element.clientWidth);
  expect(tableScrollsInsidePanel).toBe(true);
  const controlsFitPanel = await page
    .locator(".gpu-submitters-panel .table-controls")
    .evaluate(element => element.scrollWidth <= element.clientWidth);
  expect(controlsFitPanel).toBe(true);
  const bodyHasHorizontalOverflow = await page
    .locator("body")
    .evaluate(element => element.scrollWidth > element.clientWidth);
  expect(bodyHasHorizontalOverflow).toBe(false);

  await page.getByRole("button", { name: "training-job-001" }).click();
  const closeButton = page
    .locator(".workload-drawer")
    .getByRole("button", { name: "Close" });
  await expect(closeButton).toBeInViewport({ ratio: 1 });
  const closeBox = await closeButton.boundingBox();
  expect(closeBox).not.toBeNull();
  expect((closeBox?.x ?? 400) + (closeBox?.width ?? 0)).toBeLessThanOrEqual(390);
});

test("maintains smooth animation frame cadence", async ({ page }) => {
  await page.goto("/");
  const frameDurations = await page.evaluate(
    () =>
      new Promise<number[]>(resolve => {
        const durations: number[] = [];
        let previous = performance.now();
        const sample = (current: number) => {
          durations.push(current - previous);
          previous = current;
          if (durations.length >= 60) resolve(durations.slice(1));
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  frameDurations.sort((left, right) => left - right);
  const p95 = frameDurations[Math.floor(frameDurations.length * 0.95)] ?? 100;
  expect(p95).toBeLessThan(35);
});
