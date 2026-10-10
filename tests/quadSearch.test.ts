import { describe, expect, it } from 'vitest';
import { clipToFrame, colourPlanes, quadSupported, searchQuad } from '../src/lib/detect/quadSearch';
import { createRGBA, type Point, type Quad, type RGBAImage } from '../src/lib/imaging/image';
import { applyHomography, homography, isConvex } from '../src/lib/imaging/quad';

type RGB = [number, number, number];

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A wood-like table: brown with faint grain streaks and sensor noise. */
function table(width: number, height: number, seed = 1): RGBAImage {
  const img = createRGBA(width, height);
  const r = rng(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grain = 12 * Math.sin(x * 0.05 + Math.sin(y * 0.02) * 3);
      const n = (r() - 0.5) * 8;
      const p = (y * width + x) * 4;
      img.data[p] = 120 + grain + n;
      img.data[p + 1] = 80 + grain * 0.7 + n;
      img.data[p + 2] = 50 + grain * 0.4 + n;
      img.data[p + 3] = 255;
    }
  }
  return img;
}

/**
 * Paint a page (a rectangle of `pw` × `ph` page units) into the photo at
 * `quad`, coloured per page position by `paint`.
 */
function paintPage(
  img: RGBAImage,
  quad: Quad,
  pw: number,
  ph: number,
  paint: (u: number, v: number) => RGB | null,
): void {
  const toPage = homography(quad, [
    [0, 0],
    [pw, 0],
    [pw, ph],
    [0, ph],
  ]);
  // 4x4 supersampling: edges are anti-aliased, as in a photo.
  const n = 4;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = (y * img.width + x) * 4;
      const sum = [0, 0, 0];
      let hits = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const [u, v] = applyHomography(toPage, x + (sx + 0.5) / n, y + (sy + 0.5) / n);
          const c = u < 0 || v < 0 || u >= pw || v >= ph ? null : paint(u, v);
          if (!c) continue;
          hits++;
          for (let k = 0; k < 3; k++) sum[k] += c[k];
        }
      }
      if (!hits) continue;
      const a = hits / (n * n);
      for (let k = 0; k < 3; k++) img.data[p + k] = (sum[k] / hits) * a + img.data[p + k] * (1 - a);
    }
  }
}

/** A text page: off-white with rows of dark "words". */
function text(u: number, v: number): RGB {
  const row = Math.floor(v / 10);
  if (v > 30 && v < 270 && v % 10 < 3 && u > 20 && u < 190 && (Math.floor(u / 17) + row) % 5) {
    return [40, 40, 40];
  }
  return [235, 233, 226];
}

function maxError(a: Quad, b: Quad): number {
  return Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
}

const PAGE: Quad = [
  [70, 60],
  [330, 75],
  [345, 450],
  [55, 440],
];

describe('searchQuad', () => {
  it('finds a page whose edges are the only long straight lines', () => {
    const img = table(400, 520);
    paintPage(img, PAGE, 210, 297, text);
    const result = searchQuad(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, PAGE)).toBeLessThan(2.5);
    expect(result!.offFrame).toBe(false);
  });

  it('extends a quad bounded by a photo edge out to the real page edge', () => {
    const img = table(400, 520);
    // A full-bleed photo across the top third of the page, darker than the
    // table, as on a brochure: the detector stops at its lower edge.
    paintPage(img, PAGE, 210, 297, (u, v) => (v < 100 ? [40, 90, 160] : text(u, v)));
    const planes = colourPlanes(img, 1);
    const toPhoto = homography(
      [
        [0, 0],
        [210, 0],
        [210, 297],
        [0, 297],
      ],
      PAGE,
    );
    const at = (u: number, v: number): Point => applyHomography(toPhoto, u, v);
    const lowerPart: Quad = [at(0, 100), at(210, 100), at(210, 297), at(0, 297)];
    // The detector's quad is a fine quad on its own...
    expect(quadSupported(planes, lowerPart)).toBe(true);
    // ...but the page goes on beyond it.
    const result = searchQuad(planes, { contain: lowerPart });
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, PAGE)).toBeLessThan(2.5);
  });

  it('does not run a side on past the corner along a table edge', () => {
    const img = table(400, 520);
    // A long dark straight edge (the table's) just below the page, in line
    // with nothing on it: a quad down to it has unsupported side ends.
    for (let y = 470; y < 520; y++) {
      for (let x = 0; x < 400; x++) {
        const p = (y * 400 + x) * 4;
        img.data[p] = 30;
        img.data[p + 1] = 30;
        img.data[p + 2] = 35;
      }
    }
    paintPage(img, PAGE, 210, 297, text);
    const result = searchQuad(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, PAGE)).toBeLessThan(2.5);
  });

  it('finds a page that fills nearly the whole frame', () => {
    const img = table(400, 520);
    const big: Quad = [
      [12, 8],
      [392, 14],
      [388, 512],
      [6, 506],
    ];
    paintPage(img, big, 210, 297, text);
    const result = searchQuad(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(maxError(result!.quad, big)).toBeLessThan(2.5);
  });

  it('flags a page running off the frame', () => {
    const img = table(400, 520);
    const off: Quad = [
      [90, 40],
      [450, 70],
      [420, 480],
      [70, 470],
    ];
    paintPage(img, off, 210, 297, text);
    const result = searchQuad(colourPlanes(img, 1));
    expect(result).not.toBeNull();
    expect(result!.offFrame).toBe(true);
    // Its right side is out of view: the frame's border stands in for it.
    const visible: Quad = [
      [90, 40],
      [400, 65.8],
      [400, 479.4],
      [70, 470],
    ];
    expect(maxError(result!.quad, visible)).toBeLessThan(3);
  });

  it('finds nothing on an empty table', () => {
    expect(searchQuad(colourPlanes(table(400, 520), 1))).toBeNull();
  });
});

describe('clipToFrame', () => {
  it('leaves a quad inside the frame alone', () => {
    expect(clipToFrame(PAGE, 400, 520)).toEqual(PAGE);
  });

  it('keeps the visible part of the page, undistorted', () => {
    const off: Quad = [
      [90, 40],
      [450, 70],
      [420, 480],
      [70, 470],
    ];
    const clipped = clipToFrame(off, 400, 520);
    expect(isConvex(clipped)).toBe(true);
    for (const [x, y] of clipped) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(400);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(520);
    }
    // Corners stay on the page's own lines: the left side is untouched, and
    // the cut runs parallel to it in page coordinates.
    expect(
      maxError([clipped[0], clipped[3], off[0], off[3]], [off[0], off[3], off[0], off[3]]),
    ).toBeLessThan(1e-6);
    const toPage = homography(off, [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]);
    const [u1] = applyHomography(toPage, ...clipped[1]);
    const [u2] = applyHomography(toPage, ...clipped[2]);
    expect(u1).toBeCloseTo(u2, 3);
    expect(u1).toBeGreaterThan(0.8);
  });
});
