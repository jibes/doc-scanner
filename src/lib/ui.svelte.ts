export type ToastKind = 'info' | 'good' | 'err';

export interface UiAction {
  label: string;
  run: () => void;
}

/**
 * Work that runs while the app stays usable (an export, an upload), shown as
 * a compact bar rather than the full-screen busy overlay. One at a time.
 */
export interface Task {
  /** What it produces, so the button that started it can show its progress. */
  kind: 'pdf' | 'upload';
  label: string;
  progress: number | null;
  /** A secondary way out, e.g. "Save without text". */
  action?: UiAction;
  /** Stops it; absent once it can no longer be stopped (the file is on its way). */
  cancel?: () => void;
}

export const ui = $state({
  busy: null as null | { label: string; progress: number | null; action?: UiAction },
  task: null as null | Task,
  toast: null as null | { message: string; kind: ToastKind; key: number; action?: UiAction },
  /** Height in px of the current screen's bottom controls: notifications sit just above. */
  dock: 0,
});

/**
 * Mark an element as the screen's bottom controls (`use:dock`): the
 * notification stack keeps clear of it, so it never covers the primary action.
 */
let docked: HTMLElement | null = null;

export function dock(element: HTMLElement): { destroy: () => void } {
  docked = element;
  const observer = new ResizeObserver(() => {
    if (docked === element) ui.dock = element.offsetHeight;
  });
  observer.observe(element);
  ui.dock = element.offsetHeight;
  return {
    destroy() {
      observer.disconnect();
      if (docked !== element) return;
      docked = null;
      ui.dock = 0;
    },
  };
}

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

/** Start a task; returns false (and starts nothing) if one is already running. */
export function startTask(task: Task): boolean {
  if (ui.task) return false;
  ui.task = task;
  return true;
}

/** Update the running task's label, progress and buttons. */
export function updateTask(change: Partial<Omit<Task, 'kind'>>): void {
  if (ui.task) ui.task = { ...ui.task, ...change };
}

export function endTask(): void {
  ui.task = null;
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
