import { createRGBA, type RGBAImage } from './image';

/**
 * Paper-colour estimate on a coarse grid, one RGB sample per block (0..255).
 */
export interface PaperGrid {
  cols: number;
  rows: number;
  /** Block size in source pixels. */
  block: number;
  /** cols * rows * 3 */
  rgb: Float32Array;
}

const BLOCKS_ON_LONG_EDGE = 40;
const SAMPLES_PER_BLOCK_EDGE = 24;
const PAPER_QUANTILE = 0.9;
/** Gain cap, so a deep shadow is lifted without turning sensor noise into speckle. */
const MAX_GAIN = 5;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Estimate the paper colour across the page.
 *
 * Each block reports the mean colour of its brightest 10% of pixels, sampled
 * at full resolution so the gaps between lines of text are seen as paper.
 * Blocks that are not paper (photos, logos, a strip of table at the edge)
 * stand out as darker or differently coloured than their neighbourhood and are
 * dropped, then the holes are filled by diffusion from the surrounding paper.
 *
 * Unlike divide-by-blur, ink never enters the estimate, so text does not get a
 * grey halo and dense paragraphs do not darken the paper around them.
 */
export function estimatePaper(src: RGBAImage): PaperGrid {
  const { width, height, data } = src;
  const block = Math.max(8, Math.ceil(Math.max(width, height) / BLOCKS_ON_LONG_EDGE));
  const cols = Math.ceil(width / block);
  const rows = Math.ceil(height / block);
  const n = cols * rows;
  const rgb = new Float32Array(n * 3);
  const luma = new Float32Array(n);
  const step = Math.max(1, Math.floor(block / SAMPLES_PER_BLOCK_EDGE));

  const lumas: number[] = [];
  const idx: number[] = [];
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      lumas.length = 0;
      idx.length = 0;
      const x1 = Math.min(width, (bx + 1) * block);
      const y1 = Math.min(height, (by + 1) * block);
      for (let y = by * block; y < y1; y += step) {
        for (let x = bx * block; x < x1; x += step) {
          const p = (y * width + x) * 4;
          lumas.push(0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]);
          idx.push(p);
        }
      }
      const sorted = [...lumas].sort((a, b) => a - b);
      const threshold =
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * PAPER_QUANTILE))];
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let i = 0; i < lumas.length; i++) {
        if (lumas[i] < threshold) continue;
        const p = idx[i];
        r += data[p];
        g += data[p + 1];
        b += data[p + 2];
        count++;
      }
      const k = by * cols + bx;
      rgb[k * 3] = r / count;
      rgb[k * 3 + 1] = g / count;
      rgb[k * 3 + 2] = b / count;
      luma[k] = threshold;
    }
  }

  // Reject blocks that are much darker than, or a different colour from, their
  // neighbourhood. Two passes: the second uses only blocks the first accepted.
  const valid = new Uint8Array(n).fill(1);
  const R = 2;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(n);
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const near: number[] = [];
        const nr: number[] = [];
        const ng: number[] = [];
        const nb: number[] = [];
        for (let y = Math.max(0, by - R); y <= Math.min(rows - 1, by + R); y++) {
          for (let x = Math.max(0, bx - R); x <= Math.min(cols - 1, bx + R); x++) {
            const k = y * cols + x;
            if (!valid[k]) continue;
            near.push(luma[k]);
            nr.push(rgb[k * 3]);
            ng.push(rgb[k * 3 + 1]);
            nb.push(rgb[k * 3 + 2]);
          }
        }
        const k = by * cols + bx;
        if (near.length < 3) {
          next[k] = valid[k];
          continue;
        }
        const ml = median(near);
        const dr = rgb[k * 3] / Math.max(1, median(nr));
        const dg = rgb[k * 3 + 1] / Math.max(1, median(ng));
        const db = rgb[k * 3 + 2] / Math.max(1, median(nb));
        const tint = Math.max(dr, dg, db) - Math.min(dr, dg, db);
        next[k] = luma[k] >= 0.85 * ml && tint < 0.12 ? 1 : 0;
      }
    }
    valid.set(next);
  }

  // Fall back to the brightest blocks if the filter rejected nearly everything.
  let validCount = 0;
  for (let k = 0; k < n; k++) validCount += valid[k];
  if (validCount < Math.max(1, n * 0.05)) {
    const cutoff = [...luma].sort((a, b) => b - a)[Math.max(0, Math.floor(n * 0.2) - 1)];
    for (let k = 0; k < n; k++) valid[k] = luma[k] >= cutoff ? 1 : 0;
  }

  // Fill rejected blocks by diffusion (Jacobi iterations of the Laplace equation).
  let mean = [0, 0, 0];
  let m = 0;
  for (let k = 0; k < n; k++) {
    if (!valid[k]) continue;
    mean = [mean[0] + rgb[k * 3], mean[1] + rgb[k * 3 + 1], mean[2] + rgb[k * 3 + 2]];
    m++;
  }
  for (let k = 0; k < n; k++) {
    if (valid[k]) continue;
    for (let c = 0; c < 3; c++) rgb[k * 3 + c] = mean[c] / m;
  }
  const iterations = 2 * Math.max(cols, rows);
  const buf = new Float32Array(rgb);
  for (let it = 0; it < iterations; it++) {
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const k = by * cols + bx;
        if (valid[k]) continue;
        for (let c = 0; c < 3; c++) {
          let s = 0;
          let cnt = 0;
          if (bx > 0) {
            s += rgb[(k - 1) * 3 + c];
            cnt++;
          }
          if (bx < cols - 1) {
            s += rgb[(k + 1) * 3 + c];
            cnt++;
          }
          if (by > 0) {
            s += rgb[(k - cols) * 3 + c];
            cnt++;
          }
          if (by < rows - 1) {
            s += rgb[(k + cols) * 3 + c];
            cnt++;
          }
          buf[k * 3 + c] = s / cnt;
        }
      }
    }
    rgb.set(buf);
  }

  // One light smoothing pass so block boundaries never show up as steps.
  const smooth = new Float32Array(rgb.length);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        let cnt = 0;
        for (let y = Math.max(0, by - 1); y <= Math.min(rows - 1, by + 1); y++) {
          for (let x = Math.max(0, bx - 1); x <= Math.min(cols - 1, bx + 1); x++) {
            s += rgb[(y * cols + x) * 3 + c];
            cnt++;
          }
        }
        smooth[(by * cols + bx) * 3 + c] = s / cnt;
      }
    }
  }

  return { cols, rows, block, rgb: smooth };
}

