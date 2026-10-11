import { describe, expect, it } from 'vitest';
import type { OcrWord } from '../src/lib/ocr/paddle';
import { cleanTitle, groupLines, scoreLine, suggestTitle } from '../src/lib/titleSuggest';

/** Words of one line, `h` pixels tall, starting at (x, y), with a space of h/2 between them. */
function line(text: string, x: number, y: number, h: number, confidence = 0.95): OcrWord[] {
  const words: OcrWord[] = [];
  let at = x;
  for (const word of text.split(' ')) {
    const w = word.length * h * 0.55;
    words.push({ text: word, x0: at, x1: at + w, y0: y, y1: y + h, confidence });
    at += w + h / 2;
  }
  return words;
}

/** A body of ordinary text lines, 30 px tall, from `y` down. */
function body(y: number, lines = 12): OcrWord[] {
  return Array.from({ length: lines }, (_, i) =>
    line('Sehr geehrte Damen und Herren wir danken Ihnen', 200, y + i * 50, 30),
  ).flat();
}

const PAGE = 3500;

describe('title lines', () => {
  it('joins words into lines and keeps columns apart', () => {
    const words = [...line('Der Blaue', 100, 100, 40), ...line('Land Bus', 320, 102, 40)];
    // A second column far to the right, same height.
    words.push(...line('Fahrplan 2026', 1800, 101, 40));
    const lines = groupLines(words);
    expect(lines.map((l) => l.text).sort()).toEqual(['Der Blaue Land Bus', 'Fahrplan 2026']);
  });

  it('cleans junk and rejects what is not a title', () => {
    expect(cleanTitle('• Der Blaue Land Bus —')).toBe('Der Blaue Land Bus');
    expect(cleanTitle('RECHNUNG')).toBe('Rechnung');
    expect(cleanTitle('Invoice:')).toBe('Invoice');
    expect(cleanTitle('12.03.2026')).toBeNull();
    expect(cleanTitle('EUR 1.234,56')).toBeNull();
    expect(cleanTitle('DE89 3704 0044 0532 0130 00')).toBeNull();
    expect(cleanTitle('info@example.com')).toBeNull();
    expect(cleanTitle('www.blauer-landbus.de')).toBeNull();
    expect(cleanTitle('--------')).toBeNull();
    expect(cleanTitle('ab')).toBeNull();
    expect(cleanTitle('x'.repeat(3) + ' ' + 'word '.repeat(20))).toBeNull();
  });

  it('scores taller lines nearer the top higher', () => {
    const [big] = groupLines(line('Der Blaue Land Bus', 200, 200, 90));
    const [lower] = groupLines(line('Der Blaue Land Bus', 200, 1400, 90));
    const [small] = groupLines(line('Der Blaue Land Bus', 200, 200, 32));
    const typical = 30;
    expect(scoreLine(big, typical, PAGE)).toBeGreaterThan(scoreLine(lower, typical, PAGE));
    expect(scoreLine(lower, typical, PAGE)).toBeGreaterThan(0);
    // Not taller than the text around it: not a heading.
    expect(scoreLine(small, typical, PAGE)).toBe(0);
    // Far down the page: a footer or a signature, never a title.
    const [footer] = groupLines(line('Der Blaue Land Bus', 200, 3000, 90));
    expect(scoreLine(footer, typical, PAGE)).toBe(0);
    // Misread.
    const [unsure] = groupLines(line('Der Blaue Land Bus', 200, 200, 90, 0.4));
    expect(scoreLine(unsure, typical, PAGE)).toBe(0);
  });

  it('prefers a few words to a single short one or a sentence', () => {
    const typical = 30;
    const [few] = groupLines(line('Der Blaue Land Bus', 200, 300, 60));
    const [one] = groupLines(line('Bus', 200, 300, 60));
    const [sentence] = groupLines(
      line('Wir freuen uns Ihnen heute mitteilen zu dürfen dass', 200, 300, 60),
    );
    expect(scoreLine(few, typical, PAGE)).toBeGreaterThan(scoreLine(one, typical, PAGE));
    expect(scoreLine(few, typical, PAGE)).toBeGreaterThan(scoreLine(sentence, typical, PAGE));
  });
});

describe('suggested title', () => {
  it('picks the most prominent line near the top', () => {
    const words = [
      ...line('Verkehrsverbund Oberland GmbH', 200, 150, 36),
      ...line('DER BLAUE LAND BUS', 200, 420, 110),
      ...line('12.03.2026', 2400, 420, 120),
      ...body(800),
      ...line('Seite 1 von 2', 1500, 3300, 30),
    ];
    expect(suggestTitle(words, PAGE)).toBe('Der Blaue Land Bus');
  });

  it('suggests nothing when no line stands out', () => {
    expect(suggestTitle(body(200, 20), PAGE)).toBeNull();
    expect(suggestTitle([], PAGE)).toBeNull();
  });

  it('suggests nothing when only numbers stand out', () => {
    const words = [...line('4711 0815', 200, 300, 120), ...body(800)];
    expect(suggestTitle(words, PAGE)).toBeNull();
  });
});
