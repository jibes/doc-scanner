/**
 * Pre- and post-processing for PaddleOCR (PP-OCRv5 mobile) text detection and
 * recognition. Pure functions over typed arrays, so they are unit-tested in
 * Node and run unchanged in the OCR worker.
 */
import { labelComponents } from '../imaging/components';
import type { RGBAImage } from '../imaging/image';
import { resize } from '../imaging/resample';

/** A text region in image pixels. */
export interface TextBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  score: number;
}

/** A recognised word with its box in image pixels. */
export interface OcrWord {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

/* ------------------------------------------------------------ detection ---- */

/** Detector input size: long side at most `maxSide`, both sides multiples of 32. */
export function detectionSize(width: number, height: number, maxSide: number) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(32, Math.round((width * scale) / 32) * 32);
  const h = Math.max(32, Math.round((height * scale) / 32) * 32);
  return { width: w, height: h };
}

/**
 * NCHW float input for the detector: BGR channel order (the models were
 * trained on OpenCV images), ImageNet mean/std normalisation.
 */
export function detectionTensor(image: RGBAImage): Float32Array {
  const { width, height, data } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = (data[p + 2] / 255 - mean[0]) / std[0];
    out[plane + i] = (data[p + 1] / 255 - mean[1]) / std[1];
    out[2 * plane + i] = (data[p] / 255 - mean[2]) / std[2];
  }
  return out;
}

export interface DetectionOptions {
  /** Probability above which a pixel is text. */
  threshold: number;
  /** Minimum mean probability over a region to keep it. */
  boxThreshold: number;
  /** How far to grow each region back out (DB "unclip" ratio). */
  unclip: number;
  /** Regions smaller than this (shortest side, pixels) are dropped. */
  minSize: number;
}

export const DETECTION_DEFAULTS: DetectionOptions = {
  threshold: 0.3,
  boxThreshold: 0.6,
  unclip: 1.6,
  minSize: 3,
};

/**
 * Text boxes from the detector's probability map (DB post-processing).
 *
 * DB predicts shrunken text kernels; each connected region above the
 * threshold is one text segment, grown back out by area * ratio / perimeter.
 * Pages here are already rectified, so axis-aligned boxes are enough.
 */
export function detectionBoxes(
  prob: Float32Array,
  width: number,
  height: number,
  options: DetectionOptions = DETECTION_DEFAULTS,
): TextBox[] {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > options.threshold ? 1 : 0;
  const { labels, areas } = labelComponents(mask, width, height);
  const n = areas.length;
  const minX = new Int32Array(n).fill(width);
  const minY = new Int32Array(n).fill(height);
  const maxX = new Int32Array(n).fill(-1);
  const maxY = new Int32Array(n).fill(-1);
  const sum = new Float64Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const l = labels[i];
      if (!l) continue;
      if (x < minX[l]) minX[l] = x;
      if (x > maxX[l]) maxX[l] = x;
      if (y < minY[l]) minY[l] = y;
      if (y > maxY[l]) maxY[l] = y;
      sum[l] += prob[i];
    }
  }

  const boxes: TextBox[] = [];
  for (let l = 1; l < n; l++) {
    if (!areas[l]) continue;
    const w = maxX[l] - minX[l] + 1;
    const h = maxY[l] - minY[l] + 1;
    if (Math.min(w, h) < options.minSize) continue;
    const score = sum[l] / areas[l];
    if (score < options.boxThreshold) continue;
    const grow = (w * h * options.unclip) / (2 * (w + h));
    boxes.push({
      x0: Math.max(0, minX[l] - grow),
      y0: Math.max(0, minY[l] - grow),
      x1: Math.min(width, maxX[l] + 1 + grow),
      y1: Math.min(height, maxY[l] + 1 + grow),
      score,
    });
  }
  // Reading order: top to bottom, then left to right within a line.
  boxes.sort((a, b) => {
    const sameLine = Math.abs((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) < (a.y1 - a.y0) / 2;
    return sameLine ? a.x0 - b.x0 : a.y0 - b.y0;
  });
  return boxes;
}

/* ---------------------------------------------------------- recognition ---- */

export const REC_HEIGHT = 48;
/** Very long lines are split by the detector anyway; cap the input width. */
const REC_MAX_WIDTH = 2400;

/**
 * Recogniser input widths are rounded up to one of a few sizes. ONNX Runtime
 * prepares its kernels per input shape, and preparing them costs far more
 * than running them: with free widths every text line is a cold start.
 */
