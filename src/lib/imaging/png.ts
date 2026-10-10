const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE_LENGTH = 8;
const IHDR_CHUNK_LENGTH = 25; // length(4) + type(4) + data(13) + crc(4)

/**
 * Insert a pHYs chunk into a PNG so downstream tools know the intended
 * resolution. Canvas never writes one, and without it OCRmyPDF has to guess
 * the DPI, which changes how Tesseract sizes its text detection.
 */
export async function addPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  const source = new Uint8Array(await blob.arrayBuffer());
  const pixelsPerMetre = Math.round(dpi / 0.0254);

  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9); // data length
  chunk[4] = 0x70; // 'p'
  chunk[5] = 0x48; // 'H'
  chunk[6] = 0x59; // 'Y'
  chunk[7] = 0x73; // 's'
  view.setUint32(8, pixelsPerMetre);
  view.setUint32(12, pixelsPerMetre);
  chunk[16] = 1; // unit specifier: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  const insertAt = PNG_SIGNATURE_LENGTH + IHDR_CHUNK_LENGTH;
  const out = new Uint8Array(source.length + chunk.length);
  out.set(source.subarray(0, insertAt), 0);
  out.set(chunk, insertAt);
  out.set(source.subarray(insertAt), insertAt + chunk.length);

  return new Blob([out], { type: 'image/png' });
}
