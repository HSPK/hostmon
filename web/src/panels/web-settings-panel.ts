import type {
  DashboardPreferences,
  WebSettingsPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";

export class WebSettingsPanel implements PanelRenderer {
  readonly element: HTMLElement;

  constructor(
    definition: WebSettingsPanelDefinition,
    context: PanelContext,
  ) {
    const shell = panelShell(definition, "web-settings-panel");
    this.element = shell.element;
    const appearance = context.actions.appearance();
    const form = document.createElement("div");
    form.className = "web-settings-grid";
    const theme = selectSetting<
      DashboardPreferences["theme"]
    >("Theme", ["dark", "light", "system"], appearance.theme);
    const density = selectSetting<
      DashboardPreferences["density"]
    >(
      "Density",
      ["compact", "comfortable"],
      appearance.density,
    );
    const apply = (): void => {
      context.actions.setAppearance(theme.select.value, density.select.value);
    };
    theme.select.addEventListener("change", apply);
    density.select.addEventListener("change", apply);
    const panels = document.createElement("button");
    panels.type = "button";
    panels.className = "button";
    panels.textContent = "Configure panels";
    panels.addEventListener("click", () =>
      context.actions.openPanelSettings(),
    );
    form.append(theme.element, density.element, panels);
    shell.body.append(form);
  }

  update(): void {}
  destroy(): void {}
}

function selectSetting<T extends string>(
  label: string,
  values: T[],
  selected: T,
): {element: HTMLElement; select: HTMLSelectElement & {value: T}} {
  const element = document.createElement("label");
  const title = document.createElement("span");
  title.textContent = label;
  const select = document.createElement("select") as HTMLSelectElement & {
    value: T;
  };
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value[0]!.toUpperCase() + value.slice(1);
    select.append(option);
  }
  select.value = selected;
  element.append(title, select);
  return {element, select};
}