export function recognitionWidth(width: number): number {
  const w = Math.min(REC_MAX_WIDTH, width);
  let bucket = 160;
  while (bucket < w) bucket = Math.round((bucket * 1.4) / 32) * 32;
  return Math.min(REC_MAX_WIDTH, bucket);
}

/**
 * A text box cropped and scaled to the recogniser's height, padded on the
 * right with blank paper to a bucketed width (see `recognitionWidth`).
 * `width` is the padded input width; `textWidth` the part holding the line.
 */
export function recognitionInput(
  image: RGBAImage,
  box: TextBox,
): { tensor: Float32Array; width: number; textWidth: number; crop: RGBAImage } {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(image.width, Math.ceil(box.x1));
  const y1 = Math.min(image.height, Math.ceil(box.y1));
  const cw = Math.max(1, x1 - x0);
  const ch = Math.max(1, y1 - y0);
  const textWidth = Math.max(
    REC_HEIGHT / 2,
    Math.min(REC_MAX_WIDTH, Math.round((REC_HEIGHT * cw) / ch)),
  );
  const width = recognitionWidth(textWidth);
  const crop = resize(cropImage(image, x0, y0, cw, ch), textWidth, REC_HEIGHT);
  const plane = width * REC_HEIGHT;
  // Start as white paper (1.0 after scaling), then copy the line in.
  const tensor = new Float32Array(3 * plane).fill(1);
  for (let y = 0; y < REC_HEIGHT; y++) {
    for (let x = 0; x < textWidth; x++) {
      const i = y * width + x;
      const p = (y * textWidth + x) * 4;
      // BGR, scaled to [-1, 1].
      tensor[i] = crop.data[p + 2] / 127.5 - 1;
      tensor[plane + i] = crop.data[p + 1] / 127.5 - 1;
      tensor[2 * plane + i] = crop.data[p] / 127.5 - 1;
    }
  }
  return { tensor, width, textWidth, crop };
}

function cropImage(image: RGBAImage, x0: number, y0: number, w: number, h: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * image.width + x0) * 4;
    data.set(image.data.subarray(from, from + w * 4), y * w * 4);
  }
  return { data, width: w, height: h };
}

export interface DecodedLine {
  text: string;
  confidence: number;
  /** Timestep at which each character of `text` was emitted. */
  steps: number[];
}

/**
 * Greedy CTC decoding. Class 0 is the CTC blank, classes 1..dict.length are
 * the dictionary, and the class after that is a space.
 */
export function ctcDecode(
  probs: Float32Array,
  steps: number,
  classes: number,
  dict: string[],
): DecodedLine {
  let text = '';
  const at: number[] = [];
  let sum = 0;
  let previous = -1;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bestP = -Infinity;
    for (let c = 0; c < classes; c++) {
      const p = probs[t * classes + c];
      if (p > bestP) {
        bestP = p;
        best = c;
      }
    }
    if (best !== 0 && best !== previous) {
      text += best <= dict.length ? dict[best - 1] : ' ';
      at.push(t);
      sum += bestP;
    }
    previous = best;
  }
  return { text, confidence: at.length ? sum / at.length : 0, steps: at };
}

/**
 * Split a recognised line into words with boxes in image pixels, placing each
 * character at the horizontal position of the timestep that emitted it.
 */
export function lineWords(
  line: DecodedLine,
  box: TextBox,
  steps: number,
  /** Fraction of the input width that holds the line (the rest is padding). */
  filled = 1,
): OcrWord[] {
  const words: OcrWord[] = [];
  const width = box.x1 - box.x0;
  const xAt = (t: number) => box.x0 + ((t + 0.5) / (steps * filled)) * width;
  const half = Math.max(1, width / Math.max(1, line.text.length) / 2);
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    const text = line.text.slice(start, end).trim();
    if (text) {
      words.push({
        text,
        x0: Math.max(box.x0, xAt(line.steps[start]) - half),
        x1: Math.min(box.x1, xAt(line.steps[end - 1]) + half),
        y0: box.y0,
        y1: box.y1,
        confidence: line.confidence,
      });
    }
    start = -1;
  };
  for (let i = 0; i < line.text.length; i++) {
    if (line.text[i] === ' ') flush(i);
    else if (start < 0) start = i;
  }
  flush(line.text.length);
  return words;
}
