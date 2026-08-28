import type { TasksPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import { renderDisplayItem } from "./display-values";

export class TasksPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly content: HTMLElement;

  constructor(
    private readonly definition: TasksPanelDefinition,
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
    this.content.replaceChildren(
      ...this.definition.items.map(definition =>
        item(
          definition.label,
          renderDisplayItem(definition, this.context.store),
        ),
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
