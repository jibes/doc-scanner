import { describe, expect, it } from 'vitest';
import { estimatePaper, flattenPaper } from '../src/lib/imaging/background';
import { boxMean, gaussian } from '../src/lib/imaging/box';
import { labelComponents, removeSmallComponents } from '../src/lib/imaging/components';
import { applyFilter } from '../src/lib/imaging/filters';
import { createFloat, rotateRGBA, type Quad } from '../src/lib/imaging/image';
import { refineQuad } from '../src/lib/imaging/refine';
import { warpQuad } from '../src/lib/imaging/resample';
import { fill, photographedPage, px, setRect } from './helpers';

describe('warpQuad', () => {
  it('is the identity for the full-image quad at the same size', () => {
    const src = photographedPage(64, 48);
    const out = warpQuad(
      src,
      [
        [0, 0],
        [64, 0],
        [64, 48],
        [0, 48],
      ],
      64,
      48,
    );
    for (let i = 0; i < src.data.length; i++) {
      expect(Math.abs(out.data[i] - src.data[i])).toBeLessThanOrEqual(1);
    }
  });

  it('maps quad corners to output corners (a mirrored quad flips the image)', () => {
    const src = fill(40, 40, [255, 255, 255]);
    setRect(src, 0, 0, 10, 10, [0, 0, 0]);
    const mirrored: Quad = [
      [40, 0],
      [0, 0],
      [0, 40],
      [40, 40],
    ];
    const out = warpQuad(src, mirrored, 40, 40);
    expect(px(out, 35, 5)[0]).toBeLessThan(10);
    expect(px(out, 5, 5)[0]).toBeGreaterThan(245);
  });

  it('averages instead of aliasing when shrinking a lot', () => {
    // One-pixel stripes shrunk 8x must come out mid-grey, not striped.
    const src = fill(800, 80, [255, 255, 255]);
    for (let x = 0; x < 800; x += 2) setRect(src, x, 0, x + 1, 80, [0, 0, 0]);
    const out = warpQuad(
      src,
      [
        [0, 0],
        [800, 0],
        [800, 80],
        [0, 80],
      ],
      100,
      10,
    );
    for (let x = 2; x < 98; x++) expect(Math.abs(px(out, x, 5)[0] - 127.5)).toBeLessThan(4);
  });
});

describe('rotateRGBA', () => {
  it('rotates clockwise in quarter turns', () => {
    const src = fill(3, 2, [255, 255, 255]);
    setRect(src, 0, 0, 1, 1, [0, 0, 0]); // top-left marker
    const r1 = rotateRGBA(src, 1);
    expect([r1.width, r1.height]).toEqual([2, 3]);
    expect(px(r1, 1, 0)[0]).toBe(0); // now top-right
    const r2 = rotateRGBA(src, 2);
    expect(px(r2, 2, 1)[0]).toBe(0); // now bottom-right
    expect(rotateRGBA(src, 4)).toBe(src);
  });
});

describe('box filters', () => {
  it('boxMean preserves a constant and a linear ramp', () => {
    const img = createFloat(50, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 50; x++) img.data[y * 50 + x] = x / 49;
    const out = boxMean(img, 4);
    // Mirrored borders keep a linear ramp centred, except right at the edge.
    for (let x = 5; x < 45; x++) expect(out.data[5 * 50 + x]).toBeCloseTo(x / 49, 5);
  });

  it('gaussian keeps the mean and spreads an impulse', () => {
    const img = createFloat(21, 21);
    img.data[10 * 21 + 10] = 1;
    const out = gaussian(img, 1);
    const sum = out.data.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 4);
    expect(out.data[10 * 21 + 10]).toBeCloseTo(1 / (2 * Math.PI), 2);
  });
});

