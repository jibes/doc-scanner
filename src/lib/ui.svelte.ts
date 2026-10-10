export type ToastKind = 'info' | 'good' | 'err';

export interface UiAction {
  label: string;
  run: () => void;
}

export const ui = $state({
  busy: null as null | { label: string; progress: number | null; action?: UiAction },
  toast: null as null | { message: string; kind: ToastKind; key: number; action?: UiAction },
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a message; with `action`, a button (e.g. "Undo") stays a little longer. */
export function toast(message: string, kind: ToastKind = 'info', action?: UiAction): void {
  ui.toast = { message, kind, key: Date.now(), action };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast = null), action ? 6000 : kind === 'err' ? 6000 : 3200);
}

export function dismissToast(): void {
  clearTimeout(toastTimer);
  ui.toast = null;
}

export function busy(label: string, progress: number | null = null, action?: UiAction): void {
  ui.busy = { label, progress, action };
}

export function idle(): void {
  ui.busy = null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
