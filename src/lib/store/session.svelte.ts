import { onPageTurned } from '../exportCache';
import type { Quad } from '../imaging/image';
import type { PageSpec } from '../pipeline';
import { toast } from '../ui.svelte';
import {
  clearPages,
  deletePage,
  deletePages,
  loadPages,
  loadTitle,
  putPage,
  putRecords,
  requestPersistence,
  whenBlocked,
  saveTitle,
  type PageRecord,
} from './db';

export interface Page {
  id: string;
  source: Blob;
  /** Source photo size in pixels. */
  width: number;
  height: number;
  spec: PageSpec;
  detected: Quad | null;
  /** Capture sharpness (imaging/sharpness.ts), or null when not measured. */
  sharpness: number | null;
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Edits are saved together, at most once per this interval, so a slider drag
 * is a handful of small writes rather than one per tick.
 */
const SAVE_DELAY_MS = 300;
/** After a failed save, try again this much later. */
const RETRY_DELAY_MS = 10_000;

function toRecord(page: Page, order: number): PageRecord {
  return {
    id: page.id,
    order,
    width: page.width,
    height: page.height,
    spec: page.spec,
    detected: page.detected,
    sharpness: page.sharpness,
  };
}

function fromStored(stored: PageRecord & { source: Blob }): Page {
  return {
    id: stored.id,
    source: stored.source,
    width: stored.width,
    height: stored.height,
    spec: stored.spec,
    detected: stored.detected,
    sharpness: stored.sharpness ?? null,
  };
}

/**
 * The document being scanned. Pages are replaced, never mutated, so `$state.raw`
 * is enough and the Blobs are never wrapped in proxies.
 */
class Session {
  pages = $state.raw<Page[]>([]);
  title = $state('');
  loaded = $state(false);
  /** Whether `pages` reflects what was saved; until then other saved pages may exist. */
  private restored = false;
  private warnedUnsaved = false;

  async restore(): Promise<void> {
    const [stored, title] = await Promise.all([loadPages(), loadTitle()]);
    if (stored) {
      this.pages = stored.map(fromStored);
      this.title = title;
      this.restored = true;
    } else {
      void this.recover();
    }
    this.loaded = true;
  }

  /**
   * Storage was too slow to answer at startup, so the app started empty.
   * Wait for it, then put the saved pages back in front of any new ones
   * instead of mixing the two in storage.
   */
  private async recover(): Promise<void> {
    const stored = await loadPages(true);
    if (!stored) {
      toast(
        'Saved pages could not be opened, and new ones will not be kept. Export before closing the app.',
        'err',
      );
      return;
    }
    const saved = stored.filter((p) => !this.get(p.id)).map(fromStored);
    this.restored = true;
    if (saved.length > 0) {
      this.pages = [...saved, ...this.pages];
      this.persistOrder();
      toast(
        saved.length === 1
          ? 'Restored 1 page from your last session.'
          : `Restored ${saved.length} pages from your last session.`,
        'info',
      );
    }
    const title = await loadTitle(true);
    if (!this.title) this.title = title;
  }

  /** Pages whose metadata changed since the last save. */
  private dirty = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Bumped whenever the document is discarded, so that an Undo offered for
   * the old document cannot bring its pages into the new one.
   */
  private generation = 0;

  /** Pages whose photo could not be saved; tried again with the next save. */
  private unsavedPhotos = new Set<string>();

