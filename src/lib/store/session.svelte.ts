import type { Quad } from '../imaging/image';
import type { PageSpec } from '../pipeline';
import {
  clearPages,
  deletePage,
  loadPages,
  loadTitle,
  putPage,
  saveTitle,
  type StoredPage,
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
 * The document being scanned. Pages are replaced, never mutated, so `$state.raw`
 * is enough and the Blobs are never wrapped in proxies.
 */
class Session {
  pages = $state.raw<Page[]>([]);
  title = $state('');
  loaded = $state(false);

  async restore(): Promise<void> {
    const [stored, title] = await Promise.all([loadPages(), loadTitle()]);
    this.pages = stored.map((stored) => ({
      id: stored.id,
      source: stored.source,
      width: stored.width,
      height: stored.height,
      spec: stored.spec,
      detected: stored.detected,
      sharpness: stored.sharpness ?? null,
    }));
    this.title = title;
    this.loaded = true;
  }

  private persist(page: Page): void {
    const order = this.pages.findIndex((p) => p.id === page.id);
    void putPage({ ...page, order } satisfies StoredPage);
  }

  private persistOrder(): void {
    for (const page of this.pages) this.persist(page);
  }

  add(page: Omit<Page, 'id'>): Page {
    const created: Page = { ...page, id: newId() };
    this.pages = [...this.pages, created];
    this.persist(created);
    return created;
  }

  get(id: string): Page | undefined {
    return this.pages.find((p) => p.id === id);
  }

  update(id: string, spec: Partial<PageSpec>): void {
    let changed: Page | undefined;
    this.pages = this.pages.map((p) => {
      if (p.id !== id) return p;
      changed = { ...p, spec: { ...p.spec, ...spec } };
      return changed;
    });
    if (changed) this.persist(changed);
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
    this.pages = this.pages.filter((p) => p.id !== id);
    void deletePage(id);
    this.persistOrder();
    return () => {
      if (!page || this.get(page.id)) return;
      const next = [...this.pages];
      next.splice(Math.min(index, next.length), 0, page);
      this.pages = next;
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

  /** Give every page the same filter and adjustments. */
  applyToAll(spec: Pick<PageSpec, 'filter' | 'adjustments'>): void {
    this.pages = this.pages.map((p) => ({
      ...p,
      spec: { ...p.spec, filter: spec.filter, adjustments: { ...spec.adjustments } },
    }));
    this.persistOrder();
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
    this.pages = [];
    this.title = '';
    void clearPages();
    void saveTitle('');
  }
}

export const session = new Session();
