import { createFloat, type FloatImage } from './image';

function reflect(i: number, n: number): number {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
}

/**
 * Mean over a (2r+1)^2 window, separable sliding sum, mirrored borders.
 * O(width * height) regardless of radius.
 */
export function boxMean(src: FloatImage, radius: number): FloatImage {
  const r = Math.max(0, Math.floor(radius));
  const { width: w, height: h } = src;
  const out = createFloat(w, h);
  if (r === 0) {
    out.data.set(src.data);
    return out;
  }
  const size = 2 * r + 1;
  const tmp = new Float32Array(w * h);
  const line = new Float32Array(Math.max(w, h) + 2 * r);

  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let i = -r; i < w + r; i++) line[i + r] = src.data[off + reflect(i, w)];
    let sum = 0;
    for (let i = 0; i < size; i++) sum += line[i];
    for (let x = 0; x < w; x++) {
      tmp[off + x] = sum / size;
      sum += line[x + size] - line[x];
    }
  }

  for (let x = 0; x < w; x++) {
    for (let i = -r; i < h + r; i++) line[i + r] = tmp[reflect(i, h) * w + x];
    let sum = 0;
    for (let i = 0; i < size; i++) sum += line[i];
    for (let y = 0; y < h; y++) {
      out.data[y * w + x] = sum / size;
      sum += line[y + size] - line[y];
    }
  }
  return out;
}

/** Local mean and standard deviation over a (2r+1)^2 window. */
export function localStats(src: FloatImage, radius: number): { mean: FloatImage; std: FloatImage } {
  const sq = createFloat(src.width, src.height);
  for (let i = 0; i < sq.data.length; i++) sq.data[i] = src.data[i] * src.data[i];
  const mean = boxMean(src, radius);
  const std = boxMean(sq, radius);
  for (let i = 0; i < std.data.length; i++) {
    const m = mean.data[i];
    const v = std.data[i] - m * m;
    std.data[i] = v > 0 ? Math.sqrt(v) : 0;
  }
  return { mean, std };
}

/**
 * Exact separable Gaussian with a kernel truncated at 3 sigma, mirrored borders.
 * Meant for small sigmas (sub-pixel to a few pixels), where box approximations
 * cannot go: three 3-wide boxes already have sigma ~1.4.
 */
export function gaussian(src: FloatImage, sigma: number): FloatImage {
  if (sigma <= 0.05) return src;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    kernel[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + r];
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;

  const { width: w, height: h } = src;
  const tmp = new Float32Array(w * h);
  const out = createFloat(w, h);
  const s = src.data;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      if (x >= r && x < w - r) {
        for (let k = -r; k <= r; k++) acc += s[off + x + k] * kernel[k + r];
      } else {
        for (let k = -r; k <= r; k++) acc += s[off + reflect(x + k, w)] * kernel[k + r];
      }
      tmp[off + x] = acc;
    }
  }
  const o = out.data;
  for (let y = 0; y < h; y++) {
    const interior = y >= r && y < h - r;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      if (interior) {
        for (let k = -r; k <= r; k++) acc += tmp[(y + k) * w + x] * kernel[k + r];
      } else {
        for (let k = -r; k <= r; k++) acc += tmp[reflect(y + k, h) * w + x] * kernel[k + r];
      }
      o[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Minimum over a (2r+1)^2 window (grey-level erosion), separable, with a
 * monotonic queue per line so the cost does not depend on the radius.
 */
export function minFilter(src: FloatImage, radius: number): FloatImage {
  const r = Math.max(0, Math.floor(radius));
  const { width: w, height: h } = src;
  if (r === 0) return src;
  const tmp = new Float32Array(w * h);
  const out = createFloat(w, h);
  const queue = new Int32Array(Math.max(w, h));

  const pass = (read: (i: number) => number, write: (i: number, v: number) => void, n: number) => {
    let head = 0;
    let tail = 0;
    // Prime the window [0, r).
    for (let i = 0; i < Math.min(r, n); i++) {
      while (tail > head && read(queue[tail - 1]) >= read(i)) tail--;
      queue[tail++] = i;
    }
    for (let i = 0; i < n; i++) {
      const enter = i + r;
      if (enter < n) {
        while (tail > head && read(queue[tail - 1]) >= read(enter)) tail--;
        queue[tail++] = enter;
      }
      while (queue[head] < i - r) head++;
      write(i, read(queue[head]));
    }
  };

  for (let y = 0; y < h; y++) {
    const off = y * w;
    pass(
      (i) => src.data[off + i],
      (i, v) => (tmp[off + i] = v),
      w,
    );
  }
  for (let x = 0; x < w; x++) {
    pass(
      (i) => tmp[i * w + x],
      (i, v) => (out.data[i * w + x] = v),
      h,
    );
  }
  return out;
}
