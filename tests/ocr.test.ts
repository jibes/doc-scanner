import { describe, expect, it } from 'vitest';
import {
  ctcDecode,
  detectionBoxes,
  detectionSize,
  lineWords,
  recognitionInput,
  recognitionWidth,
  REC_HEIGHT,
} from '../src/lib/ocr/paddle';
import { buildPdf } from '../src/lib/pdf/writer';
import { fill } from './helpers';

describe('detection', () => {
  it('sizes the detector input to multiples of 32 within the limit', () => {
    expect(detectionSize(2480, 3508, 1280)).toEqual({ width: 896, height: 1280 });
    expect(detectionSize(100, 50, 1280)).toEqual({ width: 96, height: 64 });
  });

  it('turns the probability map into grown, ordered boxes', () => {
    const w = 200;
    const h = 100;
    const prob = new Float32Array(w * h);
    const paint = (x0: number, y0: number, x1: number, y1: number, p: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) prob[y * w + x] = p;
    };
    paint(110, 20, 180, 30, 0.9); // second word on line 1
    paint(10, 20, 90, 30, 0.9); // first word on line 1
    paint(10, 60, 150, 70, 0.9); // line 2
    paint(10, 85, 40, 95, 0.4); // above threshold, but too unsure
    const boxes = detectionBoxes(prob, w, h);
    expect(boxes).toHaveLength(3);
    expect(boxes[0].x0).toBeLessThan(10);
    expect(boxes[1].x0).toBeGreaterThan(100);
    expect(boxes[2].y0).toBeGreaterThan(50);
    // Grown beyond the kernel on every side.
    expect(boxes[0].y0).toBeLessThan(20);
    expect(boxes[0].y1).toBeGreaterThan(30);
  });

  it('follows a tilted line and ignores a blob touching its end', () => {
    const w = 400;
    const h = 120;
    const prob = new Float32Array(w * h);
    // A line 10 px tall that drops 20 px over 300 px.
    for (let x = 60; x < 360; x++) {
      const top = Math.round(40 + ((x - 60) * 20) / 300);
      for (let y = top; y < top + 10; y++) prob[y * w + x] = 0.9;
    }
    // A smudge touching the line's left end, three times as tall.
    for (let y = 40; y < 75; y++) for (let x = 40; x < 66; x++) prob[y * w + x] = 0.9;
    const [box] = detectionBoxes(prob, w, h);
    expect(box.yr! - box.yl!).toBeGreaterThan(15);
    // Height comes from the line (10 px, grown), not the smudge (35 px).
    expect(box.height!).toBeLessThan(30);
    // The smudge is trimmed off the start.
    expect(box.x0).toBeGreaterThan(45);
  });
});

describe('recognition', () => {
  it('buckets widths so input shapes repeat', () => {
    expect(recognitionWidth(100)).toBe(160);
    expect(recognitionWidth(161)).toBe(224);
    expect(recognitionWidth(5000)).toBe(2400);
    for (const w of [50, 300, 700, 1500]) expect(recognitionWidth(w)).toBeGreaterThanOrEqual(w);
  });

  it('crops, scales to 48 px and pads with white', () => {
    const img = fill(400, 100, [0, 0, 0]);
    const input = recognitionInput(img, { x0: 0, y0: 0, x1: 192, y1: 48, score: 1 });
    expect(input.textWidth).toBe(192);
    expect(input.width).toBe(224);
    expect(input.tensor.length).toBe(3 * REC_HEIGHT * 224);
    expect(input.tensor[0]).toBeCloseTo(-1); // black text area
    expect(input.tensor[223]).toBe(1); // padding is white paper
  });

  it('decodes CTC output, collapsing repeats and blanks', () => {
    const dict = ['a', 'b', 'c'];
    const classes = dict.length + 2; // blank, a, b, c, space
    // a a _ b space c c
    const path = [1, 1, 0, 2, 4, 3, 3];
    const probs = new Float32Array(path.length * classes);
    path.forEach((c, t) => (probs[t * classes + c] = 0.9));
    const line = ctcDecode(probs, path.length, classes, dict);
    expect(line.text).toBe('ab c');
    expect(line.steps).toEqual([0, 3, 4, 5]);
    expect(line.confidence).toBeCloseTo(0.9);
  });

  it('splits a line into words placed where they were read', () => {
    const line = { text: 'Hallo Welt', confidence: 0.95, steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] };
    const box = { x0: 100, y0: 10, x1: 300, y1: 40, score: 1 };
    const words = lineWords(line, box, 10);
    expect(words.map((w) => w.text)).toEqual(['Hallo', 'Welt']);
    expect(words[0].x0).toBeGreaterThanOrEqual(100);
    expect(words[0].x1).toBeLessThan(words[1].x0);
    expect(words[1].x1).toBeLessThanOrEqual(300);
  });
});

describe('searchable PDF', () => {
  it('writes an invisible, positioned text layer with WinAnsi text', async () => {
    const pdf = buildPdf([
      {
        pixelWidth: 1000,
        pixelHeight: 1414,
        width: 595.28,
        height: 841.89,
        image: { kind: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), components: 3 },
        words: [
          { text: 'Grüße', x0: 100, y0: 100, x1: 220, y1: 130 },
          { text: '(1)', x0: 240, y0: 100, x1: 280, y1: 130 },
          { text: '€5', x0: 300, y0: 100, x1: 340, y1: 130 },
        ],
      },
    ]);
    const text = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    expect(text).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
    expect(text).toContain('/Font << /F0 4 0 R >>');
    expect(text).toContain(' BT 3 Tr'); // render mode 3: invisible
    expect(text).toContain('(Gr\\374\\337e) Tj'); // ü ß as WinAnsi octal
    expect(text).toContain('(\\(1\\)) Tj'); // parentheses escaped
    expect(text).toContain('(\\2005) Tj'); // € is 0x80 in WinAnsi
    expect(text).toMatch(/\d+(\.\d+)? Tz 1 0 0 1 [\d.]+ [\d.]+ Tm/);
  });

  it('leaves pages without words image-only', async () => {
    const pdf = buildPdf([
      {
        pixelWidth: 10,
        pixelHeight: 10,
        width: 72,
        height: 72,
        image: { kind: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), components: 3 },
      },
    ]);
    const text = Buffer.from(await pdf.arrayBuffer()).toString('latin1');
    expect(text).not.toContain('BT');
  });
});
