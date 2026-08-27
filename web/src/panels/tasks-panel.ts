import type { TasksPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

export class TasksPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly content: HTMLElement;

  constructor(
    definition: TasksPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "tasks-panel");
    this.element = shell.element;
    this.content = document.createElement("div");
    this.content.className = "task-grid";
    shell.body.append(this.content);
    this.update();
  }

  update(): void {
    const metrics = this.context.store.latestMetrics;
    const fields = this.context.store.latestFields;
    const permissions = Object.entries(metrics).filter(
      ([name]) => name.startsWith("permission/") && name.endsWith("/allowed"),
    );
    const granted = permissions.filter(([, value]) => value === 1).length;
    this.content.replaceChildren(
      item(
        "GPU nodes",
        `${display(metrics["k8s/occupied_gpu_nodes"])} / ${display(metrics["k8s/quota_nodes"])}`,
      ),
      item("Stopped or reduced", String(fields["k8s_stopped_tasks"] ?? "(none)")),
      item("Lost nodes", String(fields["k8s_stopped_task_details"] ?? "(none)")),
      item("Failed tasks", String(fields["k8s_failed_tasks"] ?? "(none)")),
      item(
        "Permission checks",
        permissions.length ? `${granted} / ${permissions.length} granted` : "(none)",
      ),
    );
  }

  destroy(): void {}
}

function item(label: string, value: string): HTMLElement {
  const element = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  const output = document.createElement("strong");
  output.textContent = value;
  element.append(name, output);
  return element;
}

function display(value: number | undefined): string {
  return Number.isFinite(value) ? String(value) : "--";
}
