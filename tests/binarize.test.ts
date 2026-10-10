import { describe, expect, it } from 'vitest';
import { binarize } from '../src/lib/imaging/binarize';

/** Build a grayscale page: `background(x, y)` with dark text blocks painted on top. */
function page(
  width: number,
  height: number,
  background: (x: number, y: number) => number,
  blocks: { x: number; y: number; w: number; h: number }[],
): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) gray[y * width + x] = background(x, y);
  }
  for (const block of blocks) {
    for (let y = block.y; y < block.y + block.h; y++) {
      for (let x = block.x; x < block.x + block.w; x++) gray[y * width + x] = 10;
    }
  }
  return gray;
}

describe('binarize', () => {
  it('returns an empty mask when the method is off', () => {
    const gray = page(32, 32, () => 200, [{ x: 8, y: 8, w: 8, h: 8 }]);
    const mask = binarize(gray, 32, 32, { method: 'off', window: 31, k: 0.15, c: 8 });
    expect(mask.every((value) => value === 0)).toBe(true);
  });

  it('separates a bimodal page with Otsu', () => {
    const gray = page(64, 64, () => 230, [{ x: 20, y: 20, w: 24, h: 24 }]);
    const mask = binarize(gray, 64, 64, { method: 'otsu', window: 31, k: 0.15, c: 8 });
    expect(mask[32 * 64 + 32]).toBe(255);
    expect(mask[2 * 64 + 2]).toBe(0);
  });

  it('finds text on a strong lighting gradient where a global threshold fails', () => {
    const width = 200;
    const height = 200;
    // Background ramps from 90 to 250 across the page. Text is a fixed amount
    // darker than whatever the local paper happens to be, which is exactly the
    // case a single global threshold cannot handle.
    const paper = (x: number) => 90 + Math.round((x / (width - 1)) * 160);
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) gray[y * width + x] = paper(x);
    }
    for (const block of [
      { x: 10, y: 90, w: 30, h: 20 },
      { x: 160, y: 90, w: 30, h: 20 },
    ]) {
      for (let y = block.y; y < block.y + block.h; y++) {
        for (let x = block.x; x < block.x + block.w; x++) {
          gray[y * width + x] = Math.max(0, paper(x) - 90);
        }
      }
    }

    const local = binarize(gray, width, height, {
      method: 'sauvola',
      window: 31,
      k: 0.15,
      c: 8,
    });
    const global = binarize(gray, width, height, { method: 'otsu', window: 31, k: 0.15, c: 8 });

    // Local thresholding finds the text at both ends of the gradient...
    expect(local[100 * width + 25]).toBe(255);
    expect(local[100 * width + 175]).toBe(255);

    // ...and leaves clean paper alone at both ends. Rows 0-80 hold no text.
    const falsePositives = (mask: Uint8Array) => {
      let count = 0;
      for (let y = 0; y < 80; y++) {
        for (let x = 0; x < width; x++) if (mask[y * width + x]) count++;
      }
      return count;
    };
    expect(falsePositives(local)).toBe(0);

    // A single global threshold cannot do both: to catch the text on the bright
    // end it has to sit high enough that the dark end of the page floods with
    // false positives.
    expect(falsePositives(global)).toBeGreaterThan(1000);
  });

  it('leaves clean paper untouched', () => {
    const gray = page(120, 120, () => 245, []);
    const mask = binarize(gray, 120, 120, { method: 'sauvola', window: 31, k: 0.15, c: 8 });
    const ink = mask.reduce((count, value) => count + (value ? 1 : 0), 0);
    expect(ink).toBe(0);
  });

  it('inverts when asked', () => {
    const gray = page(64, 64, () => 230, [{ x: 20, y: 20, w: 24, h: 24 }]);
    const normal = binarize(gray, 64, 64, { method: 'otsu', window: 31, k: 0.15, c: 8 });
    const inverted = binarize(gray, 64, 64, {
      method: 'otsu',
      window: 31,
      k: 0.15,
      c: 8,
      invert: true,
    });
    expect(inverted[32 * 64 + 32]).toBe(0);
    expect(inverted[2 * 64 + 2]).toBe(255);
    expect(normal[32 * 64 + 32]).toBe(255);
  });
});
