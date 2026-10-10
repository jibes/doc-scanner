import { describe, expect, it } from 'vitest';
import type { Quad } from '../src/lib/imaging/image';
import {
  applyHomography,
  homography,
  isConvex,
  orderCorners,
  perspectiveAspect,
  quadArea,
  quadPageSize,
} from '../src/lib/imaging/quad';

/**
 * Photograph a w x h rectangle with a pinhole camera: rotate it about x then
 * y, push it `distance` away, project with focal length f around the image
 * centre. Returns the corners as TL, TR, BR, BL.
 */
function photograph(
  w: number,
  h: number,
  { tiltX = 0, tiltY = 0, distance = 400, f = 3000, image = [3000, 4000] as const } = {},
): Quad {
  const [W, H] = image;
  const corners: [number, number][] = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  const cx = Math.cos(tiltX);
  const sx = Math.sin(tiltX);
  const cy = Math.cos(tiltY);
  const sy = Math.sin(tiltY);
  return corners.map(([x, y]) => {
    // Rotate about the x axis, then the y axis.
    const y1 = y * cx;
    const z1 = y * sx;
    const x2 = x * cy + z1 * sy;
    const z2 = -x * sy + z1 * cy + distance;
    return [W / 2 + (f * x2) / z2, H / 2 + (f * y1) / z2] as const;
  }) as unknown as Quad;
}

describe('homography', () => {
  it('maps the four source corners exactly', () => {
    const from: Quad = [
      [0, 0],
      [100, 0],
      [100, 150],
      [0, 150],
    ];
    const to: Quad = [
      [12, 30],
      [480, 10],
      [520, 700],
      [-5, 650],
    ];
    const h = homography(from, to);
    for (let i = 0; i < 4; i++) {
      const [x, y] = applyHomography(h, from[i][0], from[i][1]);
      expect(x).toBeCloseTo(to[i][0], 6);
      expect(y).toBeCloseTo(to[i][1], 6);
    }
  });
});

describe('orderCorners', () => {
  it('orders any permutation as TL, TR, BR, BL', () => {
    const expected: Quad = [
      [10, 12],
      [200, 5],
      [210, 300],
      [0, 290],
    ];
    const shuffled = [expected[2], expected[0], expected[3], expected[1]];
    expect(orderCorners(shuffled)).toEqual(expected);
  });
});

describe('isConvex / quadArea', () => {
  it('rejects a bow-tie and measures area', () => {
    expect(
      isConvex([
        [0, 0],
        [10, 10],
        [10, 0],
        [0, 10],
      ]),
    ).toBe(false);
    const square: Quad = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(isConvex(square)).toBe(true);
    expect(quadArea(square)).toBe(100);
  });
});

describe('perspectiveAspect', () => {
  const A4 = 210 / 297;

  it.each([
    { tiltX: 0.6, tiltY: 0 },
    { tiltX: 0, tiltY: 0.5 },
    { tiltX: 0.45, tiltY: 0.3 },
    { tiltX: -0.35, tiltY: -0.4 },
  ])('recovers A4 shot at an angle %o', (pose) => {
    const quad = photograph(210, 297, pose);
    const aspect = perspectiveAspect(quad, 3000, 4000);
    expect(aspect).not.toBeNull();
    expect(aspect!).toBeCloseTo(A4, 2);
  });

  it('matches the edge ratio on a head-on shot', () => {
    const quad = photograph(210, 297);
    expect(perspectiveAspect(quad, 3000, 4000)).toBeCloseTo(A4, 4);
    const size = quadPageSize(quad, { width: 3000, height: 4000 });
    expect(size.width / size.height).toBeCloseTo(A4, 3);
  });

  it('stays usable when the real focal length differs from the assumed one', () => {
    // Single-axis tilt with a longer lens than the default assumption.
    const quad = photograph(210, 297, { tiltX: 0.5, f: 3600 });
    const aspect = perspectiveAspect(quad, 3000, 4000)!;
    expect(Math.abs(aspect - A4) / A4).toBeLessThan(0.04);
  });

  it('fixes the foreshortening that plain edge lengths get wrong', () => {
    const quad = photograph(210, 297, { tiltX: 0.6 });
    const naive = quadPageSize(quad);
    const corrected = quadPageSize(quad, { width: 3000, height: 4000 });
    expect(Math.abs(naive.width / naive.height - A4)).toBeGreaterThan(0.05);
    expect(corrected.width / corrected.height).toBeCloseTo(A4, 2);
  });

  it('stays close with a few pixels of corner noise', () => {
    const quad = photograph(210, 297, { tiltX: 0.5, tiltY: 0.25 });
    const noisy = quad.map(([x, y], i) => [
      x + (i % 2 ? 2 : -2),
      y + (i < 2 ? 2 : -1.5),
    ]) as unknown as Quad;
    const aspect = perspectiveAspect(noisy, 3000, 4000);
    expect(aspect).not.toBeNull();
    expect(Math.abs(aspect! - A4) / A4).toBeLessThan(0.02);
  });
});
