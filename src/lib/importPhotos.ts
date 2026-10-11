import type { FilterId } from './imaging/filters';
import type { Quad } from './imaging/image';
import { fallbackQuad } from './imaging/quad';
import { isBlurred } from './imaging/sharpness';
import { defaultSpec } from './pipeline';
import { session } from './store/session.svelte';
import type { DetectorClient } from './worker/clients';

export interface AddedPhoto {
  id: string;
  /** Page edges were found. */
  found: boolean;
  blurred: boolean;
  /** The page runs off the photo. */
  offFrame: boolean;
}

/**
 * Find the page in a photo and add it to the document, or, with `retakeId`,
 * put it in place of that page's photo. Without a working detector the page
 * keeps the whole photo (imported) or a slight inset (camera) for hand-cropping.
 */
export async function addPhoto(
  detector: DetectorClient,
  source: Blob,
  options: { filter: FilterId; imported?: boolean; retakeId?: string | null },
): Promise<AddedPhoto> {
  const { filter, imported = false, retakeId = null } = options;
  let result: {
    quad: Quad | null;
    width: number;
    height: number;
    sharpness: number | null;
    offFrame: boolean;
  };
  try {
    result = await detector.still(source);
  } catch {
    const bitmap = await createImageBitmap(source);
    result = {
      quad: null,
      width: bitmap.width,
      height: bitmap.height,
      sharpness: null,
      offFrame: false,
    };
    bitmap.close();
  }
  const pageQuad = result.quad ?? fallbackQuad(result.width, result.height, imported);
  const photo = {
    source,
    width: result.width,
    height: result.height,
    detected: result.quad,
    sharpness: result.sharpness,
  };
  const found = result.quad !== null;
  const blurred = isBlurred(result);
  const offFrame = result.offFrame;
  if (retakeId && session.get(retakeId)) {
    session.replaceSource(retakeId, { ...photo, quad: pageQuad });
    return { id: retakeId, found, blurred, offFrame };
  }
  const page = session.add({ ...photo, spec: defaultSpec(pageQuad, filter) });
  return { id: page.id, found, blurred, offFrame };
}

export interface ImportSummary {
  added: number;
  /** Pages without detectable edges. */
  missing: number;
  /** Pages running off the photo. */
  cut: number;
  /** Why the first photo that could not be read failed, if any did. */
  error: unknown;
  failed: number;
}

/**
 * Add photos chosen in the file picker or shared from another app, in order.
 * With `retakeId` only the first replaces that page.
 */
export async function importPhotos(
  detector: DetectorClient,
  files: Blob[],
  options: {
    filter: FilterId;
    retakeId?: string | null;
    /** Called before each photo with how many are done. */
    onProgress?: (done: number, total: number) => void;
  },
): Promise<ImportSummary> {
  const summary: ImportSummary = { added: 0, missing: 0, cut: 0, error: null, failed: 0 };
  for (const [index, file] of files.entries()) {
    options.onProgress?.(index, files.length);
    try {
      const { found, offFrame } = await addPhoto(detector, file, {
        filter: options.filter,
        retakeId: options.retakeId,
        imported: true,
      });
      summary.added++;
      if (!found) summary.missing++;
      if (offFrame) summary.cut++;
    } catch (error) {
      // Not an image the browser can decode: skip it, keep the others.
      summary.failed++;
      summary.error ??= error;
    }
    if (options.retakeId) break;
  }
  return summary;
}

/** The note to show after an import, if any page needs a look. */
export function importNote({
  missing,
  cut,
  failed,
  error,
}: ImportSummary): { message: string; kind: 'info' | 'err' } | null {
  if (failed) {
    const reason = error instanceof Error ? error.message : String(error);
    return { message: `Could not import ${failed} photo(s): ${reason}`, kind: 'err' };
  }
  if (missing) {
    return {
      message: `${missing} page(s) had no detectable edges; check their crop.`,
      kind: 'info',
    };
  }
  if (cut) return { message: `${cut} page(s) run off the photo; check their crop.`, kind: 'info' };
  return null;
}
