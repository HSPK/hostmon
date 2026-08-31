import { expect, test } from "@playwright/test";
import dashboardDefinition from "../src/config/dashboard.json" with {
  type: "json",
};

const rulesApiPattern = /\/api\/rules(?:\/[^/?]+)?(?:\?.*)?$/;
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
        websocket_inactivity_timeout_seconds: 30,
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
        refresh_seconds: 60,
        refresh_after_seconds: 60,
        document: clusterGPUReport,
      }),
    }),
  );
  await page.route(rulesApiPattern, async route => {
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
  await expect(page.locator(".toolbar-actions")).not.toContainText("Window");
  await expect(
    page.locator('[class*="drawer"], [id*="drawer"]'),
  ).toHaveCount(0);
  await expect(page.locator(".sidebar nav h3")).toHaveText([
    "Charts",
    "Tables",
    "Manage",
    "Other",
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
  const collectorView = page.getByRole("button", {
    name: "View",
    exact: true,
  });
  await expect(collectorView).toBeInViewport({ratio: 1});
  await expect(
    page.locator('.health-table td[data-column="details"]'),
  ).toHaveClass(/column-pinned-right/);
  await page
    .locator(".collector-panel .data-grid-viewport")
    .evaluate(element => {
      element.scrollLeft = element.scrollWidth;
    });
  await expect(collectorView).toBeInViewport({ratio: 1});
  await collectorView.click();
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
  const latestSample = page.locator(".system-card").filter({
    hasText: "Latest sample (UTC+8)",
  });
  await expect(latestSample.locator("code")).toHaveText(
    /^\d{4}-\d{2}-\d{2}, \d{2}:\d{2}:\d{2}$/,
  );
});

test("reconnects when a websocket stream stops publishing samples", async ({
  page,
}) => {
  let connections = 0;
  await page.route("**/api/status", route =>
    route.fulfill({
      json: {
        host: "test-host",
        version: "0.1.1.dev0",
        updated_at: now,
        metrics,
        fields,
        websocket_clients: 1,
        websocket_inactivity_timeout_seconds: 0.5,
      },
    }),
  );
  await page.routeWebSocket("**/api/ws", socket => {
    connections++;
    socket.send(
      JSON.stringify({
        timestamp: now,
        host: "test-host",
        metrics,
        fields,
      }),
    );
  });

  await page.goto("/");
  await expect(page.locator("#connection-text")).toHaveText("connected");
  await expect(page.locator("#connection-text")).toHaveText("reconnecting", {
    timeout: 2_000,
  });
  await expect.poll(() => connections).toBeGreaterThan(1);
});

test("fetches plugin documents only after collector success advances", async ({
  page,
}) => {
  let requests = 0;
  let documentUpdatedAt = now;
  let sendSnapshot:
    | ((timestamp: number, successAge: number) => void)
    | null = null;
  await page.route("**/api/plugins/cluster_gpu_usage", route => {
    requests++;
    return route.fulfill({
      json: {
        name: "cluster_gpu_usage",
        updated_at: documentUpdatedAt,
        schema_version: 3,
        refresh_seconds: 60,
        refresh_after_seconds: 0.5,
        document: clusterGPUReport,
      },
    });
  });
  await page.routeWebSocket("**/api/ws", socket => {
    sendSnapshot = (timestamp, successAge) =>
      socket.send(
        JSON.stringify({
          timestamp,
          host: "test-host",
          metrics: {
            ...metrics,
            "monitor/collector/cluster_gpu_usage/last_success_age_seconds":
              successAge,
          },
          fields,
        }),
      );
    sendSnapshot(now + 10, 10);
  });

  await page.goto("/?page=gpu-fleet");
  await expect(page.locator(".fleet-table")).toContainText("56 / 64");
  await expect.poll(() => requests).toBe(1);
  if (!sendSnapshot) throw new Error("WebSocket route was not connected");

  await page.waitForTimeout(600);
  sendSnapshot(now + 20, 20);
  await page.waitForTimeout(150);
  expect(requests).toBe(1);

  documentUpdatedAt = now + 30;
  sendSnapshot(now + 30, 0);
  await expect.poll(() => requests).toBe(2);

  await page.getByRole("button", {name: "Refresh"}).click();
  await expect.poll(() => requests).toBe(3);
});

test("searches metrics and persists a custom chart", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Metrics" }).click();
  await expect(page.locator(".metric-table tbody tr")).toHaveCount(
    Object.keys(metrics).length,
  );

  await page.getByRole("button", { name: "Add chart" }).click();
  const saveChart = page.getByRole("button", {name: "Save chart"});
  await expect(saveChart).toBeDisabled();
  await expect(page.locator("#chart-page")).toHaveValue("overview");
  await page.locator("#chart-metric-filter").fill("custom/latency");
  await page.locator(".metric-option").filter({ hasText: "custom/latency_ms" }).click();
  await expect(saveChart).toBeEnabled();
  await expect(page.locator("#chart-metric-selected")).toContainText(
    "custom/latency_ms",
  );
  const minimum = page.locator("#chart-min");
  const maximum = page.locator("#chart-max");
  const rangeFeedback = page.locator("#chart-range-feedback");
  await minimum.fill("100");
  await expect(saveChart).toBeDisabled();
  await expect(rangeFeedback).toHaveText(
    "Set both Y bounds, or leave both as Auto.",
  );
  await maximum.fill("50");
  await expect(saveChart).toBeDisabled();
  await expect(rangeFeedback).toHaveText(
    "Y maximum must be greater than Y minimum.",
  );
  await maximum.fill("150");
  await expect(saveChart).toBeEnabled();
  await expect(rangeFeedback).toBeEmpty();
  await page.locator("#chart-title").fill("");
  await expect(saveChart).toBeDisabled();
  await page.locator("#chart-title").fill("Request latency");
  await expect(saveChart).toBeEnabled();
  await page.locator("#chart-style").selectOption("area");
  await saveChart.click();

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
  await expect(
    page.getByRole("button", {name: "Sections", exact: true}),
  ).toHaveCount(0);
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
  await page.getByLabel("Section for Metrics").selectOption({
    label: "Operations",
  });
  await page.locator("#layout-close").click();
  let sidebarSection = page.locator(".sidebar .nav-section").filter({
    has: page.getByRole("heading", { name: "Operations" }),
  });
  await expect(
    sidebarSection.getByRole("button", { name: "Metrics" }),
  ).toHaveCount(1);
  const sectionActions = sidebarSection.locator(".nav-section-actions");
  await expect(sectionActions).toHaveCSS("opacity", "0");
  await sidebarSection.hover();
  await expect(sectionActions).toHaveCSS("opacity", "1");
  await sidebarSection.getByRole("button", {
    name: "Edit Operations section",
  }).click();
  const sectionName = page.getByLabel("Name for Operations section");
  await expect(sectionName).toBeFocused();
  await sectionName.fill("Experiments");
  await sectionName.press("Tab");
  await page.locator("#layout-close").click();
  sidebarSection = page.locator(".sidebar .nav-section").filter({
    has: page.getByRole("heading", {name: "Experiments"}),
  });
  const chartsSection = page.locator(".sidebar .nav-section").filter({
    has: page.getByRole("heading", {name: "Charts", exact: true}),
  });
  await sidebarSection.hover();
  await sidebarSection.getByRole("button", {
    name: "Drag Experiments section",
  }).dragTo(chartsSection.locator(".nav-section-header"));
  await expect
    .poll(() =>
      page
        .locator(".sidebar .nav-main .nav-section h3")
        .allTextContents(),
    )
    .toEqual(["Experiments", "Charts", "Tables", "Manage"]);

  await page.reload();
  await page.locator("#layout-navigation-button").click();
  await expect(page.getByLabel("Section for Metrics")).toHaveValue(
    "custom-operations",
  );
  await page.locator("#layout-close").click();
  page.once("dialog", dialog => dialog.accept());
  sidebarSection = page.locator(".sidebar .nav-section").filter({
    has: page.getByRole("heading", {name: "Experiments"}),
  });
  await sidebarSection.hover();
  await sidebarSection.getByRole("button", {
    name: "Delete Experiments section",
  }).click();
  await expect(
    page.getByRole("heading", {name: "Experiments"}),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Metrics" })).toHaveCount(1);
});

test("manages sections and metric pages from the Navigation dock", async ({
  page,
}) => {
  await page.goto("/?page=overview");
  await page.locator("#layout-navigation-button").click();
  let editor = page.locator("#layout-navigation-view");
  await editor.getByLabel("New section name").fill("Experiments");
  await editor.getByRole("button", {name: "Add section"}).click();

  editor = page.locator("#layout-navigation-view");
  await editor.getByLabel("New metric page name").fill("Training metrics");
  await editor.getByLabel("New metric page section").selectOption({
    label: "Experiments",
  });
  await editor.getByRole("button", {name: "Add page"}).click();

  await expect(page.locator("#page-title")).toHaveText("Training metrics");
  await page.locator("#layout-close").click();
  await expect(page.locator(".empty-page")).toContainText("No panels yet");
  await page.locator(".toolbar").getByRole("button", {name: "Add chart"}).click();
  await expect(page.locator("#chart-page")).toHaveValue(
    "page-training-metrics",
  );
  await page.getByRole("button", {name: "Close"}).click();

  await page.locator("#layout-navigation-button").click();
  editor = page.locator("#layout-navigation-view");
  const pageRow = editor.locator(
    '[data-navigation-page-id="page-training-metrics"]',
  );
  await pageRow.locator("input").fill("Training runs");
  await pageRow.locator("input").press("Tab");
  await page.reload();
  await page.locator("#layout-navigation-button").click();
  await expect(
    page.locator(
      '#layout-navigation-view [data-navigation-page-id="page-training-metrics"] input',
    ),
  ).toHaveValue("Training runs");

  page.once("dialog", dialog => dialog.accept());
  await page
    .locator(
      '#layout-navigation-view [data-navigation-page-id="page-training-metrics"]',
    )
    .getByRole("button", {name: "Delete"})
    .click();
  await expect(
    page.locator('[data-navigation-page-id="page-training-metrics"]'),
  ).toHaveCount(0);
  page.once("dialog", dialog => dialog.accept());
  await page
    .locator(
      '#layout-navigation-view [data-navigation-section-id="custom-experiments"]',
    )
    .getByRole("button", {name: "Delete"})
    .click();
  await expect(
    page.locator('[data-navigation-section-id="custom-experiments"]'),
  ).toHaveCount(0);
});

test("keeps long sidebar section names clear of hover actions", async ({
  page,
}) => {
  const name =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKL";
  await page.goto("/?page=overview");
  await page.locator("#layout-navigation-button").click();
  await page.getByLabel("New section name").fill(name);
  await page.getByRole("button", {name: "Add section"}).click();
  await page.locator("#layout-close").click();

  const section = page.locator(".sidebar .nav-section").filter({
    has: page.getByRole("heading", {name}),
  });
  await section.hover();
  const title = section.getByRole("heading", {name});
  const actions = section.locator(".nav-section-actions");
  const titleBox = await title.boundingBox();
  const actionsBox = await actions.boundingBox();

  expect(titleBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(
    actionsBox!.x,
  );
  await expect(title).toHaveCSS("text-overflow", "ellipsis");
  await expect(title).toHaveAttribute("title", name);
  await expect(section.getByRole("button", {
    name: `Edit ${name} section`,
  })).toBeVisible();
  await expect(section.getByRole("button", {
    name: `Delete ${name} section`,
  })).toBeVisible();
  expect(
    await title.evaluate(element => element.scrollWidth > element.clientWidth),
  ).toBe(true);

  page.once("dialog", dialog => dialog.accept());
  await section.getByRole("button", {
    name: `Delete ${name} section`,
  }).click();
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

  const search = page.locator(
    ".gpu-submitters-panel input[type=search]",
  );
  await search.fill("training-job-001");
  await expect(page.locator(".table-count")).toHaveText(
    "1 workload | 1/1",
  );
  const searchSaved = page.waitForResponse(response => {
    const request = response.request();
    return (
      request.method() === "PATCH" &&
      new URL(request.url()).pathname === "/api/preferences" &&
      request.postData()?.includes('"query":"missing-workload"') === true
    );
  });
  await search.fill("missing-workload");
  await searchSaved;
  await expect(page.locator(".table-empty")).toHaveText(
    "No workloads match the current filters",
  );

  await page.getByRole("button", {name: "Metrics"}).click();
  await page.goBack();
  await expect(page.locator("#page-title")).toHaveText("Workloads");
  await expect(search).toHaveValue("missing-workload");
  await expect(page.locator(".table-empty")).toHaveText(
    "No workloads match the current filters",
  );

  await page.reload();
  await expect(search).toHaveValue("missing-workload");
  await expect(page.getByLabel("Workload state")).toHaveValue("attention");
  await expect(
    page.getByRole("columnheader", { name: "Pending GPUs" }),
  ).toHaveAttribute("aria-sort", "descending");
  await expect(page.locator(".table-empty")).toHaveText(
    "No workloads match the current filters",
  );
});

test("remains responsive on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const toolbarControls = page.locator(
    ".toolbar-actions > .control, .toolbar-actions > .button",
  );
  await expect(toolbarControls).toHaveCount(5);
  const toolbarRows = await toolbarControls.evaluateAll(elements =>
  new Set(
    elements.map(element =>
      Math.round(element.getBoundingClientRect().top),
    ),
  ).size,
  );
  expect(toolbarRows).toBe(1);
  const toolbarBox = await page.locator(".toolbar").boundingBox();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.height).toBeLessThan(110);

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

  await expect(page.getByRole("button", {name: "Menu"})).toHaveCount(0);
  await expect(page.locator(".sidebar")).not.toBeVisible();
  await page.locator("#layout-pages-button").click();
  await page
    .locator("#mobile-navigation")
    .getByRole("button", {name: "Metrics"})
    .click();
  await expect(page.locator("#layout-panel")).not.toBeVisible();
  await expect(page.locator("#page-title")).toHaveText("Metrics");
  const metricViewport = page.locator(
    ".metric-explorer-panel .data-grid-viewport",
  );
  await expect(page.locator(".metric-table tbody tr").first()).toBeVisible();
  await metricViewport.evaluate(element => {
    element.scrollLeft = 0;
  });
  const metricSelect = await page
    .locator('.metric-table td[data-column="select"]')
    .first()
    .boundingBox();
  const metricName = await page
    .locator('.metric-table td[data-column="name"]')
    .first()
    .boundingBox();
  expect(metricSelect).not.toBeNull();
  expect(metricName).not.toBeNull();
  expect(metricName!.width).toBeLessThanOrEqual(212);
  expect(metricName!.x).toBeGreaterThanOrEqual(
    metricSelect!.x + metricSelect!.width - 1,
  );
  await expect(
    page.locator('.metric-table td[data-column="select"] input').first(),
  ).toBeInViewport({ratio: 1});
  await expect(
    page.locator('.metric-table td[data-column="current"]').first(),
  ).toBeInViewport({ratio: 1});

  await page.locator("#layout-pages-button").click();
  await page
    .locator("#mobile-navigation")
    .getByRole("button", {name: "Workloads"})
    .click();
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
  await page.locator("#layout-pages-button").click();
  await page
    .locator("#mobile-navigation")
    .getByRole("button", {name: "Overview"})
    .click();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByRole("button", { name: "Save chart" }))
    .toBeInViewport({ratio: 1});
  const editorBodyScrolls = await page
    .locator(".chart-dialog-body")
    .evaluate(element => element.scrollHeight > element.clientHeight);
  expect(editorBodyScrolls).toBe(true);
});

