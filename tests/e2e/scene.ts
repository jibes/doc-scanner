/**
 * Synthetic phone photos of a corpus document (tests/e2e/corpus.ts) with
 * known corners. The page is placed in 3D in front of a pinhole camera with a
 * phone-like field of view (26 mm equivalent), so perspective is physically
 * consistent, then lit, shadowed, creased, blurred, made noisy and JPEG
 * encoded. Generalises tests/browser/synth.ts.
 */
import type { Quad } from '../../src/lib/imaging/image';
import { applyHomography, homography } from '../../src/lib/imaging/quad';
import { renderDoc, rng, type DocSpec } from './corpus';

export interface Scene {
  /** Photo size in pixels. */
  width: number;
  height: number;
  background: 'wood' | 'dark' | 'white' | 'desk';
  /** Camera tilt (deg): pitch about the page's x axis, yaw about y, roll about the view axis. */
  pitch: number;
  yaw: number;
  roll: number;
  /** Fraction of the frame the page's bounding box fills. */
  fill: number;
  /** Page centre offset as a fraction of the frame size. */
  offset?: [number, number];
  /** Lighting: linear falloff across the frame (0..1) and vignetting. */
  gradient: number;
  vignette: number;
  /** Overall exposure before the camera's gain (1 = normal). */
  exposure: number;
  /** Strong hand/phone shadow over the page (0..1 darkening). */
  hand?: number;
  /** Fold creases and crumple shading. */
  creases?: number;
  crumple?: number;
  /** Sensor noise sigma (8-bit units, before gain). */
  noise: number;
  /** Lens blur sigma, px. */
  lens: number;
  /** Motion blur length (px) and angle (deg). */
  motion?: [number, number];
  jpeg: number;
  seed: number;
}

export const BASE_SCENE: Scene = {
  width: 3024,
  height: 4032,
  background: 'wood',
  pitch: 12,
  yaw: -6,
  roll: 3,
  fill: 0.82,
  gradient: 0.25,
  vignette: 0.15,
  exposure: 1,
  noise: 3,
  lens: 0.8,
  jpeg: 0.9,
  seed: 3,
};

export interface Case {
  id: string;
  doc: string;
  title: string;
  scene: Partial<Scene>;
  /** Whether the capture should be flagged as blurred. */
  expectBlurred?: boolean;
  /** Colour/photo case: OCR every filter's output, not just the PDF's. */
  allFilters?: boolean;
}

