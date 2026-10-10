export type PdfImage =
  | { kind: 'jpeg'; bytes: Uint8Array<ArrayBuffer>; components: 1 | 3 }
  | {
      kind: 'flate';
      bytes: Uint8Array<ArrayBuffer>;
      components: 1 | 3;
      /** Rows carry PNG filter bytes (see predict.ts). */
      predictor: boolean;
    };

export interface PdfPage {
  /** Pixel size of the image. */
  pixelWidth: number;
  pixelHeight: number;
  /** Physical page size in points. */
  width: number;
  height: number;
  image: PdfImage;
}

export interface PdfInfo {
  title?: string;
  /** Defaults to now. */
  created?: Date;
}

const encoder = new TextEncoder();

function pdfString(text: string): string {
  // UTF-16BE with BOM, hex-encoded: safe for any title.
  let hex = 'FEFF';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) {
      const v = code - 0x10000;
      hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}'${p(abs % 60)}')`
  );
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Write a PDF with one full-page image per page.
 *
 * Images are embedded as-is: JPEG as DCTDecode, zlib data as FlateDecode, so
 * nothing is re-encoded and the PDF is barely larger than its images.
 * Paperless/OCRmyPDF adds the text layer on ingest.
 */
export function buildPdf(pages: PdfPage[], info: PdfInfo = {}): Blob {
  if (pages.length === 0) throw new Error('A PDF needs at least one page');

  const parts: BlobPart[] = [];
  const offsets: number[] = [];
  let position = 0;
  const push = (chunk: string | Uint8Array<ArrayBuffer>) => {
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    parts.push(bytes);
    position += bytes.length;
  };
  const object = (id: number, body: string, stream?: Uint8Array<ArrayBuffer>) => {
    offsets[id] = position;
    push(`${id} 0 obj\n${body}`);
    if (stream) {
      push('\nstream\n');
      push(stream);
      push('\nendstream');
    }
    push('\nendobj\n');
  };

  // Object ids: 1 catalog, 2 pages, 3 info, then 3 per page (page, content, image).
  const pageId = (i: number) => 4 + i * 3;
  // The second line is a comment of high bytes, telling transfer tools the file is binary.
  push(new Uint8Array([...encoder.encode('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${pageId(i)} 0 R`).join(' ');
  object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  const infoParts = [
    `/Producer ${pdfString('Doc Scanner')}`,
    `/CreationDate ${pdfDate(info.created ?? new Date())}`,
  ];
  if (info.title) infoParts.push(`/Title ${pdfString(info.title)}`);
  object(3, `<< ${infoParts.join(' ')} >>`);

  pages.forEach((page, i) => {
    const id = pageId(i);
    const content = encoder.encode(`q ${num(page.width)} 0 0 ${num(page.height)} 0 0 cm /Im0 Do Q`);
    object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
    );
    object(id + 1, `<< /Length ${content.length} >>`, content);
    const { image } = page;
    const colorSpace = image.components === 1 ? '/DeviceGray' : '/DeviceRGB';
    let filter = '/DCTDecode';
    if (image.kind === 'flate') {
      filter = image.predictor
        ? `/FlateDecode /DecodeParms << /Predictor 15 /Colors ${image.components} /BitsPerComponent 8 /Columns ${page.pixelWidth} >>`
        : '/FlateDecode';
    }
    object(
      id + 2,
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
        `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter ${filter} /Length ${image.bytes.length} >>`,
      image.bytes,
    );
  });

  const count = pageId(pages.length);
  const xref = position;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(parts, { type: 'application/pdf' });
}
