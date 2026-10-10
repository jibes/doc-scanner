/** Short x long edge in PDF points (1/72 in). */
const FORMATS = [
  { name: 'A4', short: 595.28, long: 841.89 },
  { name: 'Letter', short: 612, long: 792 },
  { name: 'Legal', short: 612, long: 1008 },
] as const;

/** Relative aspect-ratio difference still treated as a match. */
const TOLERANCE = 0.035;

/**
 * Physical page size for a rectified page, in points.
 *
 * Pixel dimensions come from the crop, not from a known DPI, so the physical
 * size has to be inferred. A page whose aspect ratio matches A4 (the whole A
 * series shares it), Letter or Legal gets that format's size; anything else,
 * such as a receipt, gets `fallbackDpi`.
 */
export function pageSizePoints(
  widthPx: number,
  heightPx: number,
  fallbackDpi = 300,
): { width: number; height: number; format: string | null } {
  const portrait = heightPx >= widthPx;
  const aspect = Math.max(widthPx, heightPx) / Math.max(1, Math.min(widthPx, heightPx));
  let best: (typeof FORMATS)[number] | null = null;
  let bestError = Infinity;
  for (const f of FORMATS) {
    const error = Math.abs(aspect - f.long / f.short) / (f.long / f.short);
    if (error < bestError) {
      bestError = error;
      best = f;
    }
  }
  if (best && bestError <= TOLERANCE) {
    return portrait
      ? { width: best.short, height: best.long, format: best.name }
      : { width: best.long, height: best.short, format: best.name };
  }
  return {
    width: (widthPx / fallbackDpi) * 72,
    height: (heightPx / fallbackDpi) * 72,
    format: null,
  };
}