export const CASES: Case[] = [
  { id: 'letter_a4', doc: 'letter_a4', title: 'Plain typed letter (A4)', scene: {} },
  {
    id: 'invoice',
    doc: 'invoice',
    title: 'Invoice: table, logo, red stamp, blue signature',
    scene: { pitch: 8, yaw: 10, roll: -4 },
  },
  {
    id: 'receipt',
    doc: 'receipt',
    title: 'Thermal receipt, faint grey print',
    scene: { fill: 0.86, pitch: 10, roll: 2, background: 'desk' },
  },
  {
    id: 'contract',
    doc: 'contract',
    title: 'Small-print contract (7 pt)',
    scene: { fill: 0.9, pitch: 6 },
  },
  {
    id: 'handwritten',
    doc: 'handwritten',
    title: 'Handwriting-style note (blue ink)',
    scene: { roll: -5 },
  },
  { id: 'form', doc: 'form', title: 'Form: grey boxes, tints, highlighter', scene: { yaw: 8 } },
  {
    id: 'brochure',
    doc: 'brochure',
    title: 'Colour brochure with photo',
    scene: { pitch: 15, background: 'desk' },
  },
  {
    id: 'idcard',
    doc: 'idcard',
    title: 'ID-card-sized card',
    scene: { fill: 0.75, pitch: 10, roll: 8, background: 'dark' },
  },
  { id: 'us_letter', doc: 'us_letter', title: 'US Letter memo', scene: { pitch: 5, yaw: 4 } },
  {
    id: 'landscape',
    doc: 'landscape',
    title: 'Landscape A4 page',
    scene: { width: 4032, height: 3024, pitch: 10 },
  },
  {
    id: 'two_column',
    doc: 'two_column',
    title: 'Dense two-column article',
    scene: { fill: 0.9, pitch: 5 },
  },
  { id: 'german', doc: 'german', title: 'German: umlauts, ß, €, quotes, dashes', scene: {} },
  { id: 'faded', doc: 'faded', title: 'Very low contrast, faded print', scene: { exposure: 0.85 } },
  {
    id: 'hand_shadow',
    doc: 'invoice',
    title: 'Strong hand shadow across the page',
    scene: { hand: 0.6, pitch: 10 },
  },
  {
    id: 'crumpled',
    doc: 'letter_a4',
    title: 'Crumpled page with creases',
    scene: { creases: 5, crumple: 0.12, seed: 8 },
  },
  {
    id: 'steep',
    doc: 'us_letter',
    title: 'Steep perspective (~40 deg)',
    scene: { pitch: 40, yaw: 8, fill: 0.92 },
  },
  {
    id: 'offframe',
    doc: 'letter_a4',
    title: 'Page partly off-frame',
    scene: { fill: 0.95, offset: [0.12, 0.06] },
  },
  {
    id: 'dark_bg',
    doc: 'german',
    title: 'Page on a black background',
    scene: { background: 'dark' },
  },
  {
    id: 'white_on_white',
    doc: 'letter_a4',
    title: 'White page on a white table',
    scene: { background: 'white', gradient: 0.15 },
  },
  {
    id: 'low_light',
    doc: 'invoice',
    title: 'Low light, heavy noise',
    scene: { exposure: 0.3, noise: 4, lens: 1.1 },
  },
  {
    id: 'motion_blur',
    doc: 'letter_a4',
    title: 'Motion blur',
    scene: { motion: [18, 20] },
    expectBlurred: true,
  },
  {
    id: 'rot90',
    doc: 'letter_a4',
    title: 'Page rotated 90 deg in frame',
    scene: { roll: 92, fill: 0.95 },
  },
  { id: 'rot180', doc: 'invoice', title: 'Page rotated 180 deg in frame', scene: { roll: 178 } },
  // Colour and photo content.
  {
    id: 'paper_yellow',
    doc: 'paper_yellow',
    title: 'Pastel yellow paper',
    scene: { pitch: 9 },
    allFilters: true,
  },
  {
    id: 'paper_pink',
    doc: 'paper_pink',
    title: 'Pastel pink paper',
    scene: { yaw: 7, background: 'desk' },
    allFilters: true,
  },
  {
    id: 'paper_blue',
    doc: 'paper_blue',
    title: 'Light blue paper',
    scene: { roll: -3 },
    allFilters: true,
  },
  {
    id: 'flyer_blue',
    doc: 'flyer_blue',
    title: 'Mid-blue flyer, white + black text',
    scene: { pitch: 10, background: 'desk' },
    allFilters: true,
  },
  {
    id: 'flyer_green',
    doc: 'flyer_green',
    title: 'Dark green flyer, white + black text',
    scene: { yaw: -8 },
    allFilters: true,
  },
  {
    id: 'gradient_vertical',
    doc: 'gradient_vertical',
    title: 'Full-page gradient (top to bottom)',
    scene: {},
    allFilters: true,
  },
  {
    id: 'gradient_diagonal',
    doc: 'gradient_diagonal',
    title: 'Full-page gradient (diagonal)',
    scene: { pitch: 8, background: 'desk' },
    allFilters: true,
  },
  {
    id: 'bands',
    doc: 'bands',
    title: 'Dark header/footer bands, callouts',
    scene: { yaw: 6 },
    allFilters: true,
  },
  { id: 'photos', doc: 'photos', title: 'Embedded photos', scene: { pitch: 12 }, allFilters: true },
  {
    id: 'coloured_text',
    doc: 'coloured_text',
    title: 'Coloured text, links, thin coloured rules/chart',
    scene: { roll: 2 },
    allFilters: true,
  },
];

