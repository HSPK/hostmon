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
  let dashboardPreferences: Record<string, unknown> | null = null;
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
  await page.route("**/api/preferences", route => {
    if (route.request().method() === "PUT") {
      dashboardPreferences = route.request().postDataJSON();
      return route.fulfill({json: {preferences: dashboardPreferences}});
    }
    if (route.request().method() === "PATCH") {
      dashboardPreferences = {
        ...(dashboardPreferences ?? {}),
        ...route.request().postDataJSON(),
      };
      return route.fulfill({json: {preferences: dashboardPreferences}});
    }
    return route.fulfill({json: {preferences: dashboardPreferences}});
  });
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
  await expect(
    page.locator('[class*="drawer"], [id*="drawer"]'),
  ).toHaveCount(0);
  await expect(page.locator(".sidebar nav h3")).toHaveText([
    "Charts",
    "Tables",
    "Manage",
  ]);

  await page.getByRole("button", { name: "Collectors" }).click();
  await expect(page.locator("#page-title")).toHaveText("Collectors");
  await expect(page.locator(".health-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".health-table")).toContainText("10.0 s");
  await expect(page.locator(".collector-panel")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
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

  await page.getByRole("button", { name: "Alerts" }).click();
  const tableChrome = await page.locator(".rules-panel").evaluate(panel => {
    const header = panel.querySelector(".panel-header")!;
    const toolbar = panel.querySelector(".data-grid-toolbar")!;
    return {
      panelBackground: getComputedStyle(panel).backgroundColor,
      toolbarBackground: getComputedStyle(toolbar).backgroundColor,
      gap:
        toolbar.getBoundingClientRect().top -
        header.getBoundingClientRect().bottom,
    };
  });
  expect(tableChrome.panelBackground).toBe("rgba(0, 0, 0, 0)");
  expect(tableChrome.toolbarBackground).not.toBe(
    tableChrome.panelBackground,
  );
  expect(tableChrome.gap).toBeGreaterThanOrEqual(8);

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
  const footerBox = await page
    .locator(".gpu-submitters-panel .data-grid-footer")
    .boundingBox();
  const layoutNavBox = await page.locator(".layout-dock-nav").boundingBox();
  expect(footerBox).not.toBeNull();
  expect(layoutNavBox).not.toBeNull();
  expect(layoutNavBox!.y).toBeGreaterThanOrEqual(
    footerBox!.y + footerBox!.height,
  );
  await page.getByRole("button", { name: "training-job-001" }).click();
  await expect(page).toHaveURL(
    /\?page=workloads&queue=queue-a&run=training-job-001$/,
  );
  await expect(page.locator(".workload-dialog")).toContainText("user-a");
  await expect(page.locator(".workload-dialog")).toContainText("56");
  await expect(page.locator(".workload-dialog")).toContainText("gpu-node-01");
  await expect(page.locator(".workload-detail-grid")).toContainText("State");
  await expect(page.locator(".workload-detail-grid > div")).toHaveCount(9);
  await page
    .locator(".workload-dialog")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.locator(".workload-dialog")).not.toBeVisible();

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
  await expect(page.locator("#chart-page")).toHaveValue("overview");
  await page.locator("#chart-metric-filter").fill("custom/latency");
  await page.locator(".metric-option").filter({ hasText: "custom/latency_ms" }).click();
  await expect(page.locator("#chart-metric-selected")).toContainText(
    "custom/latency_ms",
  );
  await page.locator("#chart-title").fill("Request latency");
  await page.locator("#chart-style").selectOption("area");
  await page.getByRole("button", { name: "Save chart" }).click();

  await expect(page.locator("#page-title")).toHaveText("Overview");
  await expect(page.locator('[data-panel-id^="custom-"]')).toContainText(
    "Request latency",
  );
  await expect(
    page.locator(
      '.panel-section[data-section="Charts"] [data-panel-id^="custom-"]',
    ),
  ).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#page-title")).toHaveText("Overview");
  await expect(page.locator('[data-panel-id^="custom-"]')).toContainText(
    "Request latency",
  );
});

test("defaults new charts to the current chart page", async ({ page }) => {
  await page.goto("/?page=gpu-fleet");
  await page.getByRole("button", { name: "Add chart" }).click();

  await expect(page.locator("#chart-page")).toHaveValue("gpu-fleet");
  await page
    .locator("#chart-dialog")
    .getByRole("button", { name: "Close" })
    .click();
  await expect(page.locator("#chart-dialog")).not.toBeVisible();
});

