/** Sync now submit control. The label stays “Sync now”; only pending state changes. */
export type IntervalsSyncSubmitButton = {
  disabled: boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

export function markIntervalsSyncPending(button: IntervalsSyncSubmitButton): void {
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
}

/**
 * Back-forward cache restores the disabled submit control.
 * A normal load (`persisted` false) is left alone.
 */
export function restoreIntervalsSyncButton(button: IntervalsSyncSubmitButton, persisted: boolean): void {
  if (!persisted) return;
  button.disabled = false;
  button.removeAttribute("aria-busy");
}
