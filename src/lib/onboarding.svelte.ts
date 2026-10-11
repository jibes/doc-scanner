/**
 * "Install app": the browser's install prompt where there is one (Chrome,
 * Edge, Brave, Samsung Internet), a one-time "Add to Home Screen" hint on
 * iOS, and nothing once the app runs installed or the offer was dismissed.
 */

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISSED_KEY = 'doc-scanner:install-dismissed';
const TIPS_KEY = 'doc-scanner:tips-seen';

function read(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Private mode: shown again next time, which is harmless.
  }
}

/** Running as the installed app. */
export function isStandalone(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches
  );
}

/** iPhone or iPad Safari, where installing is "Share → Add to Home Screen". */
export function isIos(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints): boolean {
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  // iPadOS reports itself as a Mac.
  return /Macintosh/.test(ua) && touchPoints > 1;
}

export const install = $state({
  /** What to offer: the browser prompt, the iOS hint, or nothing. */
  offer: null as null | 'prompt' | 'ios',
  /** The first-run tips have been seen. */
  tipsSeen: true,
});

let deferred: InstallPromptEvent | null = null;

/** Listen from the very start: the browser offers its prompt only once, early. */
export function startInstall(): void {
  install.tipsSeen = read(TIPS_KEY);
  if (isStandalone() || read(DISMISSED_KEY)) return;
  if (isIos()) install.offer = 'ios';
  addEventListener('beforeinstallprompt', (event) => {
    // Keep the browser's own mini-infobar away; the app offers it quietly.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    if (!read(DISMISSED_KEY)) install.offer = 'prompt';
  });
  addEventListener('appinstalled', () => {
    deferred = null;
    install.offer = null;
  });
}

/** Show the browser's install dialog. */
export async function promptInstall(): Promise<void> {
  const event = deferred;
  if (!event) return;
  deferred = null;
  install.offer = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'dismissed') remember(DISMISSED_KEY);
}

export function dismissInstall(): void {
  install.offer = null;
  remember(DISMISSED_KEY);
}

export function dismissTips(): void {
  install.tipsSeen = true;
  remember(TIPS_KEY);
}
