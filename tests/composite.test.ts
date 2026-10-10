import { describe, expect, it } from 'vitest';
import { composite } from '../src/lib/imaging/composite';
import { createImage, type Mask, type RGBAImage } from '../src/lib/imaging/types';

function image(width: number, height: number, fill: [number, number, number]): RGBAImage {
  const img = createImage(width, height);
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = fill[0];
    img.data[i * 4 + 1] = fill[1];
    img.data[i * 4 + 2] = fill[2];
    img.data[i * 4 + 3] = 255;
  }
  return img;
}

function mask(width: number, height: number, on: (x: number, y: number) => boolean): Mask {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = on(x, y) ? 255 : 0;
  }
  return out;
}

function pixel(img: RGBAImage, x: number, y: number): [number, number, number] {
  const p = (y * img.width + x) * 4;
  return [img.data[p], img.data[p + 1], img.data[p + 2]];
}

describe('composite', () => {
  const width = 40;
  const height = 40;

  it('renders untouched paper as exactly #FFFFFF', () => {
    // Deliberately grubby source pixels: the composite must not let them through.
    const flat = image(width, height, [201, 197, 188]);
    const ink = mask(width, height, () => false);
    const color = mask(width, height, () => false);

    const out = composite(flat, ink, color, { paper: 255, text: 0, feather: 1 });
    expect(pixel(out, 5, 5)).toEqual([255, 255, 255]);
    expect(pixel(out, 35, 35)).toEqual([255, 255, 255]);
  });

  it('renders the core of a stroke as exactly #000000', () => {
    const flat = image(width, height, [230, 230, 230]);
    const ink = mask(width, height, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30);
    const color = mask(width, height, () => false);

    const out = composite(flat, ink, color, { paper: 255, text: 0, feather: 1 });
    expect(pixel(out, 20, 20)).toEqual([0, 0, 0]);
  });

  it('copies colour content straight from the flattened source', () => {
    const flat = image(width, height, [255, 255, 255]);
    // A red stamp.
    for (let y = 10; y < 30; y++) {
      for (let x = 10; x < 30; x++) {
        const p = (y * width + x) * 4;
        flat.data[p] = 200;
        flat.data[p + 1] = 30;
        flat.data[p + 2] = 40;
      }
    }
    const ink = mask(width, height, () => false);
    const color = mask(width, height, (x, y) => x >= 10 && x < 30 && y >= 10 && y < 30);

    const out = composite(flat, ink, color, { paper: 255, text: 0, feather: 1 });
    expect(pixel(out, 20, 20)).toEqual([200, 30, 40]);
  });

  it('keeps the three weights normalised so nothing overflows', () => {
    const flat = image(width, height, [255, 255, 255]);
    // Ink and colour overlap, which is the case that can push a naive blend past 255.
    const ink = mask(width, height, (x, y) => x >= 5 && x < 35 && y >= 5 && y < 35);
    const color = mask(width, height, (x, y) => x >= 15 && x < 25 && y >= 15 && y < 25);

    const out = composite(flat, ink, color, { paper: 255, text: 0, feather: 0 });
    for (let i = 0; i < width * height; i++) {
      expect(out.data[i * 4]).toBeLessThanOrEqual(255);
      expect(out.data[i * 4]).toBeGreaterThanOrEqual(0);
    }
    // Where colour wins, the pixel is the source colour, not a blend with black.
    expect(pixel(out, 20, 20)).toEqual([255, 255, 255]);
    // Where only ink applies, it is pure black.
    expect(pixel(out, 8, 8)).toEqual([0, 0, 0]);
  });

  it('honours a softer paper level', () => {
    const flat = image(width, height, [200, 200, 200]);
    const ink = mask(width, height, () => false);
    const color = mask(width, height, () => false);
    const out = composite(flat, ink, color, { paper: 240, text: 20, feather: 0 });
    expect(pixel(out, 5, 5)).toEqual([240, 240, 240]);
  });

  it('feathers edges instead of hard-thresholding them', () => {
    const flat = image(width, height, [255, 255, 255]);
    const ink = mask(width, height, (x) => x >= 20);
    const color = mask(width, height, () => false);

    const hard = composite(flat, ink, color, { paper: 255, text: 0, feather: 0 });
    const soft = composite(flat, ink, color, { paper: 255, text: 0, feather: 1 });

    // The hard edge jumps straight from white to black.
    expect(pixel(hard, 19, 20)[0]).toBe(255);
    expect(pixel(hard, 20, 20)[0]).toBe(0);
    // The feathered edge passes through intermediate values.
    const edge = pixel(soft, 20, 20)[0];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });
});