describe('components', () => {
  it('labels 8-connected blobs and drops small ones', () => {
    const w = 10;
    const mask = new Uint8Array(w * w);
    // A diagonal (8-connected) line of 4 and an isolated pixel.
    for (let i = 0; i < 4; i++) mask[i * w + i] = 1;
    mask[9 * w + 9] = 1;
    const { labels, areas } = labelComponents(mask, w, w);
    expect(labels[0]).toBe(labels[3 * w + 3]);
    expect(areas[labels[0]]).toBe(4);
    removeSmallComponents(mask, w, w, 2);
    expect(mask[9 * w + 9]).toBe(0);
    expect(mask[0]).toBe(1);
  });

  it('merges a U shape that only connects at the bottom', () => {
    const w = 5;
    const mask = new Uint8Array([1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
    const { labels, areas } = labelComponents(mask, w, 3);
    expect(labels[0]).toBe(labels[4]);
    expect(areas[labels[0]]).toBe(9);
  });
});

describe('flattenPaper', () => {
  it('turns unevenly lit paper white and keeps ink dark, without halos', () => {
    const src = photographedPage();
    const grid = estimatePaper(src);
    expect(grid.cols * grid.rows).toBeGreaterThan(100);
    const flat = flattenPaper(src, grid);
    // Paper at the dark and the bright end of the gradient.
    expect(px(flat, 30, 400)[0]).toBeGreaterThan(240);
    expect(px(flat, 580, 400)[0]).toBeGreaterThan(240);
    // Paper directly between two text strokes is still paper.
    expect(px(flat, 100, 212)[1]).toBeGreaterThan(235);
    // Ink stays far below paper.
    expect(px(flat, 100, 201)[0]).toBeLessThan(80);
  });
});

describe('applyFilter', () => {
  const src = photographedPage();

  function stats(img: ReturnType<typeof applyFilter>) {
    let white = 0;
    for (let p = 0; p < img.data.length; p += 4) {
      if (img.data[p] === 255 && img.data[p + 1] === 255 && img.data[p + 2] === 255) white++;
    }
    return { white: white / (img.width * img.height) };
  }

  it('document: pure white paper, pure black text cores, colour kept', () => {
    const out = applyFilter(src, 'document');
    expect(stats(out).white).toBeGreaterThan(0.75);
    // Middle row of a 3 px stroke.
    expect(px(out, 120, 201)).toEqual([0, 0, 0]);
    // Logo stays blue.
    const [r, , b] = px(out, 100, 100);
    expect(b).toBeGreaterThan(150);
    expect(r).toBeLessThan(90);
    // Stamp outline stays red.
    const [sr, sg] = px(out, 382, 680);
    expect(sr).toBeGreaterThan(150);
    expect(sg).toBeLessThan(90);
  });

  it('does not blur: a stroke edge goes from black to white within 2 px', () => {
    const out = applyFilter(src, 'bw');
    // Column through a stroke at x=120: rows 200..202 are ink.
    const column = [196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206].map(
      (y) => px(out, 120, y)[0],
    );
    const intermediate = column.filter((v) => v > 10 && v < 245).length;
    expect(intermediate).toBeLessThanOrEqual(2);
    expect(Math.min(...column)).toBe(0);
    expect(column[0]).toBe(255);
    expect(column.at(-1)).toBe(255);
  });

  it('bw: solid dark shapes are filled, not hollow', () => {
    const out = applyFilter(src, 'bw');
    for (const [x, y] of [
      [100, 100],
      [100, 70],
      [125, 100],
    ]) {
      expect(px(out, x, y)[0]).toBeLessThan(30);
    }
  });

  it('removes a strip of table grazed by the crop at the border', () => {
    const page = photographedPage();
    setRect(page, 0, 0, 4, page.height, [60, 40, 25]);
    const out = applyFilter(page, 'bw');
    for (let y = 10; y < page.height; y += 50) expect(px(out, 1, y)[0]).toBe(255);
  });

  it('removes isolated specks but keeps text', () => {
    const page = photographedPage();
    // A lone dark pixel: at this page size a real full stop is 2-3 px across.
    setRect(page, 300, 150, 301, 151, [20, 20, 20]);
    const out = applyFilter(page, 'bw');
    expect(px(out, 300, 150)[0]).toBe(255);
    expect(px(out, 120, 201)[0]).toBe(0);
  });

  it('gray and bw are neutral, original keeps the photo', () => {
    for (const filter of ['gray', 'bw'] as const) {
      const out = applyFilter(src, filter);
      for (let p = 0; p < out.data.length; p += 4 * 97) {
        expect(out.data[p]).toBe(out.data[p + 1]);
        expect(out.data[p + 1]).toBe(out.data[p + 2]);
      }
    }
    const original = applyFilter(src, 'original', {
      ...{ brightness: 0, contrast: 0, threshold: 0 },
      sharpen: 0,
    });
    expect(original).toBe(src);
  });

  it('is deterministic', () => {
    const a = applyFilter(src, 'document');
    const b = applyFilter(src, 'document');
    expect(Buffer.from(a.data).equals(Buffer.from(b.data))).toBe(true);
  });
});

describe('refineQuad', () => {
  it('snaps a rough quad onto the real page edges', () => {
    // Bright page on a dark table.
    const img = createFloat(400, 500);
    const truth: Quad = [
      [80.3, 60.7],
      [330.5, 75.2],
      [350.8, 440.4],
      [60.6, 420.9],
    ];
    // Rasterise with 4x4 supersampling so the edges are anti-aliased.
    const inside = (x: number, y: number) => {
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = truth[i];
        const [bx, by] = truth[(i + 1) % 4];
        if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false;
      }
      return true;
    };
    for (let y = 0; y < 500; y++) {
      for (let x = 0; x < 400; x++) {
        let hits = 0;
        for (let sy = 0; sy < 4; sy++)
          for (let sx = 0; sx < 4; sx++)
            hits += inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4) ? 1 : 0;
        img.data[y * 400 + x] = 0.25 + 0.65 * (hits / 16);
      }
    }
    const rough = truth.map(([x, y], i) => [
      x + (i % 2 ? 6 : -5),
      y + (i < 2 ? -4 : 5),
    ]) as unknown as Quad;
    const refined = refineQuad(img, rough);
    for (let i = 0; i < 4; i++) {
      expect(Math.hypot(refined[i][0] - truth[i][0], refined[i][1] - truth[i][1])).toBeLessThan(
        0.75,
      );
    }
  });

  it('keeps the input when there is no edge to find', () => {
    const flat = createFloat(200, 200);
    flat.data.fill(0.5);
    const quad: Quad = [
      [20, 20],
      [180, 20],
      [180, 180],
      [20, 180],
    ];
    expect(refineQuad(flat, quad)).toEqual(quad);
  });
});

