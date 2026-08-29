export const APPEARANCE_CHANGED_EVENT = "hostmon:appearance-changed";

export function notifyAppearanceChanged(): void {
  window.dispatchEvent(new Event(APPEARANCE_CHANGED_EVENT));
}
