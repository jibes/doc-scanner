import type { RGBAImage } from '../imaging/image';

/**
 * Decode an image file into RGBA, honouring EXIF orientation. Works in a
 * Worker (OffscreenCanvas) and on the main thread.
 */
export async function decodeImage(blob: Blob, maxLongEdge = Infinity): Promise<RGBAImage> {
  const probe = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  let bitmap = probe;
  const long = Math.max(probe.width, probe.height);
  if (long > maxLongEdge) {
    const scale = maxLongEdge / long;
    bitmap = await createImageBitmap(blob, {
      imageOrientation: 'from-image',
      resizeWidth: Math.max(1, Math.round(probe.width * scale)),
      resizeHeight: Math.max(1, Math.round(probe.height * scale)),
      resizeQuality: 'high',
    });
    probe.close();
  }
  try {
    return bitmapToRGBA(bitmap);
  } finally {
    bitmap.close();
  }
}

export function bitmapToRGBA(bitmap: ImageBitmap): RGBAImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { data: data.data, width: bitmap.width, height: bitmap.height };
}

export function rgbaToImageData(image: RGBAImage): ImageData {
  return new ImageData(image.data, image.width, image.height);
}