test("moves keyboard focus into and out of the layout dock", async ({
  page,
}) => {
  await page.setViewportSize({width: 320, height: 720});
  await page.goto("/?page=overview");
  const pages = page.locator("#layout-pages-button");
  const close = page.locator("#layout-close");

  await pages.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#layout-panel")).toBeVisible();
  await expect(close).toBeFocused();

  await page.keyboard.press("Tab");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(document.activeElement?.closest("#layout-panel")),
      ),
    )
    .toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("#layout-panel")).not.toBeVisible();
  await expect(pages).toBeFocused();
});

test("keeps all toolbar controls readable at 320px", async ({ page }) => {
  await page.setViewportSize({width: 320, height: 720});
  await page.goto("/?page=overview");

  const toolbarControls = page.locator(
    ".toolbar-actions > .control, .toolbar-actions > .button",
  );
  await expect(toolbarControls).toHaveCount(5);
  const toolbarRows = await toolbarControls.evaluateAll(elements =>
      new Set(
        elements.map(element =>
          Math.round(element.getBoundingClientRect().top),
        ),
      ).size,
    );
  const windowBox = await page.locator("#window-select").boundingBox();
  const actionsFit = await page.locator(".toolbar-actions").evaluate(
    element => element.scrollWidth <= element.clientWidth,
  );
  const latencyBox = await page.locator("#operation-latency").boundingBox();
  const dockBox = await page.locator(".layout-dock-nav").boundingBox();

  expect(toolbarRows).toBe(1);
  expect(windowBox).not.toBeNull();
  expect(latencyBox).not.toBeNull();
  expect(dockBox).not.toBeNull();
  expect(windowBox!.width).toBeGreaterThanOrEqual(58);
  expect(actionsFit).toBe(true);
  expect(latencyBox!.x + latencyBox!.width).toBeLessThanOrEqual(
    dockBox!.x,
  );
  await expect(page.getByLabel("Time window")).toHaveValue("3600");

  await page.goto("/?page=metrics");
  const metricViewport = page.locator(
    ".metric-explorer-panel .data-grid-viewport",
  );
  const metricName = page
    .locator('.metric-table td[data-column="name"]')
    .first();
  const metricCurrent = page
    .locator('.metric-table td[data-column="current"]')
    .first();
  await expect(metricCurrent).toBeInViewport({ratio: 1});
  const viewportBox = await metricViewport.boundingBox();
  const nameBox = await metricName.boundingBox();
  const currentBox = await metricCurrent.boundingBox();

  expect(viewportBox).not.toBeNull();
  expect(nameBox).not.toBeNull();
  expect(currentBox).not.toBeNull();
  expect(nameBox!.width).toBeLessThanOrEqual(140);
  expect(currentBox!.x).toBeGreaterThanOrEqual(
    nameBox!.x + nameBox!.width - 1,
  );
  expect(currentBox!.x + currentBox!.width).toBeLessThanOrEqual(
    viewportBox!.x + viewportBox!.width + 1,
  );

  await page.goto("/?page=workloads");
  const workloadViewport = page.locator(
    ".gpu-submitters-panel .data-grid-viewport",
  );
  const workloadName = page
    .locator('.submitter-table td[data-column="name"]')
    .first();
  const workloadPending = page
    .locator('.submitter-table td[data-column="pending_gpus"]')
    .first();
  await expect(workloadName).toBeVisible();
  await workloadViewport.evaluate(element => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(workloadPending).toBeInViewport({ratio: 1});
  const workloadViewportBox = await workloadViewport.boundingBox();
  const workloadNameBox = await workloadName.boundingBox();
  const workloadPendingBox = await workloadPending.boundingBox();

  expect(workloadViewportBox).not.toBeNull();
  expect(workloadNameBox).not.toBeNull();
  expect(workloadPendingBox).not.toBeNull();
  expect(workloadNameBox!.width).toBeLessThanOrEqual(160);
  expect(workloadPendingBox!.x).toBeGreaterThanOrEqual(
    workloadNameBox!.x + workloadNameBox!.width - 1,
  );
  expect(
    workloadPendingBox!.x + workloadPendingBox!.width,
  ).toBeLessThanOrEqual(
    workloadViewportBox!.x + workloadViewportBox!.width + 1,
  );

  await page.goto("/?page=alerts");
  const alertViewport = page.locator(
    ".rules-panel .data-grid-viewport",
  );
  const alertEnabled = page
    .locator('.rules-table td[data-column="enabled"]')
    .first();
  const alertName = page
    .locator('.rules-table td[data-column="alert"]')
    .first();
  const alertActions = page
    .locator('.rules-table td[data-column="actions"]')
    .first();
  await expect(alertActions).toBeInViewport({ratio: 1});
  const alertViewportBox = await alertViewport.boundingBox();
  const alertEnabledBox = await alertEnabled.boundingBox();
  const alertNameBox = await alertName.boundingBox();
  const alertActionsBox = await alertActions.boundingBox();

  expect(alertViewportBox).not.toBeNull();
  expect(alertEnabledBox).not.toBeNull();
  expect(alertNameBox).not.toBeNull();
  expect(alertActionsBox).not.toBeNull();
  expect(alertNameBox!.x).toBeGreaterThanOrEqual(
    alertEnabledBox!.x + alertEnabledBox!.width - 1,
  );
  expect(alertNameBox!.x + alertNameBox!.width).toBeLessThanOrEqual(
    alertActionsBox!.x + 1,
  );
  expect(
    alertActionsBox!.x + alertActionsBox!.width,
  ).toBeLessThanOrEqual(
    alertViewportBox!.x + alertViewportBox!.width + 1,
  );

  await page.goto("/?page=collectors");
  const collectorViewport = page.locator(
    ".collector-panel .data-grid-viewport",
  );
  const collectorName = page
    .locator('.health-table td[data-column="name"]')
    .first();
  const collectorState = page
    .locator('.health-table td[data-column="state"]')
    .first();
  const collectorDetails = page
    .locator('.health-table td[data-column="details"]')
    .first();
  await expect(collectorDetails).toBeInViewport({ratio: 1});
  const collectorViewportBox = await collectorViewport.boundingBox();
  const collectorNameBox = await collectorName.boundingBox();
  const collectorStateBox = await collectorState.boundingBox();
  const collectorDetailsBox = await collectorDetails.boundingBox();

  expect(collectorViewportBox).not.toBeNull();
  expect(collectorNameBox).not.toBeNull();
  expect(collectorStateBox).not.toBeNull();
  expect(collectorDetailsBox).not.toBeNull();
  expect(collectorStateBox!.x).toBeGreaterThanOrEqual(
    collectorNameBox!.x + collectorNameBox!.width - 1,
  );
  expect(
    collectorStateBox!.x + collectorStateBox!.width,
  ).toBeLessThanOrEqual(collectorDetailsBox!.x + 1);
  expect(
    collectorDetailsBox!.x + collectorDetailsBox!.width,
  ).toBeLessThanOrEqual(
    collectorViewportBox!.x + collectorViewportBox!.width + 1,
  );

  await page.goto("/?page=settings");
  const settingsGrid = page.locator(".web-settings-grid");
  const resetChartDefaults = page.getByRole("button", {
    name: "Reset chart defaults",
  });
  await expect(resetChartDefaults).toBeInViewport({ratio: 1});
  const settingsFit = await settingsGrid.evaluate(element => {
    const boundary = element.getBoundingClientRect().right + 1;
    return (
      element.scrollWidth <= element.clientWidth &&
      [...element.children].every(
        child => child.getBoundingClientRect().right <= boundary,
      )
    );
  });
  const settingsColumns = await settingsGrid.evaluate(
    element =>
      getComputedStyle(element).gridTemplateColumns.split(" ").length,
  );
  const resetTextFits = await resetChartDefaults.evaluate(
    element => element.scrollWidth <= element.clientWidth,
  );

  expect(settingsFit).toBe(true);
  expect(settingsColumns).toBe(1);
  expect(resetTextFits).toBe(true);
});

test("keeps tablet toolbar actions on one row", async ({ page }) => {
  await page.setViewportSize({width: 600, height: 800});
  await page.goto("/?page=overview");

  const actionRows = await page
    .locator(".toolbar-actions > .control, .toolbar-actions > .button")
    .evaluateAll(elements =>
      new Set(
        elements.map(element =>
          Math.round(element.getBoundingClientRect().top),
        ),
      ).size,
    );
  const toolbarBox = await page.locator(".toolbar").boundingBox();

  expect(actionRows).toBe(1);
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox!.height).toBeLessThan(70);
});

