import type { Detection } from '../detect/heatmap';
import type { Quad } from '../imaging/image';
import type { PdfImage } from '../pdf/writer';
import type { OcrWord } from '../ocr/paddle';
import type {
  DetectorRequest,
  DetectorResponse,
  OcrRequest,
  OcrResponse,
  ProcessorRequest,
  ProcessorResponse,
  RenderJob,
} from './protocol';

type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

/* ------------------------------------------------------------ processor ---- */

type Distribute<T> = T extends unknown ? Omit<T, 'id'> : never;

export class AbortedError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortedError';
  }
}

/**
 * Promise wrapper around the processing worker.
 *
 * Interactive renders go through named channels: each channel has at most one
 * job in the worker and one waiting. A newer request replaces the waiting one
 * (which resolves to null), so dragging a slider never builds a backlog and
 * the last position always gets rendered. Any request can be aborted; a job
 * the worker has not started yet is then skipped.
 */
export class ProcessorClient {
  private readonly worker = new Worker(new URL('./processor.worker.ts', import.meta.url), {
    type: 'module',
  });
  private nextId = 1;
  private pending = new Map<number, Pending<ProcessorResponse>>();
  private channels = new Map<
    string,
    { busy: boolean; waiting: { job: () => Promise<unknown>; cancel: () => void } | null }
  >();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<ProcessorResponse>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'error') {
        pending.reject(
          message.message === 'cancelled' ? new AbortedError() : new Error(message.message),
        );
      } else {
        pending.resolve(message);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'The processing worker crashed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  private send(
    request: Distribute<Exclude<ProcessorRequest, { type: 'cancel' }>>,
    signal?: AbortSignal,
  ): Promise<ProcessorResponse> {
    if (signal?.aborted) return Promise.reject(new AbortedError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id } as ProcessorRequest);
      signal?.addEventListener(
        'abort',
        () => this.worker.postMessage({ type: 'cancel', id } satisfies ProcessorRequest),
        { once: true },
      );
    });
  }

  async render(job: RenderJob, signal?: AbortSignal): Promise<ImageBitmap> {
    const response = await this.send({ type: 'render', ...job }, signal);
    if (response.type !== 'bitmap') throw new Error('Unexpected worker response');
    return response.bitmap;
  }

  async rectified(job: RenderJob, signal?: AbortSignal): Promise<ImageBitmap> {
    const response = await this.send({ type: 'rectified', ...job }, signal);
    if (response.type !== 'bitmap') throw new Error('Unexpected worker response');
    return response.bitmap;
  }

  async encode(job: RenderJob & { jpegQuality: number; ocrEdge?: number }): Promise<{
    image: PdfImage;
    width: number;
    height: number;
    ocr?: { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };
  }> {
    const response = await this.send({ type: 'encode', ...job });
    if (response.type !== 'encoded') throw new Error('Unexpected worker response');
    return response;
  }

  /** Render on a coalescing channel. Resolves to null if a newer request replaced this one. */
  latest<T>(channel: string, job: () => Promise<T>): Promise<T | null> {
    let state = this.channels.get(channel);
    if (!state) {
      state = { busy: false, waiting: null };
      this.channels.set(channel, state);
    }
    const slot = state;
    return new Promise<T | null>((resolve, reject) => {
      const run = async () => {
        slot.busy = true;
        try {
          resolve(await job());
        } catch (error) {
          reject(error);
        } finally {
          slot.busy = false;
          const next = slot.waiting;
          slot.waiting = null;
          if (next) void next.job();
        }
      };
      if (!slot.busy) {
        void run();
        return;
      }
      slot.waiting?.cancel();
      slot.waiting = { job: run, cancel: () => resolve(null) };
    });
  }

  forget(pageId: string): void {
    this.worker.postMessage({ type: 'forget', pageId } satisfies ProcessorRequest);
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/* ------------------------------------------------------------- detector ---- */

export class DetectorClient {
  private readonly worker = new Worker(new URL('./detector.worker.ts', import.meta.url), {
    type: 'module',
  });
  private nextId = 1;
  private pending = new Map<number, Pending<DetectorResponse>>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<DetectorResponse>) => {
        const message = event.data;
        if (message.type === 'ready') return resolve();
        if (message.type === 'init-error') return reject(new Error(message.message));
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.type === 'error') pending.reject(new Error(message.message));
        else pending.resolve(message);
      };
    });
    // Callers that never await `ready` should not see an unhandled rejection.
    this.ready.catch(() => undefined);
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'The detector worker crashed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    this.worker.postMessage({ type: 'init' } satisfies DetectorRequest);
  }

  private send(
    request: Distribute<Exclude<DetectorRequest, { type: 'init' }>>,
    transfer: Transferable[] = [],
  ) {
    const id = this.nextId++;
    return new Promise<DetectorResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...request, id }, transfer);
    });
  }

  /** Detect on a frame already resized to the model input. Takes ownership of the bitmap. */
  async frame(frame: ImageBitmap): Promise<{ detection: Detection | null; ms: number }> {
    const response = await this.send({ type: 'frame', frame }, [frame]);
    if (response.type !== 'frame') throw new Error('Unexpected detector response');
    return response;
  }

  async still(source: Blob): Promise<{
    quad: Quad | null;
    width: number;
    height: number;
    confidence: number;
    sharpness: number;
  }> {
    const response = await this.send({ type: 'still', source });
    if (response.type !== 'still') throw new Error('Unexpected detector response');
    return response;
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/* ------------------------------------------------------------------ ocr ---- */

/** On-device OCR (PaddleOCR), loaded on first use. */
export class OcrClient {
  private readonly worker = new Worker(new URL('./ocr.worker.ts', import.meta.url), {
    type: 'module',
  });
  private nextId = 1;
  private pending = new Map<number, Pending<OcrResponse>>();

  constructor() {
    this.worker.onmessage = (event: MessageEvent<OcrResponse>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.type === 'error') pending.reject(new Error(message.message));
      else pending.resolve(message);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'The OCR worker crashed');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }

  /** Words found in an image, in its pixel coordinates. Takes ownership of `data`. */
  async recognise(image: {
    data: Uint8ClampedArray<ArrayBuffer>;
    width: number;
    height: number;
  }): Promise<OcrWord[]> {
    const id = this.nextId++;
    const response = await new Promise<OcrResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'ocr', id, ...image } satisfies OcrRequest, [
        image.data.buffer,
      ]);
    });
    if (response.type !== 'words') throw new Error('Unexpected OCR response');
    return response.words;
  }
}
