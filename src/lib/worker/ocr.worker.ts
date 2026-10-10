import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import type { RGBAImage } from '../imaging/image';
import { resize } from '../imaging/resample';
import {
  ctcDecode,
  detectionBoxes,
  detectionSize,
  detectionTensor,
  lineWords,
  recognitionInput,
  REC_HEIGHT,
  type OcrWord,
} from '../ocr/paddle';
import type { OcrRequest, OcrResponse } from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<OcrRequest>) => void) | null;
  postMessage: (message: OcrResponse, transfer?: Transferable[]) => void;
  crossOriginIsolated?: boolean;
};

const BASE = `${import.meta.env.BASE_URL}models/`;
/** Long side of the image the detector sees; text lines are ~15 px tall there. */
const DETECT_SIDE = 1280;
/** Lines with less confidence than this are noise, not text. */
const MIN_CONFIDENCE = 0.5;

ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = self.crossOriginIsolated ? 4 : 1;

let models: Promise<{
  det: ort.InferenceSession;
  rec: ort.InferenceSession;
  dict: string[];
}> | null = null;

function load() {
  models ??= (async () => {
    const options: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    };
    const [det, rec, dictText] = await Promise.all([
      ort.InferenceSession.create(`${BASE}ppocrv5-det.onnx`, options),
      ort.InferenceSession.create(`${BASE}ppocrv5-latin-rec.onnx`, options),
      fetch(`${BASE}ppocrv5-latin-dict.txt`).then((r) => r.text()),
    ]);
    const dict = dictText.replace(/\r/g, '').split('\n');
    if (dict.at(-1) === '') dict.pop();
    return { det, rec, dict };
  })();
  models.catch(() => (models = null));
  return models;
}

async function recognise(image: RGBAImage): Promise<OcrWord[]> {
  const { det, rec, dict } = await load();

  const size = detectionSize(image.width, image.height, DETECT_SIDE);
  const small = resize(image, size.width, size.height);
  const detOut = await det.run({
    [det.inputNames[0]]: new ort.Tensor('float32', detectionTensor(small), [
      1,
      3,
      size.height,
      size.width,
    ]),
  });
  const prob = detOut[det.outputNames[0]].data as Float32Array;
  const sx = image.width / size.width;
  const sy = image.height / size.height;
  const boxes = detectionBoxes(prob, size.width, size.height).map((b) => ({
    ...b,
    x0: b.x0 * sx,
    x1: b.x1 * sx,
    y0: b.y0 * sy,
    y1: b.y1 * sy,
  }));

  const words: OcrWord[] = [];
  for (const box of boxes) {
    const input = recognitionInput(image, box);
    const out = await rec.run({
      [rec.inputNames[0]]: new ort.Tensor('float32', input.tensor, [1, 3, REC_HEIGHT, input.width]),
    });
    const logits = out[rec.outputNames[0]];
    const [, steps, classes] = logits.dims as number[];
    const line = ctcDecode(logits.data as Float32Array, steps, classes, dict);
    if (!line.text.trim() || line.confidence < MIN_CONFIDENCE) continue;
    words.push(...lineWords(line, box, steps, input.textWidth / input.width));
  }
  return words;
}

async function handle(request: OcrRequest): Promise<void> {
  const { id } = request;
  try {
    const words = await recognise({
      data: request.data,
      width: request.width,
      height: request.height,
    });
    self.postMessage({ type: 'words', id, words });
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