test("keeps narrow desktop charts on one readable column", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/?page=overview");
  await expect(
    page.locator('.panel-section[data-section="Charts"] .panel'),
  ).toHaveCount(4);

  const charts = await page
    .locator('.panel-section[data-section="Charts"] .panel')
    .evaluateAll(elements =>
      elements.slice(0, 2).map(element => {
        const box = element.getBoundingClientRect();
        return {x: box.x, y: box.y, width: box.width};
      }),
    );

  expect(charts).toHaveLength(2);
  expect(charts[0]!.x).toBe(charts[1]!.x);
  expect(charts[1]!.y).toBeGreaterThan(charts[0]!.y);
  expect(charts[0]!.width).toBeGreaterThan(600);
});

test("avoids empty summary filler tracks on tablets", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  await page.goto("/?page=overview");

  await expect(page.locator(".stat-grid")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".stat-card").first()).not.toHaveCSS(
    "box-shadow",
    "none",
  );

  await page.goto("/?page=gpu-fleet");
  await expect(page.locator(".fleet-summary")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".fleet-summary > div").first()).not.toHaveCSS(
    "box-shadow",
    "none",
  );

  await page.goto("/?page=kubernetes");
  await expect(page.locator(".task-grid")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".task-grid > div").first()).not.toHaveCSS(
    "box-shadow",
    "none",
  );

  await page.goto("/?page=system");
  await expect(page.locator(".system-grid")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".system-card").first()).not.toHaveCSS(
    "box-shadow",
    "none",
  );
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

