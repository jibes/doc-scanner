import { describe, expect, it } from 'vitest';
import { isConvexQuad } from '../src/lib/geometry';
import { binarize } from '../src/lib/imaging/binarize';
import { estimateDpi } from '../src/lib/imaging/paper';
import { processImage, scaleSettings } from '../src/lib/imaging/pipeline';
import { createImage, type Quad, type RGBAImage } from '../src/lib/imaging/types';
import { downsampleBox, rectify } from '../src/lib/imaging/warp';
import { matchPreset, presetById } from '../src/lib/presets';
import { DEFAULT_SETTINGS } from '../src/lib/settings';

/** Dark bars on a lit gradient, with every length proportional to `scale`. */
function bars(width: number, scale: number): RGBAImage {
  const height = Math.round(40 * scale);
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x % (60 * scale) < 6 * scale ? 50 : 230 - (x / width) * 60;
      const p = (y * width + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

function darkFraction(img: RGBAImage): number {
  let dark = 0;
  for (let p = 0; p < img.data.length; p += 4) if (img.data[p] < 128) dark++;
  return dark / (img.width * img.height);
}

describe('scaleSettings', () => {
  it('makes a larger render match the preview it was tuned on', () => {
    const preview = processImage(bars(600, 1), DEFAULT_SETTINGS);
    const full = processImage(bars(1800, 3), scaleSettings(DEFAULT_SETTINGS, 3));
    expect(Math.abs(darkFraction(full) - darkFraction(preview))).toBeLessThan(0.01);
  });

  it('keeps the threshold window odd and scales area quadratically', () => {
    const scaled = scaleSettings(DEFAULT_SETTINGS, 2.5);
    expect(scaled.binarize.window % 2).toBe(1);
    expect(scaled.color.minArea).toBe(Math.round(DEFAULT_SETTINGS.color.minArea * 6.25));
    expect(scaled.output).toEqual(DEFAULT_SETTINGS.output);
  });

  it('leaves disabled stages disabled', () => {
    const off = { ...DEFAULT_SETTINGS, normalize: { ...DEFAULT_SETTINGS.normalize, radius: 0 } };
    expect(scaleSettings(off, 3).normalize.radius).toBe(0);
  });
});

describe('binarize k direction', () => {
  it('thins strokes as k rises for every k-based method', () => {
    const w = 200;
    const h = 20;
    const gray = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) gray[y * w + x] = Math.min(200, 40 + Math.abs(x - w / 2) * 12);
    }
    const ink = (mask: Uint8Array) => mask.reduce((sum, v) => sum + (v ? 1 : 0), 0);
    for (const method of ['sauvola', 'niblack', 'wolf'] as const) {
      const low = ink(binarize(gray, w, h, { method, window: 31, k: 0.05, c: 8 }));
      const high = ink(binarize(gray, w, h, { method, window: 31, k: 0.4, c: 8 }));
      expect(high, method).toBeLessThan(low);
    }
  });
});

describe('estimateDpi', () => {
  it('derives the DPI from an A4-shaped page', () => {
    expect(estimateDpi(1697, 2400, 300)).toBe(205);
  });

  it('recognises US Letter', () => {
    expect(estimateDpi(1855, 2400, 300)).toBe(218);
  });

  it('falls back for shapes that match no paper format', () => {
    expect(estimateDpi(600, 2400, 300)).toBe(300);
  });
});

describe('rectify', () => {
  it('box-filters before shrinking so fine detail averages instead of aliasing', () => {
    // One-pixel black/white stripes, shrunk 8x: the result should be mid grey.
    const src = createImage(800, 800);
    for (let p = 0, i = 0; p < src.data.length; p += 4, i++) {
      const v = i % 2 === 0 ? 0 : 255;
      src.data[p] = src.data[p + 1] = src.data[p + 2] = v;
      src.data[p + 3] = 255;
    }
    const quad: Quad = [
      [0, 0],
      [800, 0],
      [800, 800],
      [0, 800],
    ];
    const out = rectify(src, quad, 100);
    expect(out.width).toBe(100);
    for (let p = 0; p < out.data.length; p += 4) {
      expect(Math.abs(out.data[p] - 127.5)).toBeLessThan(2);
    }
  });

  it('downsampleBox averages edge blocks over the pixels that exist', () => {
    const src = createImage(3, 1);
    src.data.set([10, 10, 10, 255, 20, 20, 20, 255, 90, 90, 90, 255]);
    const out = downsampleBox(src, 2);
    expect(out.width).toBe(2);
    expect(Array.from(out.data)).toEqual([15, 15, 15, 255, 90, 90, 90, 255]);
  });
});

describe('isConvexQuad', () => {
  it('accepts a page and rejects crossed corners', () => {
    expect(
      isConvexQuad([
        [0, 0],
        [10, 1],
        [11, 12],
        [1, 10],
      ]),
    ).toBe(true);
    expect(
      isConvexQuad([
        [0, 0],
        [10, 0],
        [0, 10],
        [10, 10],
      ]),
    ).toBe(false);
  });
});

describe('matchPreset', () => {
  it('finds the preset regardless of output settings', () => {
    const settings = structuredClone(presetById('receipt').settings);
    settings.output.targetDpi = 450;
    expect(matchPreset(settings)).toBe('receipt');
  });

  it('returns null for customised settings', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.composite.paper = 240;
    expect(matchPreset(settings)).toBeNull();
  });
});
