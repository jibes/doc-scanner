export type ToastKind = '' | 'good' | 'err';

interface UiState {
  busy: boolean;
  busyLabel: string;
  toastMessage: string;
  toastKind: ToastKind;
  toastVisible: boolean;
}

export const ui = $state<UiState>({
  busy: false,
  busyLabel: 'Working…',
  toastMessage: '',
  toastKind: '',
  toastVisible: false,
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, kind: ToastKind = ''): void {
  ui.toastMessage = message;
  ui.toastKind = kind;
  ui.toastVisible = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toastVisible = false;
  }, 3600);
}

export function setBusy(busy: boolean, label = 'Working…'): void {
  ui.busy = busy;
  ui.busyLabel = label;
}
