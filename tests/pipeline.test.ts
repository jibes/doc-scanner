import { describe, expect, it } from 'vitest';
import { processImage } from '../src/lib/imaging/pipeline';
import { createImage, type RGBAImage } from '../src/lib/imaging/types';
import { DEFAULT_SETTINGS } from '../src/lib/settings';

const WIDTH = 240;
const HEIGHT = 320;

/**
 * A page photographed under a strong horizontal lighting gradient, with two
 * blocks of text and a red stamp. This is the shape of input the pipeline
 * actually has to cope with.
 */
function syntheticPage(): RGBAImage {
  const img = createImage(WIDTH, HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const value = 140 + Math.round((x / (WIDTH - 1)) * 110);
      const p = (y * WIDTH + x) * 4;
      img.data[p] = value;
      img.data[p + 1] = value;
      img.data[p + 2] = value;
      img.data[p + 3] = 255;
    }
  }

  const paint = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    colour: [number, number, number],
  ) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * WIDTH + x) * 4;
        img.data[p] = colour[0];
        img.data[p + 1] = colour[1];
        img.data[p + 2] = colour[2];
      }
    }
  };

  paint(30, 60, 90, 80, [12, 12, 12]);
  paint(150, 220, 210, 240, [12, 12, 12]);
  paint(100, 140, 140, 170, [200, 30, 40]);

  return img;
}

function pixel(img: RGBAImage, x: number, y: number): [number, number, number] {
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
}

/**
 * Byte-for-byte comparison. `expect(a).toEqual(b)` on a few hundred thousand
 * elements spends minutes building a diff, so compare directly instead.
 */
function expectSameBytes(actual: Uint8ClampedArray, expected: Uint8ClampedArray): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`byte ${i} differs: ${actual[i]} !== ${expected[i]}`);
    }
  }
}

describe('processImage', () => {
  it('flattens the lighting gradient to a pure white background', () => {
    const out = processImage(syntheticPage(), DEFAULT_SETTINGS);
    // Sampled well away from any content, at both ends of the gradient.
    expect(pixel(out, 10, 10)).toEqual([255, 255, 255]);
    expect(pixel(out, 230, 300)).toEqual([255, 255, 255]);
    expect(pixel(out, 120, 30)).toEqual([255, 255, 255]);
  });

  it('renders text cores as pure black', () => {
    const out = processImage(syntheticPage(), DEFAULT_SETTINGS);
    expect(pixel(out, 60, 70)).toEqual([0, 0, 0]);
    expect(pixel(out, 180, 230)).toEqual([0, 0, 0]);
  });

  it('keeps the stamp red', () => {
    const out = processImage(syntheticPage(), DEFAULT_SETTINGS);
    const [r, g, b] = pixel(out, 120, 155);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(90);
  });

  it('drops the stamp to black when colour preservation is off', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.color.enabled = false;
    const out = processImage(syntheticPage(), settings);
    expect(pixel(out, 120, 155)).toEqual([0, 0, 0]);
  });

  it('is deterministic', () => {
    const first = processImage(syntheticPage(), DEFAULT_SETTINGS);
    const second = processImage(syntheticPage(), DEFAULT_SETTINGS);
    expectSameBytes(first.data, second.data);
  });

  it('returns the flattened page untouched when binarisation is off', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.normalize.radius = 0;
    settings.binarize.method = 'off';
    settings.color.enabled = false;
    settings.composite.feather = 0;

    const source = syntheticPage();
    const out = processImage(source, settings);
    expectSameBytes(out.data, source.data);
  });

  it('flattens lighting but keeps the page when binarisation is off', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.binarize.method = 'off';

    const source = syntheticPage();
    const out = processImage(source, settings);

    // The gradient is gone: the two ends of the page now sit within a few
    // levels of each other instead of a hundred apart. (Divide-by-background
    // leaves a small residual at the borders, because the window there is
    // mirrored rather than centred on real pixels.)
    const sourceLeft = pixel(source, 10, 10)[0];
    const sourceRight = pixel(source, 229, 10)[0];
    const left = pixel(out, 10, 10)[0];
    const right = pixel(out, 229, 10)[0];
    expect(sourceRight - sourceLeft).toBeGreaterThan(90);
    expect(Math.abs(right - left)).toBeLessThan(25);
    expect(left).toBeGreaterThan(230);

    // The stamp is still red, because nothing was thresholded away.
    const [r, g, b] = pixel(out, 120, 155);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(80);
    expect(b).toBeLessThan(90);
  });

  it('reports each stage in order', () => {
    const stages: string[] = [];
    processImage(syntheticPage(), DEFAULT_SETTINGS, (stage) => stages.push(stage));
    expect(stages).toEqual(['normalize', 'binarize', 'color', 'composite']);
  });

  it('preserves the input dimensions', () => {
    const out = processImage(syntheticPage(), DEFAULT_SETTINGS);
    expect(out.width).toBe(WIDTH);
    expect(out.height).toBe(HEIGHT);
  });
});
