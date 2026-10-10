import { boxFilter } from './filters';
import type { Mask } from './types';

/** 3x3 erosion. Shrinks bright regions. */
export function erode3(mask: Mask, width: number, height: number): Mask {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < height - 1 ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < width - 1 ? x + 1 : width - 1;
      let min = 255;
      for (let yy = y0; yy <= y1 && min !== 0; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          const v = mask[row + xx];
          if (v < min) min = v;
        }
      }
      out[y * width + x] = min;
    }
  }
  return out;
}

/** 3x3 dilation. Grows bright regions. */
export function dilate3(mask: Mask, width: number, height: number): Mask {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = y > 0 ? y - 1 : 0;
    const y1 = y < height - 1 ? y + 1 : height - 1;
    for (let x = 0; x < width; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < width - 1 ? x + 1 : width - 1;
      let max = 0;
      for (let yy = y0; yy <= y1 && max !== 255; yy++) {
        const row = yy * width;
        for (let xx = x0; xx <= x1; xx++) {
          const v = mask[row + xx];
          if (v > max) max = v;
        }
      }
      out[y * width + x] = max;
    }
  }
  return out;
}

/**
 * Keep only connected components of at least `minArea` pixels.
 *
 * Two-pass union-find over 4-connected neighbours. Used to drop the speckle
 * that survives thresholding on a phone photo.
 */
export function filterSmallBlobs(mask: Mask, width: number, height: number, minArea: number): Mask {
  if (minArea <= 1) return mask;
  const n = width * height;
  const labels = new Int32Array(n);
  const parent: number[] = [0];

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };

  let next = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const left = x > 0 ? labels[i - 1] : 0;
      const up = y > 0 ? labels[i - width] : 0;
      if (!left && !up) {
        labels[i] = next;
        parent.push(next);
        next++;
      } else if (left && up && left !== up) {
        labels[i] = left;
        const a = find(left);
        const b = find(up);
        if (a !== b) parent[b] = a;
      } else {
        labels[i] = left || up;
      }
    }
  }

  const counts = new Int32Array(next);
  for (let i = 0; i < n; i++) {
    if (labels[i]) counts[find(labels[i])]++;
  }

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] && counts[find(labels[i])] >= minArea) out[i] = 255;
  }
  return out;
}

/** Union of two masks. */
export function orMask(a: Mask, b: Mask): Mask {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] | b[i];
  return out;
}

/**
 * Box-blur a mask into a float coverage map in [0, 1].
 *
 * This is the anti-aliasing step: a hard mask blended straight into the
 * composite produces jagged text, a feathered one looks like print.
 */
export function featherMask(
  mask: Mask,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const n = width * height;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = mask[i];
  const blurred = boxFilter(f, width, height, Math.max(1, Math.round(radius)));
  for (let i = 0; i < n; i++) blurred[i] /= 255;
  return blurred;
}
