import { expect, test } from "@playwright/test";
import dashboardDefinition from "../src/config/dashboard.json" with {
  type: "json",
};

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
      gpu_allocation: "56 / 64",
      utilization_percent: 87.5,
      cpu_allocation: "700 / 880",
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
    gpu_allocation: "56 / 64",
    utilization_percent: 87.5,
    cpu_allocation: "700 / 880",
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
  let alertRules = [
    {
      alert: "high-cpu",
      expr: "cpu.percent >= 90",
      level: "warning",
      title: "High CPU",
      message: "CPU is high",
      enabled: true,
      for: 3,
      mode: "level",
      cooldown: 300,
    },
  ];
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
  await page.route("**/api/rules*", async route => {
    const request = route.request();
    const name = new URL(request.url()).pathname.split("/").at(-1);
    if (request.method() === "POST") {
      alertRules.push(request.postDataJSON());
      await route.fulfill({status: 201, json: alertRules.at(-1)});
      return;
    }
    if (request.method() === "PUT") {
      const replacement = request.postDataJSON();
      alertRules = alertRules.map(rule =>
        rule.alert === name ? replacement : rule,
      );
      await route.fulfill({json: replacement});
      return;
    }
    if (request.method() === "DELETE") {
      alertRules = alertRules.filter(rule => rule.alert !== name);
      await route.fulfill({status: 204});
      return;
    }
    await route.fulfill({json: {rules: alertRules}});
  });
  await page.route("**/api/collectors", route =>
    route.fulfill({
      json: {
        collectors: [
          {
            name: "cpu",
            enabled: true,
            required: true,
            refresh_seconds: 10,
            deadline_seconds: 2,
            max_stale_seconds: 0,
            last_success_at: now,
            last_failure_at: null,
            last_error: null,
            state: "up",
            duration: 1,
            failures: 0,
            options: {},
          },
        ],
      },
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
  await expect(page.locator(".statusbar")).toContainText("API ");
  await expect(page.locator(".statusbar")).toContainText("UTC+8");
  await expect(page.locator(".sidebar nav h3")).toHaveText([
    "Charts",
    "Tables",
    "Manage",
  ]);

  await page.getByRole("button", { name: "Collectors" }).click();
  await expect(page.locator("#page-title")).toHaveText("Collectors");
  await expect(page.locator(".health-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".health-table")).toContainText("10.0 s");
  await expect(page.locator(".health-table thead")).toContainText(
    "Last data refresh (UTC+8)",
  );
  await expect(page.locator(".health-table thead")).toContainText(
    "Last failure (UTC+8)",
  );
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.locator(".collector-dialog")).toContainText(
    "deadline_seconds",
  );
  await expect(page.locator(".collector-dialog")).toContainText(
    "last_refresh_duration_ms",
  );
  await page.locator(".collector-dialog").getByRole("button", {
    name: "Close",
  }).click();

  await page.getByRole("button", { name: "GPU Fleet" }).click();
  await expect(page.locator(".fleet-table")).toContainText("56 / 64");
  await expect(page.locator(".panel-section-title")).toHaveText([
    "Tables",
    "Charts",
  ]);
  const chartBoxes = await page
    .locator('.panel-section[data-section="Charts"] .panel')
    .evaluateAll(elements =>
      elements.map(element => {
        const box = element.getBoundingClientRect();
        return {x: box.x, y: box.y};
      }),
    );
  expect(chartBoxes[0]?.y).toBe(chartBoxes[1]?.y);
  expect(chartBoxes[0]?.x).not.toBe(chartBoxes[1]?.x);

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
  await expect(page.locator(".workload-detail-grid")).toContainText("State");
  await expect(page.locator(".workload-detail-grid > div")).toHaveCount(9);
  await page
    .locator(".workload-drawer")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.locator(".workload-drawer")).toHaveAttribute(
    "aria-hidden",
    "true",
  );

  await page.getByRole("button", { name: "Kubernetes" }).click();
  await expect(page.locator("#page-title")).toHaveText("Kubernetes");
  await expect(page.locator(".task-grid")).toContainText("7 / 7");

  await page.getByRole("button", { name: "System" }).click();
  await expect(page.locator(".system-grid")).toContainText("/api/ws");
  await expect(page.locator(".system-grid")).toContainText("/healthz");
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
  await expect(page.locator("#chart-metric-selected")).toContainText(
    "custom/latency_ms",
  );
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
  await expect(page.locator(".table-controls select")).toHaveCount(2);
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
  await page.getByRole("button", { name: "Pending GPUs" }).click();
  await page.getByRole("button", { name: "Pending GPUs" }).click();
  await expect(
    page.getByRole("columnheader", { name: "Pending GPUs" }),
  ).toHaveAttribute("aria-sort", "descending");
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
  await page.reload();
  await expect(page.getByLabel("Workload state")).toHaveValue("attention");
  await expect(
    page.getByRole("columnheader", { name: "Pending GPUs" }),
  ).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator(".table-count")).toContainText("2 workloads");
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
  const viewport = await page.locator("body").evaluate(element => ({
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(viewport.scroll).toBe(viewport.client);
  const internalTableScrolls = await page
    .locator(".gpu-submitters-panel .table-scroll")
    .evaluate(element => element.scrollHeight > element.clientHeight);
  expect(internalTableScrolls).toBe(true);
  await expect(
    page.locator(".gpu-submitters-panel .data-grid-toolbar").getByRole(
      "button",
      {name: "Previous"},
    ),
  ).toHaveCount(0);
  await expect(
    page.locator(".gpu-submitters-panel .data-grid-footer").getByRole(
      "button",
      {name: "Previous"},
    ),
  ).toHaveCount(1);
  const viewportElement = page.locator(
    ".gpu-submitters-panel .data-grid-viewport",
  );
  await viewportElement.evaluate(element => {
    element.scrollLeft = 480;
  });
  const pinned = await page
    .locator('.submitter-table th[data-column="name"]')
    .boundingBox();
  expect(pinned?.x).toBeLessThan(12);

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

test("requests bounded adaptive history for long windows", async ({ page }) => {
  const historyRequests: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/history") historyRequests.push(url);
  });
  await page.goto("/");
  await page.locator("#window-select").selectOption("2592000");
  await expect.poll(() => historyRequests.at(-1)?.searchParams.get("seconds"))
    .toBe("2592000");
  const maximum = Number(
    historyRequests.at(-1)?.searchParams.get("max_points"),
  );
  expect(maximum).toBeGreaterThanOrEqual(300);
  expect(maximum).toBeLessThanOrEqual(2400);
});

test("drags panels and edits built-in chart configuration", async ({ page }) => {
  await page.goto("/?page=overview");
  const network = page.locator('[data-panel-id="network"]');
  const utilization = page.locator('[data-panel-id="host-utilization"]');
  await network.locator(".panel-header").dragTo(utilization);
  await expect
    .poll(async () =>
      page.locator(".panel").evaluateAll(elements =>
        elements.map(element => (element as HTMLElement).dataset.panelId),
      ),
    )
    .toEqual([
      "overview",
      "network",
      "host-utilization",
      "gpu",
      "pressure",
    ]);

  await utilization.getByRole("button", { name: "Edit" }).click();
  await page.locator("#chart-title").fill("Custom host utilization");
  await page.locator("#chart-line-width").fill("2.5");
  await page.locator("#chart-height").selectOption("360");
  await page.getByRole("button", { name: "Save chart" }).click();
  await expect(
    page.locator('[data-panel-id="host-utilization"]'),
  ).toContainText("Custom host utilization");
  await expect(
    page.locator('[data-panel-id="host-utilization"] .panel-body'),
  ).toHaveAttribute("style", /360px/);
  await page.getByRole("button", { name: "System" }).click();
  await page.getByLabel("Find chart").fill("host utilization");
  await page.getByLabel("Find chart").press("Enter");
  await expect(page.locator("#page-title")).toHaveText("Overview");
  await expect(
    page.locator('[data-panel-id="host-utilization"]'),
  ).toHaveClass(/panel-highlight/);
});

test("creates and toggles alert rules from settings", async ({ page }) => {
  await page.goto("/?page=alerts");
  await expect(page.locator(".rules-table")).toContainText("high-cpu");
  await page.getByRole("button", { name: "Add rule" }).click();
  await page.locator('[name="alert"]').fill("gpu-hot");
  await page.locator('[name="expr"]').fill("gpu.temperature_c >= 85");
  await page.locator('[name="title"]').fill("GPU hot");
  await page.locator('[name="message"]').fill("GPU temperature exceeded");
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.locator(".rules-table")).toContainText("gpu-hot");
  await page.getByLabel("Enable gpu-hot").uncheck();
  await expect(page.getByLabel("Enable gpu-hot")).not.toBeChecked();
});

test("configures web theme and density", async ({ page }) => {
  await page.goto("/?page=settings");
  await page.locator(".web-settings-grid label").filter({
    hasText: "Theme",
  }).locator("select").selectOption("light");
  await page.locator(".web-settings-grid label").filter({
    hasText: "Density",
  }).locator("select").selectOption("comfortable");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-density",
    "comfortable",
  );
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("configures visible workload table columns", async ({ page }) => {
  await page.goto("/?page=settings");
  await page.getByRole("button", { name: "Configure panels" }).click();
  const setting = page.locator(".panel-setting").filter({
    hasText: "GPU workloads",
  });

  await setting.locator("summary").click();
  await setting.getByText("Pending GPUs").locator("input").uncheck();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Workloads" }).click();

  await expect(
    page.locator(".submitter-table thead"),
  ).not.toContainText("Pending GPUs");
  await page.reload();
  await expect(
    page.locator(".submitter-table thead"),
  ).not.toContainText("Pending GPUs");
});

test("loads navigation and panels from runtime configuration", async ({
  page,
}) => {
  const dashboard = structuredClone(dashboardDefinition);
  dashboard.navigation.push({
    id: "custom-runtime",
    label: "Runtime view",
    group: "Charts",
  });
  dashboard.panels.push({
    id: "runtime-chart",
    type: "timeseries",
    page: "custom-runtime",
    title: "Runtime configured chart",
    metrics: ["cpu/percent"],
  });
  await page.route("**/dashboard.json", route =>
    route.fulfill({json: dashboard}),
  );

  await page.goto("/?page=custom-runtime");

  await expect(page.locator("#page-title")).toHaveText("Runtime view");
  await expect(page.locator('[data-panel-id="runtime-chart"]')).toContainText(
    "Runtime configured chart",
  );
});
