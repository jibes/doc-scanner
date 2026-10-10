import { describe, expect, it } from 'vitest';
import { createImage, type Quad, type RGBAImage } from '../src/lib/imaging/types';
import { quadOutputSize, unitSquareToQuad, warpPerspective } from '../src/lib/imaging/warp';

function applyHomography(h: number[], u: number, v: number): [number, number] {
  const den = h[6] * u + h[7] * v + 1;
  return [(h[0] * u + h[1] * v + h[2]) / den, (h[3] * u + h[4] * v + h[5]) / den];
}

function gradient(width: number, height: number): RGBAImage {
  const img = createImage(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      img.data[p] = (x * 7) % 256;
      img.data[p + 1] = (y * 11) % 256;
      img.data[p + 2] = (x + y) % 256;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

describe('unitSquareToQuad', () => {
  it('maps the unit square corners onto the quad', () => {
    const quad: Quad = [
      [12, 8],
      [180, 20],
      [200, 240],
      [5, 210],
    ];
    const h = unitSquareToQuad(quad);

    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    corners.forEach(([u, v], index) => {
      const [x, y] = applyHomography(h, u, v);
      expect(x).toBeCloseTo(quad[index][0], 6);
      expect(y).toBeCloseTo(quad[index][1], 6);
    });
  });

  it('degenerates to an affine map for a parallelogram', () => {
    const quad: Quad = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const h = unitSquareToQuad(quad);
    expect(h[6]).toBeCloseTo(0, 9);
    expect(h[7]).toBeCloseTo(0, 9);
  });
});

describe('quadOutputSize', () => {
  it('keeps a square quad square', () => {
    const quad: Quad = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    expect(quadOutputSize(quad, 4000)).toEqual({ width: 100, height: 100 });
  });

  it('keeps a receipt long and narrow instead of forcing a paper ratio', () => {
    const quad: Quad = [
      [0, 0],
      [80, 0],
      [80, 600],
      [0, 600],
    ];
    const size = quadOutputSize(quad, 4000);
    expect(size.width).toBe(80);
    expect(size.height).toBe(600);
  });

  it('caps the long edge and preserves the aspect ratio', () => {
    const quad: Quad = [
      [0, 0],
      [1000, 0],
      [1000, 500],
      [0, 500],
    ];
    const size = quadOutputSize(quad, 400);
    expect(size.width).toBe(400);
    expect(size.height).toBe(200);
  });

  it('never returns a degenerate size', () => {
    const quad: Quad = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const size = quadOutputSize(quad, 4000);
    expect(size.width).toBeGreaterThanOrEqual(64);
    expect(size.height).toBeGreaterThanOrEqual(64);
  });
});

describe('warpPerspective', () => {
  it('reproduces the source for an axis-aligned quad', () => {
    const width = 32;
    const height = 24;
    const src = gradient(width, height);
    const quad: Quad = [
      [0, 0],
      [width - 1, 0],
      [width - 1, height - 1],
      [0, height - 1],
    ];

    const out = warpPerspective(src, quad, width, height);
    expect(out.width).toBe(width);
    expect(out.height).toBe(height);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('fills the output with opaque pixels', () => {
    const src = gradient(40, 40);
    const quad: Quad = [
      [5, 5],
      [35, 8],
      [33, 34],
      [7, 30],
    ];
    const out = warpPerspective(src, quad, 60, 60);
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(255);
  });

  it('samples the quad region rather than the whole source', () => {
    // Left half black, right half white. A quad over the right half must come
    // back white.
    const width = 40;
    const height = 20;
    const src = createImage(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        const value = x < width / 2 ? 0 : 255;
        src.data[p] = value;
        src.data[p + 1] = value;
        src.data[p + 2] = value;
        src.data[p + 3] = 255;
      }
    }

    const quad: Quad = [
      [width / 2, 0],
      [width - 1, 0],
      [width - 1, height - 1],
      [width / 2, height - 1],
    ];
    const out = warpPerspective(src, quad, 20, 20);
    expect(out.data[0]).toBe(255);
    expect(out.data[(10 * 20 + 10) * 4]).toBe(255);
  });
});
