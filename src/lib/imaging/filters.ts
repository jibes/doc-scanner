/**
 * Separable box filter with a sliding window sum.
 *
 * Runs in O(width * height) regardless of radius, which is what makes the
 * local-threshold and illumination stages fast enough to run on a phone.
 *
 * The window is mirrored at the borders rather than truncated. That matters:
 * with a truncated window the mean of a lighting gradient is biased towards
 * the interior, which darkens the edges of every page. Mirroring keeps the
 * window symmetric, so a linear gradient averages back to its own centre value
 * and the page flattens to a uniform white.
 */
export function boxFilter(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const r = Math.max(0, Math.floor(radius));
  const out = new Float32Array(width * height);

  if (r === 0) {
    out.set(src);
    return out;
  }

  const window = 2 * r + 1;
  const tmp = new Float32Array(width * height);

  // Horizontal pass.
  const extW = width + 2 * r;
  const row = new Float32Array(extW);
  for (let y = 0; y < height; y++) {
    const off = y * width;
    for (let i = 0; i < extW; i++) {
      let s: number;
      if (i < r) s = r - i;
      else if (i < r + width) s = i - r;
      else s = 2 * width + r - 2 - i;
      row[i] = src[off + (s < 0 ? 0 : s > width - 1 ? width - 1 : s)];
    }

    let sum = 0;
    for (let i = 0; i < window; i++) sum += row[i];
    for (let x = 0; x < width; x++) {
      tmp[off + x] = sum / window;
      if (x + window < extW) sum += row[x + window] - row[x];
    }
  }

  // Vertical pass.
  const extH = height + 2 * r;
  const column = new Float32Array(extH);
  for (let x = 0; x < width; x++) {
    for (let i = 0; i < extH; i++) {
      let s: number;
      if (i < r) s = r - i;
      else if (i < r + height) s = i - r;
      else s = 2 * height + r - 2 - i;
      column[i] = tmp[(s < 0 ? 0 : s > height - 1 ? height - 1 : s) * width + x];
    }

    let sum = 0;
    for (let i = 0; i < window; i++) sum += column[i];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / window;
      if (y + window < extH) sum += column[y + window] - column[y];
    }
  }

  return out;
}
