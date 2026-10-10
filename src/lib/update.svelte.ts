import { registerSW } from 'virtual:pwa-register';
import { session } from './store/session.svelte';

/** How often an app left open looks for a new version. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * A new version of the app. It never takes over by itself: a running page
 * would lose the worker scripts it has yet to load. Instead the user is
 * offered a reload, which applies it at a moment of their choosing.
 *
 * - `ready`: downloaded and waiting; "Reload" applies it.
 * - `applied`: another window applied it; this one should reload too.
 */
export const update = $state({ ready: false, applied: false });

let apply: ((reload?: boolean) => Promise<void>) | null = null;
let applying = false;

export function startUpdates(): void {
  if (!('serviceWorker' in navigator)) return;
  apply = registerSW({
    immediate: true,
    onNeedRefresh: () => (update.ready = true),
    onRegisteredSW: (_url, registration) => {
      if (!registration) return;
      const check = () => void registration.update().catch(() => undefined);
      setInterval(check, CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });
  // Applied from another window of the app: this one now runs on a new
  // service worker with the old files gone, so it should reload soon.
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controlled && !applying) {
      update.ready = false;
      update.applied = true;
    }
    controlled = true;
  });
}

/** Switch to the new version and reload, after saving pending edits. */
export async function applyUpdate(): Promise<void> {
  session.flush();
  // Give the batched IndexedDB write a moment to land before the reload.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (update.applied || !apply) {
    location.reload();
    return;
  }
  applying = true;
  await apply(true);
}

export function dismissUpdate(): void {
  update.ready = false;
  update.applied = false;
}
