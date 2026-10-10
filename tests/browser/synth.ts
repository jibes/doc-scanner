/**
 * Browser-only generator of synthetic "phone photos" of a document, used to
 * exercise the detector and filters end to end in the dev server:
 *
 *   const { synthPhoto } = await import('/doc-scanner/tests/browser/synth.ts');
 *
 * A printed page (text, a colour logo, a red stamp, a blue signature) is
 * projected onto a wood-grain table with a lighting gradient, a soft shadow,
 * sensor noise and a touch of lens blur, then JPEG-encoded like a camera would.
 */
import type { Quad } from '../../src/lib/imaging/image';
import { applyHomography, homography } from '../../src/lib/imaging/quad';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function drawPage(width = 1240, height = 1754): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbf8f0';
  g.fillRect(0, 0, width, height);
  const u = width / 1240;

  // Logo.
  g.fillStyle = '#1f6fd1';
  g.beginPath();
  g.arc(140 * u, 150 * u, 52 * u, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f2a900';
  g.fillRect(205 * u, 108 * u, 160 * u, 26 * u);
  g.fillStyle = '#1a1a1a';
  g.font = `bold ${44 * u}px Georgia, serif`;
  g.fillText('ACME Instruments GmbH', 205 * u, 185 * u);

  g.font = `${30 * u}px Georgia, serif`;
  g.fillText('Invoice No. 2026-10-0417', 820 * u, 150 * u);

  const words =
    'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat'.split(
      ' ',
    );
  const r = rng(7);
  g.font = `${24 * u}px Helvetica, Arial, sans-serif`;
  for (let line = 0; line < 34; line++) {
    let x = 110 * u;
    const y = (300 + line * 38) * u;
    if (line % 9 === 8) continue;
    while (x < width - 260 * u) {
      const w = words[Math.floor(r() * words.length)];
      g.fillText(w, x, y);
      x += g.measureText(w + ' ').width;
    }
  }
  // Small print.
  g.font = `${15 * u}px Helvetica, Arial, sans-serif`;
  g.fillText(
    'Registered office: 12 Example Street, 10115 Berlin. VAT DE123456789. Page 1 of 1.',
    110 * u,
    1660 * u,
  );

  // Red stamp.
  g.save();
  g.translate(900 * u, 1450 * u);
  g.rotate(-0.25);
  g.strokeStyle = 'rgba(200, 20, 40, 0.85)';
  g.lineWidth = 6 * u;
  g.strokeRect(-150 * u, -55 * u, 300 * u, 110 * u);
  g.fillStyle = 'rgba(200, 20, 40, 0.85)';
  g.font = `bold ${46 * u}px Helvetica, Arial, sans-serif`;
  g.textAlign = 'center';
  g.fillText('PAID', 0, 16 * u);
  g.restore();

  // Blue signature.
  g.strokeStyle = '#1b3fae';
  g.lineWidth = 3.2 * u;
  g.beginPath();
  g.moveTo(140 * u, 1560 * u);
  for (let i = 0; i < 60; i++) {
    const t = i / 59;
    g.lineTo((140 + t * 320) * u, (1560 - Math.sin(t * 14) * 30 - t * 20) * u);
  }
  g.stroke();
  return c;
}

export interface SynthOptions {
  width?: number;
  height?: number;
  quad?: Quad;
  seed?: number;
  /** 0..1 strength of the diagonal shadow. */
  shadow?: number;
  quality?: number;
}

/** Returns the JPEG and the true corners in photo pixels. */
export async function synthPhoto(options: SynthOptions = {}): Promise<{ blob: Blob; quad: Quad }> {
  const W = options.width ?? 1500;
  const H = options.height ?? 2000;
  const quad: Quad = options.quad ?? [
    [W * 0.17, H * 0.16],
    [W * 0.83, H * 0.19],
    [W * 0.88, H * 0.84],
    [W * 0.11, H * 0.81],
  ];
  const r = rng(options.seed ?? 3);
  const page = drawPage();
  const pctx = page.getContext('2d')!;
  const pd = pctx.getImageData(0, 0, page.width, page.height).data;

  const h = homography(quad, [
    [0, 0],
    [page.width, 0],
    [page.width, page.height],
    [0, page.height],
  ]);
  const out = new ImageData(W, H);
  const od = out.data;
  const shadow = options.shadow ?? 0.35;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      // Lighting: brighter top-left, darker bottom-right, plus a soft shadow band.
      const light =
        (0.95 - 0.3 * ((x / W + y / H) / 2)) *
        (1 - shadow * Math.max(0, Math.min(1, (x / W - y / H + 0.2) * 3)) * 0.6);
      const [u, v] = applyHomography(h, x + 0.5, y + 0.5);
      let R: number;
      let G: number;
      let B: number;
      if (u >= 0 && v >= 0 && u < page.width - 1 && v < page.height - 1) {
        const iu = Math.floor(u);
        const iv = Math.floor(v);
        const fu = u - iu;
        const fv = v - iv;
        const p = (iv * page.width + iu) * 4;
        const q = p + page.width * 4;
        const lerp = (c: number) =>
          (pd[p + c] * (1 - fu) + pd[p + 4 + c] * fu) * (1 - fv) +
          (pd[q + c] * (1 - fu) + pd[q + 4 + c] * fu) * fv;
        R = lerp(0);
        G = lerp(1);
        B = lerp(2);
      } else {
        // Wood grain.
        const grain = Math.sin(x * 0.02 + Math.sin(y * 0.004) * 6) * 0.5 + 0.5;
        R = 120 + grain * 50;
        G = 78 + grain * 32;
        B = 44 + grain * 18;
      }
      const noise = (r() - 0.5) * 10;
      od[o] = R * light + noise;
      od[o + 1] = G * light * 0.97 + noise;
      od[o + 2] = B * light * 0.9 + noise;
      od[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.putImageData(out, 0, 0);
  // Lens softness.
  const soft = document.createElement('canvas');
  soft.width = W;
  soft.height = H;
  const sg = soft.getContext('2d')!;
  sg.filter = 'blur(0.7px)';
  sg.drawImage(c, 0, 0);
  const blob = await new Promise<Blob>((resolve) =>
    soft.toBlob((b) => resolve(b!), 'image/jpeg', options.quality ?? 0.9),
  );
  return { blob, quad };
}
