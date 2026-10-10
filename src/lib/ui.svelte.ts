export type ToastKind = 'info' | 'good' | 'err';

export const ui = $state({
  busy: null as null | { label: string; progress: number | null },
  toast: null as null | { message: string; kind: ToastKind; key: number },
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string, kind: ToastKind = 'info'): void {
  ui.toast = { message, kind, key: Date.now() };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast = null), kind === 'err' ? 6000 : 3200);
}

export function busy(label: string, progress: number | null = null): void {
  ui.busy = { label, progress };
}

export function idle(): void {
  ui.busy = null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