/**
 * Divide every pixel by the interpolated paper colour, so paper lands on 255
 * and everything else keeps its contrast relative to the paper. Per channel,
 * which also removes a colour cast from warm light or yellowed paper.
 */
export function flattenPaper(src: RGBAImage, grid: PaperGrid = estimatePaper(src)): RGBAImage {
  const { width, height, data } = src;
  const { cols, rows, block, rgb } = grid;
  const out = createRGBA(width, height);
  const od = out.data;
  const row = new Float32Array(cols * 3);

  for (let y = 0; y < height; y++) {
    // Block centres sit at (k + 0.5) * block; interpolate between them.
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const ty = gy - y0;
    for (let i = 0; i < cols * 3; i++) {
      row[i] = rgb[y0 * cols * 3 + i] * (1 - ty) + rgb[y1 * cols * 3 + i] * ty;
    }
    for (let x = 0; x < width; x++) {
      const gx = Math.min(cols - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(cols - 1, x0 + 1);
      const tx = gx - x0;
      const p = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const bg = row[x0 * 3 + c] * (1 - tx) + row[x1 * 3 + c] * tx;
        const gain = Math.min(MAX_GAIN, 255 / Math.max(1, bg));
        od[p + c] = data[p + c] * gain;
      }
      od[p + 3] = 255;
    }
  }
  return out;
}
