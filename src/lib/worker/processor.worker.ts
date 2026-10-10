import { applyFilter, isGrayFilter, type FilterId } from '../imaging/filters';
import type { RGBAImage } from '../imaging/image';
import { pngPredict } from '../pdf/predict';
import type { PdfImage } from '../pdf/writer';
import { filterContext, rectifyPage, type PageSpec } from '../pipeline';
import { decodeImage, rgbaToImageData } from './decode';
import type { ProcessorRequest, ProcessorResponse } from './protocol';

declare const self: {
  onmessage: ((event: MessageEvent<ProcessorRequest>) => void) | null;
  postMessage: (message: ProcessorResponse, transfer?: Transferable[]) => void;
};

/*
 * Small caches so that moving a slider only re-runs the filter, not the decode
 * and the warp. Sizes are deliberately tiny: a decoded 12 MP photo is ~48 MB.
 */
const sources = new Map<string, { blob: Blob; image: RGBAImage }>();
const rectified = new Map<string, RGBAImage>();
const MAX_SOURCES = 2;
const MAX_RECTIFIED = 3;

function touch<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

async function getSource(pageId: string, blob: Blob): Promise<RGBAImage> {
  const hit = sources.get(pageId);
  if (hit && hit.blob === blob) {
    touch(sources, pageId, hit, MAX_SOURCES);
    return hit.image;
  }
  const image = await decodeImage(blob);
  touch(sources, pageId, { blob, image }, MAX_SOURCES);
  return image;
}

async function getRectified(
  pageId: string,
  blob: Blob,
  spec: PageSpec,
  longEdge: number,
  cache = true,
): Promise<RGBAImage> {
  const key = `${pageId}|${spec.quad
    .flat()
    .map((v) => v.toFixed(2))
    .join(',')}|${spec.rotation}|${longEdge}`;
  const hit = rectified.get(key);
  if (hit) {
    touch(rectified, key, hit, MAX_RECTIFIED);
    return hit;
  }
  const page = rectifyPage(await getSource(pageId, blob), spec, longEdge);
  if (cache) touch(rectified, key, page, MAX_RECTIFIED);
  return page;
}

async function toBitmap(image: RGBAImage): Promise<ImageBitmap> {
  return createImageBitmap(rgbaToImageData(image));
}

async function deflate(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  // 'deflate' is the zlib format, which is exactly what PDF's FlateDecode expects.
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True when every pixel is neutral grey, so one channel holds all of it. */
function isNeutral(image: RGBAImage): boolean {
  const d = image.data;
  for (let p = 0; p < d.length; p += 4) {
    if (d[p] !== d[p + 1] || d[p + 1] !== d[p + 2]) return false;
  }
  return true;
}

/**
 * Lossless (PNG-predicted Flate) for the clean filters: their output is flat
 * white with crisp ink, which JPEG would both bloat and ring around. JPEG only
 * for the photographic ones.
 */
async function encodeForPdf(
  image: RGBAImage,
  filter: FilterId,
  quality: number,
): Promise<PdfImage> {
  if (filter === 'color' || filter === 'original') {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a 2D canvas context');
    ctx.putImageData(rgbaToImageData(image), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    return { kind: 'jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), components: 3 };
  }

  const gray = isGrayFilter(filter) || isNeutral(image);
  const channels = gray ? 1 : 3;
  const samples = new Uint8Array(image.width * image.height * channels);
  for (let i = 0, p = 0; p < image.data.length; p += 4) {
    samples[i++] = image.data[p];
    if (!gray) {
      samples[i++] = image.data[p + 1];
      samples[i++] = image.data[p + 2];
    }
  }
  // Clean output is mostly flat runs, which plain deflate already handles
  // best; PNG prediction only pays off where there are smooth tones. Measure
  // rather than guess.
  const [plain, predicted] = await Promise.all([
    deflate(samples),
    deflate(pngPredict(samples, image.width, image.height, channels)),
  ]);
  return predicted.length < plain.length
    ? { kind: 'flate', bytes: predicted, components: channels, predictor: true }
    : { kind: 'flate', bytes: plain, components: channels, predictor: false };
}

async function handle(request: ProcessorRequest): Promise<void> {
  if (request.type === 'forget') {
    sources.delete(request.pageId);
    for (const key of [...rectified.keys()]) {
      if (key.startsWith(`${request.pageId}|`)) rectified.delete(key);
    }
    return;
  }

  const { id } = request;
  try {
    // Export renders are one-off and large; caching them would only pin memory.
    const page = await getRectified(
      request.pageId,
      request.source,
      request.spec,
      request.longEdge,
      request.type !== 'encode',
    );
    if (request.type === 'rectified') {
      const bitmap = await toBitmap(page);
      self.postMessage({ type: 'bitmap', id, bitmap }, [bitmap]);
      return;
    }
    const { spec, longEdge } = request;
    const result = applyFilter(
      page,
      spec.filter,
      spec.adjustments,
      filterContext(spec.quad, longEdge, await getSource(request.pageId, request.source)),
    );
    if (request.type === 'render') {
      const bitmap = await toBitmap(result);
      self.postMessage({ type: 'bitmap', id, bitmap }, [bitmap]);
      return;
    }
    const image = await encodeForPdf(result, spec.filter, request.jpegQuality);
    self.postMessage({ type: 'encoded', id, image, width: result.width, height: result.height }, [
      image.bytes.buffer,
    ]);
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Serialise: one job at a time, in order.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event) => {
  queue = queue.then(() => handle(event.data));
};
