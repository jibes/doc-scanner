import { describe, expect, it } from 'vitest';
import { colorMask } from '../src/lib/imaging/color';
import { createImage, type RGBAImage } from '../src/lib/imaging/types';

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

function paint(
  img: RGBAImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  colour: [number, number, number],
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * img.width + x) * 4;
      img.data[p] = colour[0];
      img.data[p + 1] = colour[1];
      img.data[p + 2] = colour[2];
    }
  }
}

const options = { chromaThreshold: 60, lumaFloor: 40, minArea: 0, grow: 0 };

describe('colorMask', () => {
  it('ignores neutral paper and grey ink', () => {
    const img = image(40, 40, [250, 250, 250]);
    paint(img, 10, 10, 30, 30, [40, 40, 40]);
    const mask = colorMask(img, options);
    expect(mask.some((value) => value !== 0)).toBe(false);
  });

  it('detects a saturated stamp', () => {
    const img = image(40, 40, [250, 250, 250]);
    paint(img, 10, 10, 30, 30, [200, 30, 40]);
    const mask = colorMask(img, options);
    expect(mask[20 * 40 + 20]).toBe(255);
    expect(mask[2 * 40 + 2]).toBe(0);
  });

  it('treats dark saturated pixels as ink, not colour content', () => {
    const img = image(40, 40, [250, 250, 250]);
    // Chroma is high but luma is below the floor, so this is black-ish ink.
    paint(img, 10, 10, 30, 30, [30, 0, 0]);
    const mask = colorMask(img, options);
    expect(mask[20 * 40 + 20]).toBe(0);
  });

  it('respects the chroma threshold', () => {
    const img = image(40, 40, [250, 250, 250]);
    // A faint tint: chroma 20.
    paint(img, 10, 10, 30, 30, [230, 220, 210]);
    expect(colorMask(img, { ...options, chromaThreshold: 60 })[20 * 40 + 20]).toBe(0);
    expect(colorMask(img, { ...options, chromaThreshold: 10 })[20 * 40 + 20]).toBe(255);
  });

  it('drops specks below the minimum area', () => {
    const img = image(40, 40, [250, 250, 250]);
    paint(img, 20, 20, 22, 22, [200, 30, 40]); // 4 px
    paint(img, 5, 5, 15, 15, [30, 120, 200]); // 100 px

    const kept = colorMask(img, { ...options, minArea: 20 });
    expect(kept[20 * 40 + 20]).toBe(0);
    expect(kept[10 * 40 + 10]).toBe(255);
  });

  it('grows the mask so anti-aliased edges survive', () => {
    const img = image(40, 40, [250, 250, 250]);
    paint(img, 15, 15, 25, 25, [200, 30, 40]);

    const tight = colorMask(img, { ...options, grow: 0 });
    const grown = colorMask(img, { ...options, grow: 2 });
    expect(tight[14 * 40 + 20]).toBe(0);
    expect(grown[14 * 40 + 20]).toBe(255);
  });
});