test("configures persistent sidebar sections", async ({ page }) => {
  await page.goto("/?page=settings");
  const dock = page.locator(".layout-dock-nav");
  const dockBox = await dock.boundingBox();
  expect(dockBox).not.toBeNull();
  expect((dockBox?.x ?? 0) + (dockBox?.width ?? 0)).toBeLessThanOrEqual(1440);
  expect(dockBox?.y ?? 0).toBeGreaterThan(450);
  await page.locator("#layout-navigation-button").click();
  await expect(page.locator("#layout-navigation-button")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".navigation-page-count")).toHaveCount(0);
  await page.getByLabel("New section name").fill("Operations");
  await page.getByRole("button", { name: "Add section" }).click();

  const operations = page.locator(
    '.navigation-setting[data-navigation-section-id="custom-operations"]',
  );
  await expect(operations).toHaveCount(1);
  await operations.getByRole("button", { name: "Up" }).click();
  await page.getByLabel("Section for Metrics").selectOption({
    label: "Operations",
  });
  const sidebarSection = page.locator(".nav-section").filter({
    has: page.getByRole("heading", { name: "Operations" }),
  });
  await expect(
    sidebarSection.getByRole("button", { name: "Metrics" }),
  ).toHaveCount(1);

  await page.reload();
  await page.locator("#layout-navigation-button").click();
  await expect(page.getByLabel("Section for Metrics")).toHaveValue(
    "custom-operations",
  );
  page.once("dialog", dialog => dialog.accept());
  await page
    .locator(
      '.navigation-setting[data-navigation-section-id="custom-operations"]',
    )
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Operations" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Metrics" })).toHaveCount(1);
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
  await expect(page.locator(".workload-dialog")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\?page=workloads$/);
  await expect(page.locator(".workload-dialog")).not.toBeVisible();

  await page.goto(
    "/?page=workloads&queue=queue-a&run=training-job-001",
  );
  await expect(page.locator(".workload-dialog")).toContainText(
    "training-job-001",
  );
});

test("does not persist defaults before a user change", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => {
    if (
      request.method() === "PUT" &&
      new URL(request.url()).pathname === "/api/preferences"
    ) {
      writes.push(request.postData() ?? "");
    }
  });

  await page.goto("/?page=gpu-fleet");
  await expect(page.locator("#page-title")).toHaveText("GPU Fleet");
  await page.waitForTimeout(100);
  expect(writes).toEqual([]);
});

