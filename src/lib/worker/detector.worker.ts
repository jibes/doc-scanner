import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { heatmapsToQuad, type Detection } from '../detect/heatmap';
import { toLuma, type Quad } from '../imaging/image';
import { scaleQuad } from '../imaging/quad';
import { refineQuad } from '../imaging/refine';
import { MODEL_INPUT } from '../detect/model';
import type { DetectorRequest, DetectorResponse } from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<DetectorRequest>) => void) | null;
  postMessage: (message: DetectorResponse, transfer?: Transferable[]) => void;
  crossOriginIsolated?: boolean;
};

const MODEL_URL = `${import.meta.env.BASE_URL}models/docaligner-lc100.onnx`;
/** Long edge of the image the corners are refined on. */
const REFINE_EDGE = 1600;

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
// Threads need cross-origin isolation, which static hosts like GitHub Pages
// cannot provide. Single-threaded SIMD is fast enough for a 1.6 GFLOP model.
ort.env.wasm.numThreads = self.crossOriginIsolated ? 4 : 1;

let session: ort.InferenceSession | null = null;

async function init(): Promise<void> {
  try {
    session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    self.postMessage({ type: 'ready', backend: 'wasm' });
  } catch (error) {
    self.postMessage({
      type: 'init-error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The model was trained on images loaded with OpenCV, i.e. BGR channel order,
 * scaled to 0..1, NCHW.
 */
function toTensor(rgba: Uint8ClampedArray): ort.Tensor {
  const plane = MODEL_INPUT * MODEL_INPUT;
  const input = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    input[i] = rgba[p + 2] / 255;
    input[plane + i] = rgba[p + 1] / 255;
    input[2 * plane + i] = rgba[p] / 255;
  }
  return new ort.Tensor('float32', input, [1, 3, MODEL_INPUT, MODEL_INPUT]);
}

async function infer(bitmap: ImageBitmap): Promise<Detection | null> {
  if (!session) throw new Error('The detector is not loaded');
  const canvas = new OffscreenCanvas(MODEL_INPUT, MODEL_INPUT);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.drawImage(bitmap, 0, 0, MODEL_INPUT, MODEL_INPUT);
  const pixels = ctx.getImageData(0, 0, MODEL_INPUT, MODEL_INPUT).data;
  const output = await session.run({ [session.inputNames[0]]: toTensor(pixels) });
  const heat = output[session.outputNames[0]];
  const size = heat.dims[3];
  return heatmapsToQuad(heat.data as Float32Array, size);
}

async function detectStill(source: Blob): Promise<{
  quad: Quad | null;
  width: number;
  height: number;
  confidence: number;
}> {
  // Decode once; the model and the refinement both draw from this bitmap.
  const full = await createImageBitmap(source, { imageOrientation: 'from-image' });
  const { width, height } = full;
  try {
    const detection = await infer(full);
    if (!detection) return { quad: null, width, height, confidence: 0 };

    const scale = Math.min(1, REFINE_EDGE / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create a 2D canvas context');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(full, 0, 0, w, h);
    const work = { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };

    const refined = refineQuad(toLuma(work), scaleQuad(detection.quad, w, h));
    return {
      quad: scaleQuad(refined, width / w, height / h),
      width,
      height,
      confidence: detection.confidence,
    };
  } finally {
    full.close();
  }
}

async function handle(request: DetectorRequest): Promise<void> {
  if (request.type === 'init') return init();
  const { id } = request;
  try {
    if (request.type === 'frame') {
      const start = performance.now();
      const detection = await infer(request.frame);
      request.frame.close();
      self.postMessage({ type: 'frame', id, detection, ms: performance.now() - start });
      return;
    }
    const result = await detectStill(request.source);
    self.postMessage({ type: 'still', id, ...result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

let queue: Promise<void> = Promise.resolve();
self.onmessage = (event) => {
  queue = queue.then(() => handle(event.data));
};
