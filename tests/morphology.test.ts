import { describe, expect, it } from 'vitest';
import { dilate3, erode3, featherMask, filterSmallBlobs } from '../src/lib/imaging/morphology';
import type { Mask } from '../src/lib/imaging/types';

function maskFrom(rows: string[]): { mask: Mask; width: number; height: number } {
  const height = rows.length;
  const width = rows[0].length;
  const mask = new Uint8Array(width * height);
  rows.forEach((row, y) => {
    for (let x = 0; x < width; x++) mask[y * width + x] = row[x] === '#' ? 255 : 0;
  });
  return { mask, width, height };
}

function render(mask: Mask, width: number, height: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += mask[y * width + x] ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

describe('erode3 / dilate3', () => {
  it('shrinks a solid block by one pixel', () => {
    const { mask, width, height } = maskFrom(['.....', '.###.', '.###.', '.###.', '.....']);
    expect(render(erode3(mask, width, height), width, height)).toEqual([
      '.....',
      '.....',
      '..#..',
      '.....',
      '.....',
    ]);
  });

  it('grows a solid block by one pixel', () => {
    const { mask, width, height } = maskFrom(['.....', '.....', '..#..', '.....', '.....']);
    expect(render(dilate3(mask, width, height), width, height)).toEqual([
      '.....',
      '.###.',
      '.###.',
      '.###.',
      '.....',
    ]);
  });

  it('erasing then dilating removes isolated single pixels', () => {
    const { mask, width, height } = maskFrom([
      '#........',
      '.........',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '.........',
      '.........',
    ]);
    const opened = dilate3(erode3(mask, width, height), width, height);
    expect(render(opened, width, height)).toEqual([
      '.........',
      '.........',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '..#####..',
      '.........',
      '.........',
    ]);
  });
});

describe('filterSmallBlobs', () => {
  it('drops components below the area threshold and keeps the rest', () => {
    const { mask, width, height } = maskFrom([
      '#........',
      '.........',
      '..####...',
      '..####...',
      '.........',
      '.......##',
      '.......##',
    ]);
    const filtered = filterSmallBlobs(mask, width, height, 4);
    expect(render(filtered, width, height)).toEqual([
      '.........',
      '.........',
      '..####...',
      '..####...',
      '.........',
      '.......##',
      '.......##',
    ]);
  });

  it('is a no-op when the threshold is one', () => {
    const { mask, width, height } = maskFrom(['#.#', '.#.', '#.#']);
    expect(filterSmallBlobs(mask, width, height, 1)).toBe(mask);
  });

  it('treats diagonally touching pixels as separate components', () => {
    const { mask, width, height } = maskFrom(['#..', '.#.', '..#']);
    // 4-connectivity: three components of one pixel each.
    expect(filterSmallBlobs(mask, width, height, 2).some((value) => value !== 0)).toBe(false);
  });
});

describe('featherMask', () => {
  it('returns coverage in the unit interval', () => {
    const { mask, width, height } = maskFrom(['.....', '.###.', '.###.', '.###.', '.....']);
    const feathered = featherMask(mask, width, height, 1);
    for (const value of feathered) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('leaves the interior of a large region fully covered', () => {
    const rows = Array.from({ length: 20 }, () => '#'.repeat(20));
    const { mask, width, height } = maskFrom(rows);
    const feathered = featherMask(mask, width, height, 1);
    expect(feathered[10 * width + 10]).toBeCloseTo(1, 5);
  });

  it('softens the boundary', () => {
    const { mask, width, height } = maskFrom(['.....', '.....', '#####', '.....', '.....']);
    const feathered = featherMask(mask, width, height, 1);
    const edge = feathered[2 * width + 2];
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(1);
  });
});
