import type {
  AlertRuleConfig,
  RulesPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import {
  DataTable,
  type DataColumn,
  type SortDirection,
} from "./data-table";
import { tableFooter } from "./table-controls";

export class RulesPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly table: DataTable<AlertRuleConfig>;
  private readonly columns: DataColumn<AlertRuleConfig>[];
  private readonly search: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly editor: HTMLFormElement;
  private rules: AlertRuleConfig[] = [];
  private editing: AlertRuleConfig | null = null;
  private sort: "alert" | "level" | "expr" = "alert";
  private sortDirection: SortDirection = "asc";

  constructor(
    definition: RulesPanelDefinition,
    private readonly context: PanelContext,
  ) {
    const shell = panelShell(definition, "rules-panel");
    this.element = shell.element;
    const controls = document.createElement("div");
    controls.className = "table-controls data-grid-toolbar";
    this.search = document.createElement("input");
    this.search.type = "search";
    this.search.placeholder = "Filter alert rules";
    this.search.addEventListener("input", () => this.render());
    const add = document.createElement("button");
    add.type = "button";
    add.className = "button button-primary";
    add.textContent = "Add rule";
    add.addEventListener("click", () => this.openEditor());
    this.count = document.createElement("span");
    this.count.className = "table-count";
    controls.append(this.search, add);
    this.columns = this.ruleColumns();
    this.table = new DataTable(
      this.columns,
      "rules-table",
      (value, direction) => {
        this.sort = value as "alert" | "level" | "expr";
        this.sortDirection = direction;
        this.render();
      },
      undefined,
      {value: this.sort, direction: this.sortDirection},
    );

    this.editor = document.createElement("form");
    this.editor.className = "rule-editor";
    this.editor.hidden = true;
    this.editor.innerHTML = `
      <label>Alert<input name="alert" required maxlength="100"></label>
      <label>Level<select name="level"><option>warning</option><option>critical</option><option>info</option></select></label>
      <label class="rule-expression">Expression<input name="expr" required></label>
      <label>Title<input name="title" required></label>
      <label class="rule-message">Message<textarea name="message" required></textarea></label>
      <label class="rule-enabled"><input name="enabled" type="checkbox"> Enabled</label>
      <div class="rule-editor-actions"><button type="button" class="button">Cancel</button><button class="button button-primary" type="submit">Save rule</button></div>
      <output></output>
    `;
    this.editor.querySelector<HTMLButtonElement>('button[type="button"]')
      ?.addEventListener("click", () => {
        this.editor.hidden = true;
      });
    this.editor.addEventListener("submit", event => {
      event.preventDefault();
      void this.save();
    });
    this.table.element.append(tableFooter(this.count));
    shell.body.append(controls, this.editor, this.table.element);
    void this.load();
  }

  update(): void {}
  destroy(): void {}

  private async load(): Promise<void> {
    this.rules = await this.context.actions.loadRules();
    this.render();
  }

  private render(): void {
    const query = this.search.value.trim().toLowerCase();
    const rules = this.rules
      .filter(
        rule =>
          !query ||
          rule.alert.toLowerCase().includes(query) ||
          rule.expr.toLowerCase().includes(query),
      )
      .sort((left, right) => {
        const result = String(left[this.sort]).localeCompare(
          String(right[this.sort]),
        );
        return this.sortDirection === "asc" ? result : -result;
      });
    this.count.textContent = `${rules.length} / ${this.rules.length} rules`;
    this.table.setRows(rules, this.columns, "No alert rules match the filter");
  }

  private ruleColumns(): DataColumn<AlertRuleConfig>[] {
    return [
      {
        id: "enabled",
        label: "",
        width: "52px",
        render: rule => {
          const enabled = document.createElement("input");
          enabled.type = "checkbox";
          enabled.checked = rule.enabled;
          enabled.setAttribute("aria-label", `Enable ${rule.alert}`);
          enabled.addEventListener("change", async () => {
            await this.context.actions.updateRule(rule.alert, {
              ...rule,
              enabled: enabled.checked,
            });
            await this.load();
          });
          return enabled;
        },
      },
      {
        id: "alert",
        label: "Alert",
        sortValue: "alert",
        width: "260px",
        pinned: true,
        render: rule => rule.alert,
      },
      {
        id: "level",
        label: "Level",
        sortValue: "level",
        width: "110px",
        render: rule => rule.level,
      },
      {
        id: "expr",
        label: "Expression",
        sortValue: "expr",
        width: "620px",
        render: rule => rule.expr,
      },
      {
        id: "actions",
        label: "",
        width: "120px",
        render: rule => {
          const actions = document.createElement("div");
          actions.className = "row-actions";
          actions.append(
            action("Edit", () => this.openEditor(rule)),
            action("Delete", () => void this.remove(rule)),
          );
          return actions;
        },
      },
    ];
  }

  private openEditor(rule?: AlertRuleConfig): void {
    this.editing = rule ?? null;
    const fields = this.editor.elements as typeof this.editor.elements & {
      alert: HTMLInputElement;
      expr: HTMLInputElement;
      level: HTMLSelectElement;
      title: HTMLInputElement;
      message: HTMLTextAreaElement;
      enabled: HTMLInputElement;
    };
    fields.alert.value = rule?.alert ?? "";
    fields.alert.disabled = rule !== undefined;
    fields.expr.value = rule?.expr ?? "";
    fields.level.value = rule?.level ?? "warning";
    fields.title.value = rule?.title ?? "";
    fields.message.value = rule?.message ?? "";
    fields.enabled.checked = rule?.enabled ?? true;
    this.editor.querySelector("output")!.textContent = "";
    this.editor.hidden = false;
    fields.alert.focus();
  }

  private async save(): Promise<void> {
    const data = new FormData(this.editor);
    const alert = this.editing?.alert ?? String(data.get("alert") ?? "");
    const rule: AlertRuleConfig = {
      ...(this.editing ?? {
        for: 1,
        mode: "level",
        cooldown: 300,
        notify_recovery: true,
      }),
      alert,
      expr: String(data.get("expr") ?? ""),
      level: String(data.get("level") ?? "warning"),
      title: String(data.get("title") ?? ""),
      message: String(data.get("message") ?? ""),
      enabled: data.get("enabled") === "on",
    };
    try {
      if (this.editing) {
        await this.context.actions.updateRule(this.editing.alert, rule);
      } else {
        await this.context.actions.createRule(rule);
      }
      this.editor.hidden = true;
      await this.load();
    } catch (error) {
      this.editor.querySelector("output")!.textContent = String(error);
    }
  }

  private async remove(rule: AlertRuleConfig): Promise<void> {
    if (!window.confirm(`Delete alert rule ${rule.alert}?`)) return;
    await this.context.actions.deleteRule(rule.alert);
    await this.load();
  }
}

function action(label: string, handler: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "table-action";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}