export interface Photo {
  blob: Blob;
  /** True page corners (page TL, TR, BR, BL) in photo pixel-edge coordinates. */
  quad: Quad;
  width: number;
  height: number;
}

type V3 = [number, number, number];

function rotation(pitch: number, yaw: number, roll: number): number[][] {
  const [a, b, c] = [pitch, yaw, roll].map((d) => (d * Math.PI) / 180);
  const rx = [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ];
  const ry = [
    [Math.cos(b), 0, Math.sin(b)],
    [0, 1, 0],
    [-Math.sin(b), 0, Math.cos(b)],
  ];
  const rz = [
    [Math.cos(c), -Math.sin(c), 0],
    [Math.sin(c), Math.cos(c), 0],
    [0, 0, 1],
  ];
  const mul = (p: number[][], q: number[][]) =>
    p.map((row) => q[0].map((_, j) => row.reduce((s, v, k) => s + v * q[k][j], 0)));
  return mul(rz, mul(rx, ry));
}

/** Page corners projected into the photo. */
export function projectCorners(doc: DocSpec, s: Scene): Quad {
  const f = (26 / 43.27) * Math.hypot(s.width, s.height);
  const R = rotation(s.pitch, s.yaw, s.roll);
  const w = doc.widthMm;
  const h = doc.heightMm;
  const corners: V3[] = [
    [-w / 2, -h / 2, 0],
    [w / 2, -h / 2, 0],
    [w / 2, h / 2, 0],
    [-w / 2, h / 2, 0],
  ];
  const [ox, oy] = s.offset ?? [0, 0];
  const project = (d: number) =>
    corners.map(([x, y, z]) => {
      const X = R[0][0] * x + R[0][1] * y + R[0][2] * z + (ox * s.width * d) / f;
      const Y = R[1][0] * x + R[1][1] * y + R[1][2] * z + (oy * s.height * d) / f;
      const Z = R[2][0] * x + R[2][1] * y + R[2][2] * z + d;
      return [s.width / 2 + (f * X) / Z, s.height / 2 + (f * Y) / Z] as const;
    });
  let d = 500;
  for (let i = 0; i < 6; i++) {
    const q = project(d);
    const xs = q.map((p) => p[0]);
    const ys = q.map((p) => p[1]);
    const ratio = Math.max(
      (Math.max(...xs) - Math.min(...xs)) / (s.width * s.fill),
      (Math.max(...ys) - Math.min(...ys)) / (s.height * s.fill),
    );
    d *= ratio;
  }
  const q = project(d);
  return [q[0], q[1], q[2], q[3]];
}

function gaussNoise(r: () => number): number {
  return (r() + r() + r() + r() - 2) * 1.732;
}

/** Smooth value noise in [−1, 1]. */
function valueNoise(seed: number, cells: number) {
  const r = rng(seed);
  const n = cells + 2;
  const grid = new Float32Array(n * n).map(() => r() * 2 - 1);
  return (u: number, v: number) => {
    const x = Math.max(0, Math.min(cells, u * cells));
    const y = Math.max(0, Math.min(cells, v * cells));
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const g = (i: number, j: number) => grid[j * n + i];
    return (
      (g(ix, iy) * (1 - sx) + g(ix + 1, iy) * sx) * (1 - sy) +
      (g(ix, iy + 1) * (1 - sx) + g(ix + 1, iy + 1) * sx) * sy
    );
  };
}

