import type { OcrWord } from './ocr/paddle';

/*
 * A title suggested from the text on the first page: the most prominent line
 * near the top (a letterhead's subject, an invoice's "Rechnung", a ticket's
 * operator), never a date, an amount or a run of reference numbers.
 */

export interface TextLine {
  text: string;
  /** Box in page pixels. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Text height in pixels (the median of its words'). */
  height: number;
  confidence: number;
}

/** Shortest and longest suggestion, in characters. */
const MIN_CHARS = 3;
const MAX_CHARS = 60;
/** Lines this far down the page (as a fraction of its height) are never suggested. */
const MAX_DEPTH = 0.55;
/** Below this mean recognition confidence a line is likely misread. */
const MIN_CONFIDENCE = 0.6;
/** A line must be at least this much taller than the page's typical text to stand out. */
const MIN_PROMINENCE = 1.15;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Words joined into lines: neighbours at the same height, of similar size,
 * without a wide gap between them (so two columns stay two lines).
 */
export function groupLines(words: readonly OcrWord[]): TextLine[] {
  const sorted = [...words]
    .filter((w) => w.text.trim() && w.y1 > w.y0)
    .sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  const lines: OcrWord[][] = [];
  for (const word of sorted) {
    const h = word.y1 - word.y0;
    const centre = (word.y0 + word.y1) / 2;
    const line = lines.find((l) => {
      const last = l.reduce((a, b) => (b.x1 > a.x1 ? b : a));
      const lh = last.y1 - last.y0;
      const lc = (last.y0 + last.y1) / 2;
      const gap = Math.max(word.x0 - last.x1, l[0].x0 - word.x1);
      return (
        Math.abs(centre - lc) < 0.5 * Math.min(h, lh) &&
        Math.max(h, lh) / Math.min(h, lh) < 1.4 &&
        gap < 1.8 * Math.max(h, lh)
      );
    });
    if (line) line.push(word);
    else lines.push([word]);
  }
  return lines.map((l) => {
    l.sort((a, b) => a.x0 - b.x0);
    return {
      text: l.map((w) => w.text).join(' '),
      x0: Math.min(...l.map((w) => w.x0)),
      y0: Math.min(...l.map((w) => w.y0)),
      x1: Math.max(...l.map((w) => w.x1)),
      y1: Math.max(...l.map((w) => w.y1)),
      height: median(l.map((w) => w.y1 - w.y0)),
      confidence: l.reduce((s, w) => s + w.confidence, 0) / l.length,
    };
  });
}

/**
 * The line's text made fit for a title, or null if it is not title material:
 * too short or long, mostly digits (dates, amounts, IBANs), or junk.
 */
export function cleanTitle(text: string): string | null {
  let t = text
    .replace(/\s+/g, ' ')
    // Leaders and trailers: bullets, rules, stray punctuation.
    .replace(/^[^\p{L}\p{N}"„“(]+/u, '')
    .replace(/[^\p{L}\p{N}")”!?.]+$/u, '')
    .replace(/[.:]+$/, '')
    .trim();
  if (t.length < MIN_CHARS || t.length > MAX_CHARS) return null;
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  const digits = (t.match(/\p{N}/gu) ?? []).length;
  if (letters < 3 || letters < 0.6 * t.replace(/ /g, '').length || digits > letters) return null;
  // A word repeated letter by letter, a run of one character: noise or a rule.
  if (/(.)\1{3,}/u.test(t)) return null;
  // Web and mail addresses are contact lines, not titles.
  if (/@|www\.|https?:|\.(de|com|org|net)\b/i.test(t)) return null;
  // SHOUTED headings read better in title case.
  if (t === t.toUpperCase() && letters > 4) {
    t = t
      .toLowerCase()
      .replace(
        /(^|[\s\-/(„"])(\p{L})/gu,
        (_, before: string, c: string) => before + c.toUpperCase(),
      );
  }
  return t;
}

/**
 * How good a title this line makes, or 0 if it should not be suggested.
 * Taller text scores higher; so does text nearer the top. A single short
 * word, or a whole sentence, scores lower than a few words.
 */
export function scoreLine(line: TextLine, typicalHeight: number, pageHeight: number): number {
  const text = cleanTitle(line.text);
  if (!text || line.confidence < MIN_CONFIDENCE) return 0;
  const depth = line.y0 / pageHeight;
  if (depth > MAX_DEPTH) return 0;
  const prominence = line.height / Math.max(1, typicalHeight);
  if (prominence < MIN_PROMINENCE) return 0;
  const words = text.split(' ').length;
  const length = words === 1 ? (text.length >= 6 ? 0.8 : 0.6) : words <= 7 ? 1 : 0.7;
  const position = 1 - 0.8 * (depth / MAX_DEPTH);
  return prominence * position * length * line.confidence;
}

/** A title for a page with these words, placed on a page `height` pixels tall; null if none stands out. */
export function suggestTitle(words: readonly OcrWord[], height: number): string | null {
  const lines = groupLines(words);
  if (lines.length === 0) return null;
  const typical = median(lines.map((l) => l.height));
  let best: { line: TextLine; score: number } | null = null;
  for (const line of lines) {
    const score = scoreLine(line, typical, height);
    if (score > 0 && (!best || score > best.score)) best = { line, score };
  }
  return best ? cleanTitle(best.line.text) : null;
}
