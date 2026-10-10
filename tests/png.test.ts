import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { addPngDpi, crc32 } from '../src/lib/imaging/png';

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

/** A structurally valid, if tiny, PNG. */
function makePng(width: number, height: number, extra: Buffer[] = []): Uint8Array<ArrayBuffer> {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = y * (stride + 1) + 1 + x * 4;
      raw[p] = 255;
      raw[p + 1] = 0;
      raw[p + 2] = 0;
      raw[p + 3] = 255;
    }
  }

  // `Uint8Array.from` gives a plain ArrayBuffer-backed view, which is what
  // Blob accepts; a Node Buffer is typed as ArrayBufferLike.
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      ...extra,
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926);
  });

  it('is zero for empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('addPngDpi', () => {
  it('inserts a pHYs chunk directly after IHDR', async () => {
    const original = makePng(2, 2);
    const result = new Uint8Array(await (await addPngDpi(new Blob([original]), 300)).arrayBuffer());

    // Signature and IHDR are untouched.
    expect(Array.from(result.subarray(0, 33))).toEqual(Array.from(original.subarray(0, 33)));

    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    expect(view.getUint32(33)).toBe(9); // chunk data length
    expect(String.fromCharCode(...result.subarray(37, 41))).toBe('pHYs');

    const pixelsPerMetre = Math.round(300 / 0.0254);
    expect(view.getUint32(41)).toBe(pixelsPerMetre);
    expect(view.getUint32(45)).toBe(pixelsPerMetre);
    expect(result[49]).toBe(1); // unit: metre

    // Everything after the original IHDR survives, shifted by the chunk size.
    expect(Array.from(result.subarray(54))).toEqual(Array.from(original.subarray(33)));
  });

  it('produces a chunk whose CRC validates', async () => {
    const result = new Uint8Array(
      await (await addPngDpi(new Blob([makePng(1, 1)]), 200)).arrayBuffer(),
    );
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    const stored = view.getUint32(50);
    expect(stored).toBe(crc32(result.subarray(37, 50)));
  });

  it('scales the pixel density with the requested DPI', async () => {
    const read = async (dpi: number) => {
      const bytes = new Uint8Array(
        await (await addPngDpi(new Blob([makePng(1, 1)]), dpi)).arrayBuffer(),
      );
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(41);
    };
    expect(await read(150)).toBe(Math.round(150 / 0.0254));
    expect(await read(600)).toBe(Math.round(600 / 0.0254));
  });
});

describe('addPngDpi with an existing pHYs', () => {
  it('replaces it instead of adding a second one', async () => {
    const phys = Buffer.alloc(9);
    phys.writeUInt32BE(2835, 0); // 72 dpi
    phys.writeUInt32BE(2835, 4);
    phys[8] = 1;
    const original = makePng(2, 2, [chunk('pHYs', phys)]);
    const result = new Uint8Array(await (await addPngDpi(new Blob([original]), 300)).arrayBuffer());

    expect(result.length).toBe(original.length);
    const text = String.fromCharCode(...result);
    expect(text.split('pHYs').length - 1).toBe(1);
    const view = new DataView(result.buffer);
    expect(view.getUint32(41)).toBe(Math.round(300 / 0.0254));
  });
});