function handMask(s: Scene): Float32Array {
  // A hand and forearm entering from the lower right, blurred into a soft shadow.
  const scale = 0.25;
  const w = Math.round(s.width * scale);
  const h = Math.round(s.height * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.filter = `blur(${Math.round(w * 0.02)}px)`;
  g.fillStyle = '#fff';
  g.beginPath();
  g.ellipse(w * 0.78, h * 0.72, w * 0.2, h * 0.13, -0.6, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(w * 0.85, h * 0.75);
  g.lineTo(w * 1.1, h * 1.05);
  g.lineTo(w * 1.1, h * 0.7);
  g.fill();
  g.lineCap = 'round';
  g.strokeStyle = '#fff';
  g.lineWidth = w * 0.05;
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    g.moveTo(w * (0.68 + i * 0.04), h * (0.66 - i * 0.015));
    g.lineTo(w * (0.42 + i * 0.07), h * (0.48 - i * 0.03));
    g.stroke();
  }
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Float32Array(s.width * s.height);
  for (let y = 0; y < s.height; y++) {
    const sy = Math.min(h - 1, Math.floor(y * scale));
    for (let x = 0; x < s.width; x++) {
      out[y * s.width + x] = d[(sy * w + Math.min(w - 1, Math.floor(x * scale))) * 4] / 255;
    }
  }
  return out;
}

export async function photograph(doc: DocSpec, overrides: Partial<Scene>): Promise<Photo> {
  const s: Scene = { ...BASE_SCENE, ...overrides };
  const W = s.width;
  const H = s.height;
  const quad = projectCorners(doc, s);
  // Render the page at about 1.25x its projected size (no aliasing, sharp text).
  const projected = Math.max(
    Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]) / doc.widthMm,
    Math.hypot(quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]) / doc.heightMm,
  );
  const pxPerMm = Math.max(4, projected * 1.25);
  const page = renderDoc(doc, pxPerMm);
  const pw = page.width;
  const ph = page.height;
  const pd = page.getContext('2d')!.getImageData(0, 0, pw, ph).data;
  const toPage = homography(quad, [
    [0, 0],
    [pw, 0],
    [pw, ph],
    [0, ph],
  ]);

  const r = rng(s.seed);
  const crumple = s.crumple ? valueNoise(s.seed + 1, 7) : null;
  const crumple2 = s.crumple ? valueNoise(s.seed + 2, 19) : null;
  const creases: { a: number; b: number; c: number; sign: number }[] = [];
  for (let i = 0; i < (s.creases ?? 0); i++) {
    const angle = r() * Math.PI;
    const a = Math.cos(angle);
    const b = Math.sin(angle);
    // Line a*u + b*v = c through a random point on the page (u, v in 0..1 of width).
    const u0 = 0.2 + r() * 0.6;
    const v0 = 0.2 + r() * 0.6;
    creases.push({ a, b, c: a * u0 + b * v0 * (ph / pw), sign: r() > 0.5 ? 1 : -1 });
  }
  const hand = s.hand ? handMask(s) : null;
  const mmPerPx = doc.widthMm / pw;

  const out = new ImageData(W, H);
  const od = out.data;
  const gain = 1 / Math.max(0.2, s.exposure);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const nx = x / W - 0.5;
      const ny = y / H - 0.5;
      let light =
        (1 - s.gradient * (nx * 0.8 + ny * 0.6 + 0.5)) *
        (1 - s.vignette * (nx * nx + ny * ny) * 2) *
        s.exposure;
      if (hand) light *= 1 - (s.hand ?? 0) * hand[y * W + x];
      const [u, v] = applyHomography(toPage, x + 0.5, y + 0.5);
      let R: number;
      let G: number;
      let B: number;
      if (u >= 0 && v >= 0 && u < pw - 1 && v < ph - 1) {
        const iu = Math.floor(u - 0.5 < 0 ? 0 : u - 0.5);
        const iv = Math.floor(v - 0.5 < 0 ? 0 : v - 0.5);
        const fu = Math.min(1, Math.max(0, u - 0.5 - iu));
        const fv = Math.min(1, Math.max(0, v - 0.5 - iv));
        const p = (iv * pw + iu) * 4;
        const q = p + pw * 4;
        const lerp = (k: number) =>
          (pd[p + k] * (1 - fu) + pd[p + 4 + k] * fu) * (1 - fv) +
          (pd[q + k] * (1 - fu) + pd[q + 4 + k] * fu) * fv;
        R = lerp(0);
        G = lerp(1);
        B = lerp(2);
        let shade = 1;
        if (crumple && crumple2) {
          shade *=
            1 + (s.crumple ?? 0) * (crumple(u / pw, v / ph) * 0.7 + crumple2(u / pw, v / ph) * 0.3);
        }
        for (const c of creases) {
          // Signed distance in mm from the crease.
          const dmm = (c.a * u + c.b * v - c.c * pw) * mmPerPx * c.sign;
          shade *=
            1 -
            0.07 / (1 + Math.exp(-dmm / 1.5)) -
            0.16 * Math.exp(-(dmm * dmm) / (2 * 0.25 * 0.25));
          if (dmm > 0 && dmm < 1.2) shade *= 1 + 0.04 * (1.2 - dmm);
        }
        light *= shade;
      } else {
        // Background; a soft drop shadow next to the page edge.
        const du = u < 0 ? -u : u > pw ? u - pw : 0;
        const dv = v < 0 ? -v : v > ph ? v - ph : 0;
        const dist = Math.hypot(du, dv) * mmPerPx;
        light *= 1 - 0.3 * Math.exp(-dist / 2.5);
        if (s.background === 'wood') {
          const grain = Math.sin(x * 0.006 + Math.sin(y * 0.0013) * 6) * 0.5 + 0.5;
          R = 120 + grain * 50;
          G = 78 + grain * 32;
          B = 44 + grain * 18;
        } else if (s.background === 'dark') {
          const t = Math.sin(x * 0.05) * Math.sin(y * 0.05) * 4;
          R = 26 + t;
          G = 26 + t;
          B = 30 + t;
        } else if (s.background === 'white') {
          const t = Math.sin(x * 0.01 + y * 0.003) * 3;
          R = 236 + t;
          G = 236 + t;
          B = 232 + t;
        } else {
          // Grey office desk with a slight speckle.
          const t = ((x * 7 + y * 13) % 17) / 17;
          R = 150 + t * 6;
          G = 152 + t * 6;
          B = 156 + t * 6;
        }
      }
      const n = gaussNoise(r) * s.noise;
      const lum = light;
      od[o] = (R * lum + n + gaussNoise(r) * s.noise * 0.4) * gain * 1.0;
      od[o + 1] = (G * lum * 0.98 + n) * gain;
      od[o + 2] = (B * lum * 0.92 + n + gaussNoise(r) * s.noise * 0.4) * gain;
      od[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.getContext('2d')!.putImageData(out, 0, 0);
  let current: HTMLCanvasElement = c;
  if (s.motion) {
    const [len, angle] = s.motion;
    const m = document.createElement('canvas');
    m.width = W;
    m.height = H;
    const g = m.getContext('2d')!;
    const steps = Math.max(2, Math.round(len));
    const dx = Math.cos((angle * Math.PI) / 180);
    const dy = Math.sin((angle * Math.PI) / 180);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1) - 0.5;
      g.globalAlpha = 1 / (i + 1);
      g.drawImage(current, t * len * dx, t * len * dy);
    }
    current = m;
  }
  const soft = document.createElement('canvas');
  soft.width = W;
  soft.height = H;
  const sg = soft.getContext('2d')!;
  sg.filter = `blur(${s.lens}px)`;
  sg.drawImage(current, 0, 0);
  const blob = await new Promise<Blob>((resolve) =>
    soft.toBlob((b) => resolve(b!), 'image/jpeg', s.jpeg),
  );
  return { blob, quad, width: W, height: H };
}