test("loads history only for visible chart pages", async ({ page }) => {
  const historyRequests: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/history") historyRequests.push(url);
  });

  await page.goto("/?page=workloads");
  await expect(page.locator("#page-title")).toHaveText("Workloads");
  await page.waitForTimeout(100);
  expect(historyRequests).toHaveLength(0);

  await page.getByRole("button", {name: "Overview"}).click();
  await expect.poll(() => historyRequests.length).toBe(1);
  const overviewMetrics =
    historyRequests[0]!.searchParams.get("metrics")?.split(",") ?? [];
  expect(overviewMetrics).toContain("cpu/percent");
  expect(overviewMetrics).not.toContain(
    "cluster_gpu/queue/total/capacity_gpus",
  );
  await expect
    .poll(() =>
      page
        .locator('[data-panel-id="host-utilization"] .series-legend span')
        .first()
        .evaluate(element =>
          getComputedStyle(element)
            .getPropertyValue("--series-color")
            .trim(),
        ),
    )
    .toBe("#4ea1d3");
  const seriesPixels = await page
    .locator('[data-panel-id="host-utilization"] canvas')
    .evaluate(canvas => {
      const context = (canvas as HTMLCanvasElement).getContext("2d");
      if (!context) return 0;
      const pixels = context.getImageData(
        0,
        0,
        context.canvas.width,
        context.canvas.height,
      ).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          Math.abs(pixels[index]! - 78) <= 8 &&
          Math.abs(pixels[index + 1]! - 161) <= 8 &&
          Math.abs(pixels[index + 2]! - 211) <= 8 &&
          pixels[index + 3]! > 0
        ) {
          count++;
        }
      }
      return count;
    });
  expect(seriesPixels).toBeGreaterThan(0);

  await page.getByRole("button", {name: "GPU Fleet"}).click();
  await expect.poll(() => historyRequests.length).toBe(2);
  const fleetMetrics =
    historyRequests[1]!.searchParams.get("metrics")?.split(",") ?? [];
  expect(fleetMetrics).toContain(
    "cluster_gpu/queue/total/capacity_gpus",
  );
  expect(fleetMetrics).not.toContain("cpu/percent");

  await page.getByRole("button", {name: "Workloads"}).click();
  await page.waitForTimeout(100);
  expect(historyRequests).toHaveLength(2);
});

