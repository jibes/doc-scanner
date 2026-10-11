import { exportPhase, onExportStatus, prefetchReadsText, type ExportPhase } from './exportCache';
import type { AppSettings } from './settings';
import type { Page } from './store/session.svelte';

/*
 * The export cache's progress, made reactive: reading any of these in a
 * component or `$derived` re-runs it whenever a page's export state changes.
 */

const status = $state({ version: 0 });
onExportStatus(() => status.version++);

export type { ExportPhase };

export function phaseOf(page: Page, settings: AppSettings): ExportPhase {
  void status.version;
  return exportPhase(page, settings);
}

export function readsTextInBackground(): boolean {
  void status.version;
  return prefetchReadsText();
}

/**
 * How far one page is towards an export: 0 (nothing done) to 1 (ready), for
 * a PDF that wants its text or not.
 */
export function phaseProgress(phase: ExportPhase, withText: boolean): number {
  switch (phase) {
    case 'queued':
      return 0;
    case 'rendering':
      return withText ? 0.15 : 0.3;
    case 'rendered':
    case 'reading':
      return withText ? 0.5 : 1;
    case 'read':
      return 1;
  }
}

export interface Readiness {
  /** 0 to 1, over all pages. */
  progress: number;
  /** Every page prepared: the export only has to assemble the file. */
  ready: boolean;
}

/** How much of an export (with text or without) is already prepared. */
export function readiness(pages: Page[], settings: AppSettings, withText: boolean): Readiness {
  if (pages.length === 0) return { progress: 0, ready: false };
  let sum = 0;
  for (const page of pages) sum += phaseProgress(phaseOf(page, settings), withText);
  const progress = sum / pages.length;
  return { progress, ready: progress >= 1 };
}
