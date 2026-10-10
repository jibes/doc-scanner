import type { RGBAImage } from './imaging/types';

export type Facing = 'environment' | 'user';

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export async function startCamera(facing: Facing): Promise<MediaStream> {
  if (!cameraSupported()) {
    throw new Error(
      'No camera API available. Camera access requires HTTPS (or localhost) and a browser that supports getUserMedia.',
    );
  }
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 2560 },
      height: { ideal: 1440 },
    },
  });
}

export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/** Grab the current video frame at full sensor resolution. */
export function captureFrame(video: HTMLVideoElement): RGBAImage | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height };
}

export async function imageFromBlob(blob: Blob): Promise<RGBAImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create a 2D canvas context');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data: imageData.data, width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}
