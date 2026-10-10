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

const BG_TOP = [32, 32, 36];
const BG_BOTTOM = [10, 10, 10];
const PAGE = [255, 255, 255];
const LINE = [170, 170, 176];
const ACCENT = [59, 130, 246];

/** Rounded-rectangle hit test in normalised coordinates. */
function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function sample(x, y, maskable) {
  // Maskable icons are cropped to a circle by the launcher, so the background
  // fills the whole square and the artwork shrinks into the safe zone.
  if (!inRoundedRect(x, y, 0, 0, 1, 1, maskable ? 0 : 0.22)) return [0, 0, 0, 0];

  const t = y;
  let colour = [
    Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
    Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
    Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
  ];

  const scale = maskable ? 0.6 : 0.84;
  const px = (x - 0.5) / scale + 0.5;
  const py = (y - 0.5) / scale + 0.5;

  if (inRoundedRect(px, py, 0.3, 0.17, 0.7, 0.83, 0.04)) {
    colour = PAGE;
    for (const lineY of [0.3, 0.4, 0.5, 0.6]) {
      if (px > 0.36 && px < 0.64 && py > lineY - 0.013 && py < lineY + 0.013) colour = LINE;
    }
    if (px > 0.3 && px < 0.7 && py > 0.685 && py < 0.715) colour = ACCENT;
  }

  return [colour[0], colour[1], colour[2], 255];
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