test("debounces history requests during rapid page navigation", async ({
  page,
}) => {
  const historyRequests: URL[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/history") historyRequests.push(url);
  });

  await page.goto("/?page=overview");
  await expect.poll(() => historyRequests.length).toBe(1);
  await page.getByRole("button", {name: "GPU Fleet"}).click();
  await page.getByRole("button", {name: "Overview"}).click();
  await page.getByRole("button", {name: "GPU Fleet"}).click();

  await expect(page.locator("#page-title")).toHaveText("GPU Fleet");
  await expect.poll(() => historyRequests.length).toBe(2);
  await page.waitForTimeout(100);
  expect(historyRequests).toHaveLength(2);
  expect(historyRequests[1]!.searchParams.get("metrics")).toContain(
    "cluster_gpu/queue/total/capacity_gpus",
  );
});

test("exports complete chart history on demand", async ({ page }) => {
  await page.goto("/?page=workloads");
  const historyRequest = page.waitForRequest(request => {
    const url = new URL(request.url());
    return (
      url.pathname === "/api/history" &&
      url.searchParams.get("metrics")?.includes("cpu/percent") === true &&
      url.searchParams
        .get("metrics")
        ?.includes("cluster_gpu/queue/total/capacity_gpus") === true
    );
  });

  await page.getByRole("button", {name: "Export"}).click();
  await historyRequest;
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

test("deletes a chart from its editor", async ({ page }) => {
  await page.goto("/?page=overview");
  const chart = page.locator('[data-panel-id="host-utilization"]');
  await chart.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#chart-delete")).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#chart-delete").click();

  await expect(chart).toHaveCount(0);
  await page.reload();
  await expect(
    page.locator('[data-panel-id="host-utilization"]'),
  ).toHaveCount(0);
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

test("rolls back failed alert mutations and reports the error", async ({
  page,
}) => {
  await page.unroute(rulesApiPattern);
  await page.route(rulesApiPattern, route => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        json: {
          rules: [
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
          ],
        },
      });
    }
    return route.fulfill({
      status: 503,
      json: {error: "synthetic write failure"},
    });
  });
  const pageErrors: Error[] = [];
  page.on("pageerror", error => pageErrors.push(error));
  await page.goto("/?page=alerts");

  const enabled = page.getByLabel("Enable high-cpu");
  const updateFailure = page.waitForResponse(response => {
    const request = response.request();
    return (
      request.method() === "PUT" &&
      new URL(response.url()).pathname === "/api/rules/high-cpu"
    );
  });
  await enabled.uncheck();
  expect((await updateFailure).status()).toBe(503);
  await expect(enabled).toBeChecked();
  await expect(enabled).toBeEnabled();
  await expect(page.locator(".rules-feedback")).toContainText(
    "Could not update high-cpu",
  );
  await expect(page.locator(".rules-feedback")).toHaveAttribute(
    "role",
    "alert",
  );

  page.once("dialog", dialog => dialog.accept());
  const deleteFailure = page.waitForResponse(response => {
    const request = response.request();
    return (
      request.method() === "DELETE" &&
      new URL(response.url()).pathname === "/api/rules/high-cpu"
    );
  });
  await page.getByRole("button", {name: "Delete", exact: true}).click();
  expect((await deleteFailure).status()).toBe(503);
  await expect(page.locator(".rules-feedback")).toContainText(
    "Could not delete high-cpu",
  );
  expect(pageErrors).toEqual([]);
});

