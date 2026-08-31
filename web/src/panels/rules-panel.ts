import type {
  AlertRuleConfig,
  RulesPanelDefinition,
} from "../domain/types";
import type { PanelContext, PanelRenderer } from "./panel";
import { panelShell } from "./panel";
import {
  compareByPath,
  configuredColumns,
  DataTable,
  type DataColumn,
  type SortDirection,
} from "./data-table";
import { formatItemCount, tableFooter } from "./table-controls";

export class RulesPanel implements PanelRenderer {
  readonly element: HTMLElement;
  private readonly table: DataTable<AlertRuleConfig>;
  private readonly columns: DataColumn<AlertRuleConfig>[];
  private readonly search: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly editor: HTMLFormElement;
  private readonly feedback: HTMLOutputElement;
  private rules: AlertRuleConfig[] = [];
  private editing: AlertRuleConfig | null = null;
  private sort = "alert";
  private sortDirection: SortDirection = "asc";
  private loading = false;
  private loadFailed = false;

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
    this.search.addEventListener("input", () => {
      this.table.scrollToTop();
      this.render();
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "button button-primary";
    add.textContent = "Add rule";
    add.addEventListener("click", () => this.openEditor());
    this.count = document.createElement("span");
    this.count.className = "table-count";
    controls.append(this.search, add);
    this.columns = configuredColumns(
      definition.columns ?? [],
      {
        enabled: rule => {
          const enabled = document.createElement("input");
          enabled.type = "checkbox";
          enabled.checked = rule.enabled;
          enabled.setAttribute("aria-label", `Enable ${rule.alert}`);
          enabled.addEventListener("change", async () => {
            const requested = enabled.checked;
            enabled.disabled = true;
            this.clearFeedback();
            try {
              await this.context.actions.updateRule(rule.alert, {
                ...rule,
                enabled: requested,
              });
              this.rules = this.rules.map(item =>
                item.alert === rule.alert
                  ? {...item, enabled: requested}
                  : item,
              );
              this.render();
            } catch (error) {
              enabled.checked = rule.enabled;
              this.showFeedback(`Could not update ${rule.alert}`, error);
            } finally {
              enabled.disabled = false;
            }
          });
          return enabled;
        },
        actions: rule => {
          const actions = document.createElement("div");
          actions.className = "row-actions";
          actions.append(
            action("Edit", () => this.openEditor(rule)),
            action("Delete", button => void this.remove(rule, button)),
          );
          return actions;
        },
      },
    );
    this.table = new DataTable(
      this.columns,
      "rules-table",
      (value, direction) => {
        this.sort = value;
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
      <label class="rule-title">Title<input name="title" required></label>
      <label class="rule-message">Message<textarea name="message" required></textarea></label>
      <label class="rule-enabled"><input name="enabled" type="checkbox"> Enabled</label>
      <div class="rule-editor-actions"><button type="button" class="button">Cancel</button><button class="button button-primary" type="submit">Save rule</button></div>
      <output role="alert" aria-live="polite"></output>
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
    this.feedback = document.createElement("output");
    this.feedback.className = "rules-feedback";
    this.feedback.setAttribute("role", "alert");
    this.feedback.setAttribute("aria-live", "polite");
    this.feedback.hidden = true;
    shell.body.append(
      controls,
      this.feedback,
      this.editor,
      this.table.element,
    );
    void this.load();
  }

  update(): void {
    if (this.loadFailed) void this.load();
  }

  refresh(): void {
    void this.load();
  }

  destroy(): void {}

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.rules = await this.context.actions.loadRules();
      this.loadFailed = false;
      this.clearFeedback();
      this.render();
    } catch (error) {
      this.loadFailed = true;
      this.showFeedback("Could not load rules", error);
    } finally {
      this.loading = false;
    }
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
      .sort((left, right) =>
        compareByPath(left, right, this.sort, this.sortDirection),
      );
    this.count.textContent =
      `${rules.length} / ${formatItemCount(this.rules.length, "rule")}`;
    this.table.setRows(rules, this.columns, "No alert rules match the filter");
  }

  private openEditor(rule?: AlertRuleConfig): void {
    this.editing = rule ?? null;
    this.clearFeedback();
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
    const save = this.editor.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    save.disabled = true;
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
    } finally {
      save.disabled = false;
    }
  }

  private async remove(
    rule: AlertRuleConfig,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!window.confirm(`Delete alert rule ${rule.alert}?`)) return;
    button.disabled = true;
    this.clearFeedback();
    try {
      await this.context.actions.deleteRule(rule.alert);
      this.rules = this.rules.filter(item => item.alert !== rule.alert);
      this.render();
    } catch (error) {
      this.showFeedback(`Could not delete ${rule.alert}`, error);
    } finally {
      button.disabled = false;
    }
  }

  private clearFeedback(): void {
    this.feedback.textContent = "";
    this.feedback.hidden = true;
  }

  private showFeedback(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.feedback.textContent = `${message}: ${detail}`;
    this.feedback.hidden = false;
  }
}

function action(
  label: string,
  handler: (button: HTMLButtonElement) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "table-action";
  button.textContent = label;
  button.addEventListener("click", () => handler(button));
  return button;
}