/**
 * Paint a rectangle with camera-like soft edges: coverage ramps linearly over
 * `blur` pixels across each edge, centred on the true edge.
 */
function softRect(
  img: ReturnType<typeof fill>,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  level: number,
  blur = 3,
) {
  const pad = Math.ceil(blur);
  for (
    let y = Math.max(0, Math.floor(y0) - pad);
    y < Math.min(img.height, Math.ceil(y1) + pad);
    y++
  ) {
    for (
      let x = Math.max(0, Math.floor(x0) - pad);
      x < Math.min(img.width, Math.ceil(x1) + pad);
      x++
    ) {
      const cx = Math.min(1, Math.max(0, Math.min(x + 0.5 - x0, x1 - x - 0.5) / blur + 0.5));
      const cy = Math.min(1, Math.max(0, Math.min(y + 0.5 - y0, y1 - y - 0.5) / blur + 0.5));
      const coverage = cx * cy;
      const p = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        img.data[p + c] = Math.min(img.data[p + c], 235 - (235 - level) * coverage);
      }
    }
  }
}

describe('text fidelity on a camera-blurred page', () => {
  // A4-proportioned page, so the size-relative rules see a realistic page.
  const W = 1240;
  const H = 1754;

  function page() {
    const img = fill(W, H, [235, 235, 235]);
    // Body text stand-ins: 4 px strokes, dark, soft edges.
    for (let i = 0; i < 6; i++) softRect(img, 300 + i * 40, 400, 304 + i * 40, 440, 20);
    // An umlaut-sized dot: 5x5.
    softRect(img, 700, 400, 705, 405, 20, 1.5);
    // A thin grey table rule, crisp.
    softRect(img, 150, 700, 1100, 702, 120, 1.2);
    // A fold: a faint, soft horizontal shadow band across part of the page.
    softRect(img, 400, 1000, 900, 1004, 175, 6);
    // Punch-hole shadows: two crescent-ish dark marks 12 mm from the left
    // edge, 80 mm apart (on A4 at this size: x ~ 71 px, gap ~ 472 px).
    softRect(img, 58, 700, 86, 712, 60, 2);
    softRect(img, 58, 1172, 86, 1184, 60, 2);
    return img;
  }

  const out = applyFilter(page(), 'document');

  it('keeps the true stroke width instead of fattening it', () => {
    // Count ink pixels across one 4 px stroke.
    let ink = 0;
    for (let x = 290; x < 316; x++) ink += 1 - px(out, x, 420)[0] / 255;
    expect(ink).toBeGreaterThan(3);
    expect(ink).toBeLessThan(5);
  });

  it('keeps small dots such as umlauts', () => {
    expect(px(out, 702, 402)[0]).toBeLessThan(60);
  });

  it('keeps a thin grey rule along its whole length, and grey', () => {
    for (let x = 170; x < 1080; x += 50) {
      const v = Math.min(px(out, x, 700)[0], px(out, x, 701)[0]);
      expect(v).toBeLessThan(200);
    }
    expect(px(out, 600, 700)[0]).toBeGreaterThan(20);
  });

  it('removes fold shading', () => {
    for (let x = 420; x < 880; x += 40) expect(px(out, x, 1002)[0]).toBe(255);
  });

  it('removes a pair of punch holes but not a single mark', () => {
    expect(px(out, 72, 706)[0]).toBe(255);
    expect(px(out, 72, 1178)[0]).toBe(255);
    const single = page();
    // Paint over the second hole: now there is only one, so it is not a hole.
    for (let y = 1165; y < 1192; y++)
      for (let x = 50; x < 95; x++) {
        const p = (y * W + x) * 4;
        single.data[p] = single.data[p + 1] = single.data[p + 2] = 235;
      }
    expect(px(applyFilter(single, 'document'), 72, 706)[0]).toBeLessThan(100);
  });
});
