/**
 * Long edge in inches of the paper formats a page is matched against, keyed by
 * aspect ratio (long / short). The A series all share 1:√2, so an A-ratio page
 * is assumed to be A4 — an A5 sheet will be tagged as A4-sized.
 */
const FORMATS: { name: string; aspect: number; longEdgeInches: number }[] = [
  { name: 'A4', aspect: Math.SQRT2, longEdgeInches: 297 / 25.4 },
  { name: 'Letter', aspect: 11 / 8.5, longEdgeInches: 11 },
  { name: 'Legal', aspect: 14 / 8.5, longEdgeInches: 14 },
];

/** Relative aspect-ratio difference still treated as a match. */
const ASPECT_TOLERANCE = 0.03;

/**
 * Resolution to tag a rectified page with, so the PDF Paperless builds from it
 * comes out at the paper's real size.
 *
 * The pixel size of the page is set by the crop and the long-edge cap, not by
 * a DPI, so a fixed tag would misstate the physical size (a 2400 px A4 page
 * tagged 300 dpi becomes an 8 inch PDF). When the aspect ratio matches a
 * standard format the DPI is derived from that format's size; otherwise there
 * is nothing to measure against and `fallbackDpi` is used.
 */
export function estimateDpi(width: number, height: number, fallbackDpi: number): number {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (short <= 0) return fallbackDpi;

  const aspect = long / short;
  let best: (typeof FORMATS)[number] | null = null;
  let bestError = Infinity;
  for (const format of FORMATS) {
    const error = Math.abs(aspect - format.aspect) / format.aspect;
    if (error < bestError) {
      best = format;
      bestError = error;
    }
  }

  if (!best || bestError > ASPECT_TOLERANCE) return fallbackDpi;
  return Math.round(long / best.longEdgeInches);
}