test("keeps the alert editor readable on narrow screens", async ({ page }) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto("/?page=alerts");
  const edit = page.getByRole("button", {name: "Edit"}).first();
  await expect(edit).toBeInViewport({ratio: 1});
  await expect(
    page.locator('.rules-table td[data-column="actions"]').first(),
  ).toHaveClass(/column-pinned-right/);
  await page.locator(".rules-panel .data-grid-viewport").evaluate(element => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(edit).toBeInViewport({ratio: 1});
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
  await page.getByLabel("Time range").selectOption("86400");
  await page.getByLabel("Default chart style").selectOption("area");
  await page.getByLabel("Default chart width").selectOption("2");
  await page.getByLabel("Default chart height").selectOption("360");
  await page.getByLabel("Default line width").fill("2.5");
  await page.getByLabel("Default line width").press("Tab");
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
  const elementContrast = (selector: string) =>
    page.locator(selector).evaluate(element => {
      const channels = (value: string) => {
        const values = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        if (!values || values.length !== 3) {
          throw new Error(`invalid color: ${value}`);
        }
        return values;
      };
      const luminance = (value: string) => {
        const components = channels(value).map(component => {
          const normalized = component / 255;
          return normalized <= 0.03928
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return (
          0.2126 * components[0]! +
          0.7152 * components[1]! +
          0.0722 * components[2]!
        );
      };
      const style = getComputedStyle(element);
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      );
    });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByLabel("Time range")).toHaveValue("86400");
  expect(await elementContrast(".product-mark")).toBeGreaterThanOrEqual(4.5);
  await page.locator(".toolbar").getByRole("button", {name: "Add chart"}).click();
  await page.locator(".metric-option").first().click();
  expect(await elementContrast("#chart-save")).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator("#chart-style")).toHaveValue("area");
  await expect(page.locator("#chart-width")).toHaveValue("2");
  await expect(page.locator("#chart-height")).toHaveValue("360");
  await expect(page.locator("#chart-line-width")).toHaveValue("2.5");
});

test("follows live system color scheme without persisting", async ({
  page,
}) => {
  await page.unroute("**/api/preferences");
  const writes: string[] = [];
  await page.route("**/api/preferences", route => {
    if (route.request().method() !== "GET") {
      writes.push(route.request().method());
    }
    return route.fulfill({
      json: {
        preferences: {
          hiddenPanels: [],
          panelOrder: [],
          windowSeconds: 3600,
          activePage: "overview",
          panelState: {},
          panelColumns: {},
          theme: "system",
          density: "compact",
          customPanels: [],
        },
      },
    });
  });
  await page.emulateMedia({colorScheme: "dark"});
  await page.goto("/?page=overview");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#080b10",
  );

  await page.emulateMedia({colorScheme: "light"});
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
    "content",
    "#ffffff",
  );

  await page.emulateMedia({colorScheme: "dark"});
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(writes).toEqual([]);
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
