import type { RGBAImage } from './imaging/types';

export function imageToCanvas(image: RGBAImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  drawImageToCanvas(canvas, image);
  return canvas;
}

export function drawImageToCanvas(canvas: HTMLCanvasElement, image: RGBAImage): void {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
}

export function canvasToImage(canvas: HTMLCanvasElement): RGBAImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: imageData.data, width: canvas.width, height: canvas.height };
}

/** High-quality downscale, used to build the interactive preview. */
export function downscaleImage(image: RGBAImage, maxEdge: number): RGBAImage {
  const longEdge = Math.max(image.width, image.height);
  if (longEdge <= maxEdge) return image;

  const scale = maxEdge / longEdge;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const source = imageToCanvas(image);
  const target = document.createElement('canvas');
  target.width = width;
  target.height = height;
  const ctx = target.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not create a 2D canvas context');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);

  return canvasToImage(target);
}

export function imageToPngBlob(image: RGBAImage): Promise<Blob> {
  const canvas = imageToCanvas(image);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode the page as PNG'));
    }, 'image/png');
  });
}
