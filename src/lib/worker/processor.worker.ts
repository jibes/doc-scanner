import { processImage } from '../imaging/pipeline';
import { rectify } from '../imaging/warp';
import type { SerializedImage, WorkerRequest, WorkerResponse } from './protocol';

// Declared locally rather than pulling in the `webworker` lib, which conflicts
// with the DOM lib the rest of the app needs.
declare const self: {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
};

function postResult(id: number, image: SerializedImage): void {
  self.postMessage({ id, type: 'result', image }, [image.data.buffer]);
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    if (request.type === 'warp') {
      postResult(request.id, rectify(request.image, request.quad, request.maxLongEdge));
      return;
    }

    const result = processImage(request.image, request.settings, (stage) => {
      self.postMessage({ id: request.id, type: 'stage', stage });
    });
    postResult(request.id, result);
  } catch (error) {
    self.postMessage({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