  constructor() {
    onPageTurned((read, upright) => this.turned(read, upright));
    whenBlocked(() =>
      toast('Close the app’s other tabs or windows so it can open your saved pages.', 'info'),
    );
    // The app may be killed in the background without another event.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flush();
      });
      addEventListener('pagehide', () => this.flush());
    }
  }

  private reportSaved(saved: boolean): void {
    if (saved || this.warnedUnsaved) return;
    this.warnedUnsaved = true;
    toast('Pages are not being saved on this device. Export them before closing the app.', 'err');
  }

  /** Save a page with its photo, straight away: only for new photos. */
  private persist(page: Page): void {
    const order = this.pages.findIndex((p) => p.id === page.id);
    this.dirty.delete(page.id);
    this.unsavedPhotos.delete(page.id);
    void putPage({ ...toRecord(page, order), source: page.source }).then((saved) => {
      // Only if nothing newer has been saved for this page since.
      if (!saved && this.get(page.id)?.source === page.source) {
        this.unsavedPhotos.add(page.id);
        this.touch([], RETRY_DELAY_MS);
      }
      this.reportSaved(saved);
    });
  }

  /** Save these pages' metadata (spec, position) soon, without their photos. */
  private touch(ids: Iterable<string>, delay = SAVE_DELAY_MS): void {
    for (const id of ids) this.dirty.add(id);
    this.saveTimer ??= setTimeout(() => this.flush(), delay);
  }

  private persistOrder(): void {
    this.touch(this.pages.map((p) => p.id));
  }

  /** Write pending metadata now. */
  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    for (const id of this.unsavedPhotos) {
      const page = this.get(id);
      if (page) this.persist(page);
      else this.unsavedPhotos.delete(id);
    }
    if (this.dirty.size === 0) return;
    const records: PageRecord[] = [];
    this.pages.forEach((page, order) => {
      if (this.dirty.has(page.id)) records.push(toRecord(page, order));
    });
    const ids = records.map((r) => r.id);
    this.dirty.clear();
    void putRecords(records).then((saved) => {
      // Keep them for the next save rather than losing the edits.
      if (!saved)
        this.touch(
          ids.filter((id) => this.get(id)),
          RETRY_DELAY_MS,
        );
      this.reportSaved(saved);
    });
  }

  add(page: Omit<Page, 'id'>): Page {
    const created: Page = { ...page, id: newId() };
    this.pages = [...this.pages, created];
    this.persist(created);
    requestPersistence();
    return created;
  }

  get(id: string): Page | undefined {
    return this.pages.find((p) => p.id === id);
  }

  update(id: string, spec: Partial<PageSpec>): void {
    // A page the user has turned is never turned again by auto-orientation.
    const settled = 'rotation' in spec ? { oriented: true } : {};
    let changed = false;
    this.pages = this.pages.map((p) => {
      if (p.id !== id) return p;
      changed = true;
      return { ...p, spec: { ...p.spec, ...spec, ...settled } };
    });
    if (changed) this.touch([id]);
  }

  /**
   * OCR found a page sideways or upside down (exportCache.ts): turn it, as
   * long as it is still the page that was read (same photo, crop and
   * rotation) and its orientation has not been settled meanwhile.
   */
  private turned(read: Page, upright: Page): void {
    const page = this.get(read.id);
    if (
      !page ||
      page.source !== read.source ||
      page.spec.oriented ||
      page.spec.rotation !== read.spec.rotation ||
      JSON.stringify(page.spec.quad) !== JSON.stringify(read.spec.quad)
    ) {
      return;
    }
    this.pages = this.pages.map((p) =>
      p.id === page.id
        ? { ...p, spec: { ...p.spec, rotation: upright.spec.rotation, oriented: true } }
        : p,
    );
    this.touch([page.id]);
  }

  /** Replace the source photo, e.g. after a retake, keeping the page's position. */
  replaceSource(id: string, source: Omit<Page, 'id' | 'spec'> & { quad: Quad }): void {
    let changed: Page | undefined;
    this.pages = this.pages.map((p) => {
      if (p.id !== id) return p;
      changed = {
        ...p,
        source: source.source,
        width: source.width,
        height: source.height,
        detected: source.detected,
        sharpness: source.sharpness,
        spec: { ...p.spec, quad: source.quad },
      };
      return changed;
    });
    if (changed) this.persist(changed);
  }

  /** Remove a page; returns a function that puts it back where it was. */
  remove(id: string): () => void {
    const index = this.pages.findIndex((p) => p.id === id);
    const page = this.pages[index];
    const generation = this.generation;
    this.pages = this.pages.filter((p) => p.id !== id);
    this.dirty.delete(id);
    void deletePage(id);
    this.persistOrder();
    return () => {
      if (!page || this.generation !== generation || this.get(page.id)) return;
      const next = [...this.pages];
      next.splice(Math.min(index, next.length), 0, page);
      this.pages = next;
      // Its photo was deleted with it.
      this.persist(page);
      this.persistOrder();
    };
  }

  /** Move a page to a new position (drag and drop). */
  moveTo(id: string, index: number): void {
    const from = this.pages.findIndex((p) => p.id === id);
    if (from < 0) return;
    const to = Math.max(0, Math.min(this.pages.length - 1, index));
    if (to === from) return;
    const next = [...this.pages];
    const [page] = next.splice(from, 1);
    next.splice(to, 0, page);
    this.pages = next;
    this.persistOrder();
  }

  /**
   * Give every page the same filter (and adjustments, if given). Returns a
   * function that puts back each page's previous filter and adjustments.
   */
  applyToAll(spec: Pick<PageSpec, 'filter'> & Partial<Pick<PageSpec, 'adjustments'>>): () => void {
    const before = new Map(
      this.pages.map((p) => [p.id, { filter: p.spec.filter, adjustments: p.spec.adjustments }]),
    );
    const generation = this.generation;
    this.pages = this.pages.map((p) => ({
      ...p,
      spec: {
        ...p.spec,
        filter: spec.filter,
        adjustments: spec.adjustments ? { ...spec.adjustments } : p.spec.adjustments,
      },
    }));
    // Undo restores a page only where its filter and adjustments are still
    // the ones applied here (adjustments are replaced, never mutated), so
    // edits made since are kept.
    const applied = new Map(
      this.pages.map((p) => [p.id, { filter: p.spec.filter, adjustments: p.spec.adjustments }]),
    );
    this.persistOrder();
    return () => {
      if (this.generation !== generation) return;
      this.pages = this.pages.map((p) => {
        const old = before.get(p.id);
        const set = applied.get(p.id);
        const unchanged =
          set && p.spec.filter === set.filter && p.spec.adjustments === set.adjustments;
        return old && unchanged ? { ...p, spec: { ...p.spec, ...old } } : p;
      });
      this.persistOrder();
    };
  }

  move(id: string, delta: number): void {
    const from = this.pages.findIndex((p) => p.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= this.pages.length) return;
    const next = [...this.pages];
    const [page] = next.splice(from, 1);
    next.splice(to, 0, page);
    this.pages = next;
    this.persistOrder();
  }

  setTitle(title: string): void {
    this.title = title;
    void saveTitle(title);
  }

  clear(): void {
    this.generation++;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.dirty.clear();
    this.unsavedPhotos.clear();
    // Saved pages that were never restored were never seen: keep them.
    if (this.restored) void clearPages();
    else void deletePages(this.pages.map((p) => p.id));
    this.pages = [];
    this.title = '';
    void saveTitle('');
  }
}

export const session = new Session();
