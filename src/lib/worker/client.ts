import type { ScanSettings } from '../imaging/pipeline';
import type { Quad, RGBAImage } from '../imaging/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** Thrown when a newer request replaced an in-flight one. Callers should ignore it. */
export class SupersededError extends Error {
  constructor() {
    super('Superseded by a newer request');
    this.name = 'SupersededError';
  }
}

interface Pending {
  id: number;
  resolve: (image: RGBAImage) => void;
  reject: (error: Error) => void;
  onStage?: (stage: string) => void;
}

/**
 * Promise wrapper around the processing worker.
 *
 * Only one request is in flight at a time: dragging a slider produces a stream
 * of settings, and only the newest one is worth computing. Starting a new
 * request rejects the previous one with {@link SupersededError}.
 */
export class ProcessorClient {
  private readonly worker: Worker;
  private nextId = 1;
  private pending: Pending | null = null;

  constructor() {
    this.worker = new Worker(new URL('./processor.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
    this.worker.onerror = (event) => {
      const pending = this.pending;
      this.pending = null;
      pending?.reject(new Error(event.message || 'The processing worker crashed'));
    };
  }

  /** Rectify a quad of the source image into an axis-aligned page. */
  warp(image: RGBAImage, quad: Quad, maxLongEdge: number): Promise<RGBAImage> {
    return this.send({
      id: this.nextId++,
      type: 'warp',
      image: { data: image.data.slice(), width: image.width, height: image.height },
      quad,
      maxLongEdge,
    });
  }

  /** Run the cleanup pipeline over an already-rectified page. */
  process(
    image: RGBAImage,
    settings: ScanSettings,
    onStage?: (stage: string) => void,
  ): Promise<RGBAImage> {
    return this.send(
      {
        id: this.nextId++,
        type: 'process',
        image: { data: image.data.slice(), width: image.width, height: image.height },
        settings,
      },
      onStage,
    );
  }

  cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.reject(new SupersededError());
  }

  dispose(): void {
    this.cancel();
    this.worker.terminate();
  }

  private send(request: WorkerRequest, onStage?: (stage: string) => void): Promise<RGBAImage> {
    this.cancel();
    return new Promise<RGBAImage>((resolve, reject) => {
      this.pending = { id: request.id, resolve, reject, onStage };
      // The caller keeps its buffer; the copy is transferred to the worker.
      this.worker.postMessage(request, [request.image.data.buffer]);
    });
  }

  private handle(message: WorkerResponse): void {
    const pending = this.pending;
    if (!pending || pending.id !== message.id) return;

    if (message.type === 'stage') {
      pending.onStage?.(message.stage);
      return;
    }

    this.pending = null;
    if (message.type === 'result') {
      pending.resolve({
        data: message.image.data,
        width: message.image.width,
        height: message.image.height,
      });
    } else {
      pending.reject(new Error(message.message));
    }
  }
}
