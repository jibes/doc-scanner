import { describe, expect, it } from 'vitest';
import { boxFilter } from '../src/lib/imaging/filters';

describe('boxFilter', () => {
  it('returns a copy when the radius is zero', () => {
    const src = new Float32Array([1, 2, 3, 4]);
    const out = boxFilter(src, 2, 2, 0);
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
    expect(out).not.toBe(src);
  });

  it('preserves a constant image', () => {
    const src = new Float32Array(64).fill(7);
    const out = boxFilter(src, 8, 8, 3);
    for (const value of out) expect(value).toBeCloseTo(7, 5);
  });

  it('averages a symmetric window around each pixel', () => {
    // 5x1 row: 0 0 10 0 0. With radius 1 the centre pixel averages 0,10,0.
    const src = new Float32Array([0, 0, 10, 0, 0]);
    const out = boxFilter(src, 5, 1, 1);
    expect(out[2]).toBeCloseTo(10 / 3, 5);
    expect(out[1]).toBeCloseTo(10 / 3, 5);
    expect(out[0]).toBeCloseTo(0, 5);
  });

  it('mirrors the window at the borders instead of truncating it', () => {
    // src = [0, 10, 0]. At x=0 the mirrored window is [10, 0, 10].
    const src = new Float32Array([0, 10, 0]);
    const out = boxFilter(src, 3, 1, 1);
    expect(out[0]).toBeCloseTo(20 / 3, 5);
    expect(out[1]).toBeCloseTo(10 / 3, 5);
    expect(out[2]).toBeCloseTo(20 / 3, 5);
  });

  it('keeps the window size constant at the borders', () => {
    // A single bright pixel at the very edge still spreads over a full 2r+1
    // window: [src[2], src[1], src[0], src[1], src[2]].
    const src = new Float32Array(10);
    src[0] = 100;
    const out = boxFilter(src, 10, 1, 2);
    expect(out[0]).toBeCloseTo(100 / 5, 5);
    expect(out[1]).toBeCloseTo(100 / 5, 5);
    expect(out[2]).toBeCloseTo(100 / 5, 5);
    expect(out[3]).toBeCloseTo(0, 5);
  });

  it('is separable, so a 2D impulse spreads over the full window', () => {
    const width = 9;
    const height = 9;
    const src = new Float32Array(width * height);
    src[4 * width + 4] = 81;
    const out = boxFilter(src, width, height, 2);
    // 5x5 window => 25 samples, so the centre is 81/25.
    expect(out[4 * width + 4]).toBeCloseTo(81 / 25, 5);
    expect(out[2 * width + 2]).toBeCloseTo(81 / 25, 5);
    expect(out[1 * width + 1]).toBeCloseTo(0, 5);
  });
});
