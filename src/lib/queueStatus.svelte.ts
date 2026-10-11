/**
 * The offline upload queue as the screens see it: how many uploads wait, and
 * a counter bumped whenever the queue changes a history entry, so History can
 * reload. Updated by the queue's callbacks (started in App.svelte).
 */
export const queueStatus = $state({ waiting: 0, changes: 0 });

export function queueChanged(): void {
  queueStatus.changes++;
}