test("tracks metrics from server-restored custom charts", async ({ page }) => {
  await page.unroute("**/api/preferences");
  await page.route("**/api/preferences", route =>
    route.fulfill({
      json: {
        preferences: {
          hiddenPanels: [],
          panelOrder: [],
          windowSeconds: 3600,
          activePage: "overview",
          panelState: {},
          panelColumns: {},
          theme: "dark",
          density: "compact",
          customPanels: [
            {
              id: "custom-server-latency",
              type: "timeseries",
              page: "overview",
              title: "Server latency",
              metrics: ["custom/latency_ms"],
              custom: true,
            },
          ],
        },
      },
    }),
  );
  const historyRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/history" &&
      url.searchParams.get("metrics")?.includes("custom/latency_ms") === true
    );
  });

  await page.goto("/?page=overview");
  await historyRequest;

  await expect(
    page.locator('[data-panel-id="custom-server-latency"]'),
  ).toContainText("Server latency");
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

  await page.locator("#layout-navigation-button").click();
  const layoutBox = await page.locator("#layout-panel").boundingBox();
  expect(layoutBox).not.toBeNull();
  expect(layoutBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect(
    (layoutBox?.x ?? 400) + (layoutBox?.width ?? 0),
  ).toBeLessThanOrEqual(390);
  await page.locator("#layout-close").click();
  const mobileDock = await page.locator(".layout-dock-nav").boundingBox();
  const mobileStatus = await page.locator(".statusbar").boundingBox();
  expect(mobileDock).not.toBeNull();
  expect(mobileStatus).not.toBeNull();
  expect(Math.abs(mobileDock!.y - mobileStatus!.y)).toBeLessThanOrEqual(1);

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
    .locator(".workload-dialog")
    .getByRole("button", { name: "Close" });
  await expect(closeButton).toBeInViewport({ ratio: 1 });
  const closeBox = await closeButton.boundingBox();
  expect(closeBox).not.toBeNull();
  expect((closeBox?.x ?? 400) + (closeBox?.width ?? 0)).toBeLessThanOrEqual(390);
  await closeButton.click();
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Overview" }).click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByRole("button", { name: "Save chart" }))
    .toBeInViewport({ratio: 1});
  const editorBodyScrolls = await page
    .locator(".chart-dialog-body")
    .evaluate(element => element.scrollHeight > element.clientHeight);
  expect(editorBodyScrolls).toBe(true);
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
  const persisted = page.waitForRequest(request => {
    if (
      !["PUT", "PATCH"].includes(request.method()) ||
      new URL(request.url()).pathname !== "/api/preferences"
    ) {
      return false;
    }
    const preferences = request.postDataJSON() as {
      customPanels?: Array<{title?: string}>;
    };
    return preferences.customPanels?.some(
      panel => panel.title === "Custom host utilization",
    ) ?? false;
  });
  await page.getByRole("button", { name: "Save chart" }).click();
  await persisted;
  await expect(
    page.locator('[data-panel-id="host-utilization"]'),
  ).toContainText("Custom host utilization");
  await expect(
    page.locator('[data-panel-id="host-utilization"] .panel-body'),
  ).toHaveAttribute("style", /360px/);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(
    page.locator('[data-panel-id="host-utilization"]'),
  ).toContainText("Custom host utilization");
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

test("keeps the alert editor readable on narrow screens", async ({ page }) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/?page=alerts");
  await page.getByRole("button", {name: "Add rule"}).click();

  const editor = page.locator(".rule-editor");
  const title = editor.locator('[name="title"]');
  const save = editor.getByRole("button", {name: "Save rule"});
  const editorBox = await editor.boundingBox();
  const titleBox = await title.boundingBox();

  expect(editorBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(titleBox!.width).toBeGreaterThan(editorBox!.width * 0.9);
  await expect(save).toBeInViewport({ratio: 1});
  expect(
    await save.evaluate(element => element.scrollHeight <= element.clientHeight),
  ).toBe(true);
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
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--chart-grid")
          .trim(),
      ),
    )
    .toBe("#d6dde5");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("merges unrelated preference changes from stale clients", async ({
  page,
}) => {
  await page.unroute("**/api/preferences");
  let serverPreferences = {
    hiddenPanels: [] as string[],
    panelOrder: [] as string[],
    windowSeconds: 3600,
    activePage: "settings",
    panelState: {},
    panelColumns: {},
    theme: "dark",
    density: "compact",
    customPanels: [] as unknown[],
  };
  await page.context().route("**/api/preferences", route => {
    if (route.request().method() === "PATCH") {
      serverPreferences = {
        ...serverPreferences,
        ...route.request().postDataJSON(),
      };
    }
    return route.fulfill({json: {preferences: serverPreferences}});
  });
  await page.goto("/?page=settings");
  serverPreferences = {...serverPreferences, theme: "light"};
  const densitySaved = page.waitForRequest(
    request =>
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === "/api/preferences",
  );
  await page.locator(".web-settings-grid label").filter({
    hasText: "Density",
  }).locator("select").selectOption("comfortable");
  const request = await densitySaved;

  expect(request.postDataJSON()).toEqual({density: "comfortable"});
  expect(serverPreferences.theme).toBe("light");
  expect(serverPreferences.density).toBe("comfortable");
});

test("retries failed preference writes without losing changes", async ({
  page,
}) => {
  await page.unroute("**/api/preferences");
  let attempts = 0;
  let serverPreferences = {
    hiddenPanels: [] as string[],
    panelOrder: [] as string[],
    windowSeconds: 3600,
    activePage: "settings",
    panelState: {},
    panelColumns: {},
    theme: "dark",
    density: "compact",
    customPanels: [] as unknown[],
  };
  await page.route("**/api/preferences", route => {
    if (route.request().method() === "PATCH") {
      attempts++;
      if (attempts === 1) {
        return route.fulfill({status: 500, body: "temporary failure"});
      }
      serverPreferences = {
        ...serverPreferences,
        ...route.request().postDataJSON(),
      };
    }
    return route.fulfill({json: {preferences: serverPreferences}});
  });
  await page.goto("/?page=settings");
  await page.locator(".web-settings-grid label").filter({
    hasText: "Density",
  }).locator("select").selectOption("comfortable");

  await expect.poll(() => attempts, {timeout: 5000}).toBe(2);
  expect(serverPreferences.density).toBe("comfortable");
});

test("does not overwrite server preferences after a load failure", async ({
  page,
}) => {
  await page.unroute("**/api/preferences");
  let writes = 0;
  await page.route("**/api/preferences", route => {
    if (route.request().method() === "GET") {
      return route.fulfill({status: 500, body: "temporary failure"});
    }
    writes++;
    return route.fulfill({status: 500, body: "must not write"});
  });
  await page.goto("/?page=settings");
  await page.locator(".web-settings-grid label").filter({
    hasText: "Density",
  }).locator("select").selectOption("comfortable");
  await page.waitForTimeout(1200);

  expect(writes).toBe(0);
});

test("retries initial local preference migration", async ({page}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "hostmon.dashboard.preferences.v2",
      JSON.stringify({
        hiddenPanels: [],
        panelOrder: [],
        windowSeconds: 3600,
        activePage: "overview",
        panelState: {},
        panelColumns: {},
        theme: "light",
        density: "compact",
        customPanels: [],
      }),
    );
  });
  await page.unroute("**/api/preferences");
  let attempts = 0;
  let saved: Record<string, unknown> | null = null;
  await page.route("**/api/preferences", route => {
    if (route.request().method() === "GET") {
      return route.fulfill({json: {preferences: saved}});
    }
    attempts++;
    if (attempts === 1) {
      return route.fulfill({status: 500, body: "temporary failure"});
    }
    saved = route.request().postDataJSON();
    return route.fulfill({json: {preferences: saved}});
  });

  await page.goto("/?page=overview");

  await expect.poll(() => attempts, {timeout: 5000}).toBe(2);
  expect(saved?.theme).toBe("light");
});

test("configures visible workload table columns", async ({ page }) => {
  await page.goto("/?page=settings");
  await page.locator("#layout-panels-button").click();
  const setting = page.locator(".panel-setting").filter({
    hasText: "GPU workloads",
  });

  await setting.locator("summary").click();
  await setting.getByText("Pending GPUs").locator("input").uncheck();
  await page.locator("#layout-close").click();
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
