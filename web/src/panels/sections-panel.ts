import type { SectionsPanelDefinition } from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

export class SectionsPanel implements PanelRenderer {
  readonly element: HTMLElement;

  constructor(
    definition: SectionsPanelDefinition,
    context: PanelContext,
  ) {
    const shell = panelShell(definition, "sections-panel");
    this.element = shell.element;
    context.actions.renderNavigationEditor(shell.body);
  }

  update(): void {}
  destroy(): void {}
}
