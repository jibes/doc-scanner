#!/usr/bin/env node
/**
 * Generates the PWA icon set into public/.
 *
 * Written by hand rather than pulled from a design tool so the icons stay in
 * sync with the app's palette and the repo has no binary assets to maintain.
 * Run with `npm run icons`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- scene ---- */

/*
 * A page lying slightly askew on a dark desk, one corner dog-eared, framed by
 * four straight crop brackets: what the app does — find the edges, straighten
 * the page. Colours follow src/app.css (desk, paper, accent).
 */
const DESK_TOP = [38, 37, 34];
const DESK_BOTTOM = [14, 14, 13];
const PAPER = [250, 249, 245];
const FOLD = [214, 211, 202];
const INK = [176, 173, 165];
const ACCENT = [77, 124, 240];

const PAGE_CX = 0.5;
const PAGE_CY = 0.52;
const PAGE_HW = 0.2;
const PAGE_HH = 0.27;
const PAGE_R = 0.018;
const TILT = (-7 * Math.PI) / 180;
const EAR = 0.1;

/** Lines of text as [v, from u, to u], in page coordinates. */
const TEXT = [
  [-0.15, -0.13, 0.0],
  [-0.06, -0.13, 0.13],
  [0.0, -0.13, 0.13],
  [0.06, -0.13, 0.08],
  [0.15, -0.13, 0.13],
  [0.21, -0.13, 0.03],
];
const TEXT_HALF = 0.011;

/** Bracket corners and arm length, in icon coordinates. */
const FRAME = { x0: 0.21, y0: 0.17, x1: 0.79, y1: 0.87, arm: 0.12, half: 0.019 };

/** Signed distance to a rounded box centred on the origin. */
function roundBox(u, v, hw, hh, r) {
  const qx = Math.abs(u) - hw + r;
  const qy = Math.abs(v) - hh + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance from a point to a line segment. */
function segment(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

function mix(a, b, t) {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);
}

/** Into page coordinates: centred, untilted; v grows downwards. */
function toPage(x, y) {
  const dx = x - PAGE_CX;
  const dy = y - PAGE_CY;
  const c = Math.cos(-TILT);
  const s = Math.sin(-TILT);
  return [dx * c - dy * s, dx * s + dy * c];
}

function inBracket(x, y) {
  const { x0, y0, x1, y1, arm, half } = FRAME;
  const corners = [
    [x0, y0, 1, 1],
    [x1, y0, -1, 1],
    [x0, y1, 1, -1],
    [x1, y1, -1, -1],
  ];
  return corners.some(
    ([cx, cy, sx, sy]) =>
      segment(x, y, cx, cy, cx + sx * arm, cy) <= half ||
      segment(x, y, cx, cy, cx, cy + sy * arm) <= half,
  );
}

function sample(x, y, maskable) {
  // Maskable icons are cropped by the launcher, so the desk fills the whole
  // square and the artwork shrinks into the safe zone.
  if (roundBox(x - 0.5, y - 0.5, 0.5, 0.5, maskable ? 0 : 0.22) > 0) return [0, 0, 0, 0];

  // The desk: a soft pool of light behind the page.
  const glow = Math.max(0, 1 - Math.hypot(x - 0.5, y - 0.42) / 0.75);
  let colour = mix(DESK_BOTTOM, DESK_TOP, Math.min(1, glow * 1.25));

  const scale = maskable ? 0.74 : 1;
  const px = (x - 0.5) / scale + 0.5;
  const py = (y - 0.5) / scale + 0.5;
  const [u, v] = toPage(px, py);

  // How far into the dog-ear's square, measured from the cut diagonal.
  const ear = PAGE_HW - u + (v + PAGE_HH);
  const cut = ear < EAR;
  const page = roundBox(u, v, PAGE_HW, PAGE_HH, PAGE_R);

  // A soft shadow, cast down and to the right.
  const [su, sv] = toPage(px - 0.012, py - 0.03);
  const shadow = roundBox(su, sv, PAGE_HW, PAGE_HH, PAGE_R);
  if (shadow < 0.06) colour = mix(colour, [0, 0, 0], 0.55 * (1 - Math.max(0, shadow) / 0.06));

  if (page <= 0 && !cut) {
    colour = PAPER;
    const flap = u >= PAGE_HW - EAR && v <= -PAGE_HH + EAR;
    if (flap) {
      colour = FOLD;
      // A hairline where the paper folds over.
      if (ear < EAR + 0.008) colour = mix(FOLD, INK, 0.6);
    } else {
      for (const [lv, from, to] of TEXT) {
        if (segment(u, v, from, lv, to, lv) <= TEXT_HALF) colour = INK;
      }
    }
  }

  if (inBracket(px, py)) colour = ACCENT;

  return [Math.round(colour[0]), Math.round(colour[1]), Math.round(colour[2]), 255];
}

/** Render with 4x4 supersampling so the rounded corners are not jagged. */
function render(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4;
  const samples = ss * ss;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const [cr, cg, cb, ca] = sample(
            (x + (sx + 0.5) / ss) / size,
            (y + (sy + 0.5) / ss) / size,
            maskable,
          );
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const p = (y * size + x) * 4;
      rgba[p] = a > 0 ? Math.round(r / a) : 0;
      rgba[p + 1] = a > 0 ? Math.round(g / a) : 0;
      rgba[p + 2] = a > 0 ? Math.round(b / a) : 0;
      rgba[p + 3] = Math.round(a / samples);
    }
  }

  return rgba;
}

/* ----------------------------------------------------------------- main ---- */

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
  { file: 'apple-touch-icon.png', size: 180, maskable: true },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, maskable } of targets) {
  const png = encodePng(size, render(size, maskable));
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
}
