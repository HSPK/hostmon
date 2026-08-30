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
    const timeRange = selectOptions(
      "Time range",
      [
        ["900", "15 minutes"],
        ["3600", "1 hour"],
        ["21600", "6 hours"],
        ["43200", "12 hours"],
        ["86400", "24 hours"],
        ["604800", "7 days"],
        ["2592000", "30 days"],
      ],
      String(context.actions.windowSeconds()),
    );
    const defaults = context.actions.chartDefaults();
    const style = selectSetting(
      "Default chart style",
      ["line", "area"] as const,
      defaults.style,
    );
    const width = selectOptions(
      "Default chart width",
      [
        ["1", "One column"],
        ["2", "Full width"],
      ],
      String(defaults.columnSpan),
    );
    const height = selectOptions(
      "Default chart height",
      [
        ["220", "Compact"],
        ["270", "Standard"],
        ["360", "Tall"],
        ["480", "Extra tall"],
      ],
      String(defaults.height),
    );
    const lineWidth = numberSetting(
      "Default line width",
      defaults.lineWidth,
      0.5,
      5,
      0.5,
    );
    const apply = (): void => {
      context.actions.setAppearance(theme.select.value, density.select.value);
    };
    const applyChartDefaults = (): void => {
      context.actions.setChartDefaults({
        style: style.select.value,
        columnSpan: Number(width.select.value) === 2 ? 2 : 1,
        height: Number(height.select.value),
        lineWidth: Number(lineWidth.input.value),
      });
    };
    theme.select.addEventListener("change", apply);
    density.select.addEventListener("change", apply);
    timeRange.select.addEventListener("change", () =>
      context.actions.setWindow(Number(timeRange.select.value)),
    );
    style.select.addEventListener("change", applyChartDefaults);
    width.select.addEventListener("change", applyChartDefaults);
    height.select.addEventListener("change", applyChartDefaults);
    lineWidth.input.addEventListener("change", applyChartDefaults);
    const resetCharts = document.createElement("button");
    resetCharts.type = "button";
    resetCharts.className = "button";
    resetCharts.textContent = "Reset chart defaults";
    resetCharts.addEventListener("click", () => {
      style.select.value = "line";
      width.select.value = "1";
      height.select.value = "270";
      lineWidth.input.value = "1.5";
      applyChartDefaults();
    });
    form.append(
      theme.element,
      density.element,
      timeRange.element,
      style.element,
      width.element,
      height.element,
      lineWidth.element,
      resetCharts,
    );
    shell.body.append(form);
  }

  update(): void {}
  destroy(): void {}
}

function selectSetting<T extends string>(
  label: string,
  values: readonly T[],
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

function selectOptions(
  label: string,
  values: Array<[string, string]>,
  selected: string,
): {element: HTMLElement; select: HTMLSelectElement} {
  const element = document.createElement("label");
  const title = document.createElement("span");
  title.textContent = label;
  const select = document.createElement("select");
  for (const [value, text] of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = selected;
  element.append(title, select);
  return {element, select};
}

function numberSetting(
  label: string,
  value: number,
  minimum: number,
  maximum: number,
  step: number,
): {element: HTMLElement; input: HTMLInputElement} {
  const element = document.createElement("label");
  const title = document.createElement("span");
  title.textContent = label;
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(minimum);
  input.max = String(maximum);
  input.step = String(step);
  input.value = String(value);
  element.append(title, input);
  return {element, input};
}
