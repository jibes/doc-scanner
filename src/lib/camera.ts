import type { RGBAImage } from './imaging/types';

export type Facing = 'environment' | 'user';

/**
 * Image-capture extensions that `lib.dom` does not declare yet. `zoom` and
 * `focusMode` are part of the Media Capture Image Capture spec and are
 * implemented by Chrome/Android and, for zoom, by recent iOS Safari.
 */
export interface ZoomRange {
  min: number;
  max: number;
  step?: number;
}

export interface ImageCaptureCapabilities extends MediaTrackCapabilities {
  zoom?: ZoomRange;
  focusMode?: string[];
  focusDistance?: ZoomRange;
}

export interface ImageCaptureConstraintSet extends MediaTrackConstraintSet {
  zoom?: number;
  focusMode?: string;
  focusDistance?: number;
}

export interface CameraDeviceInfo {
  deviceId: string;
  label: string;
}

export interface CameraSelection {
  deviceId: string | null;
  label: string;
  /** The zoom the track was pinned to, or null when the platform has no zoom control. */
  zoom: number | null;
  focusMode: string | null;
}

/* ------------------------------------------------------------ selection ---- */

const FRONT = /front|user|face|selfie/i;
const BACK = /back|rear|environment|world/i;
const ULTRA_WIDE = /ultra[\s-]?wide|ultrawide|super[\s-]?wide|0[.,]5\s*x/i;
const TELEPHOTO = /tele(photo)?|periscope|\b[2-9](?:\.\d+)?\s*x\b/i;
const AUXILIARY =
  /macro|depth|infrared|\bir\b|truedepth|lidar|\btof\b|monochrome|fisheye|desk\s*view/i;
const VIRTUAL = /virtual|dual|triple|logical|aggregate|composite/i;
const PLAIN_BACK = /\b(?:back|rear)\s+camera\b/;
const MAIN = /\bmain\b/;
const ANDROID_INDEX = /camera2\s+(\d+)/;

/**
 * Rank a camera by how likely it is to be the standard 1x lens.
 *
 * Phone browsers expose every physical lens as its own device, and
 * `facingMode: 'environment'` is free to pick any of them — on most modern
 * phones that means the ultra-wide or a virtual multi-camera, which is exactly
 * what you do not want for a document. Labels are the only signal available
 * before a stream is opened, so score them.
 *
 * Returns a number where higher is better. Anything at or below zero is not a
 * usable match and the caller should fall back to `facingMode`.
 */
export function scoreCameraLabel(label: string, index: number, facing: Facing): number {
  const text = label.toLowerCase();
  let score = 0;

  const front = FRONT.test(text);
  const back = BACK.test(text);
  if (facing === 'environment') {
    if (front) score -= 100;
    if (back) score += 20;
  } else {
    if (back) score -= 100;
    if (front) score += 20;
  }

  // Lenses that are not the standard 1x view.
  if (ULTRA_WIDE.test(text)) score -= 80;
  if (TELEPHOTO.test(text)) score -= 80;
  if (AUXILIARY.test(text)) score -= 60;

  // A virtual multi-camera is usable — zoom gets pinned to 1x below — but a
  // plain single-lens entry is the safer bet.
  if (VIRTUAL.test(text)) score -= 10;

  // "Back Camera" / "Rear Camera" is the standard lens on iOS.
  if (PLAIN_BACK.test(text)) score += 40;
  if (MAIN.test(text)) score += 30;

  // Android exposes "camera2 N, facing back"; N=0 is normally the main sensor.
  const android = ANDROID_INDEX.exec(text);
  if (android) score += 15 - Number(android[1]);

  // Labels are hidden until permission is granted. With nothing to go on, fall
  // back to enumeration order.
  if (!text.trim()) score -= index;

  return score;
}

/** Best device for the requested facing, or null when nothing scores above zero. */
export function pickCamera(devices: CameraDeviceInfo[], facing: Facing): CameraDeviceInfo | null {
  const ranked = devices
    .map((device, index) => ({ device, score: scoreCameraLabel(device.label, index, facing) }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  return top && top.score > 0 ? top.device : null;
}

export async function listCameras(): Promise<CameraDeviceInfo[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device) => ({ deviceId: device.deviceId, label: device.label }));
}

/* --------------------------------------------------------------- capture ---- */

export function cameraSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

async function requestStream(facing: Facing, deviceId: string | null): Promise<MediaStream> {
  const video: MediaTrackConstraints = {
    width: { ideal: 2560 },
    height: { ideal: 1440 },
  };
  if (deviceId) {
    // An exact deviceId and a facingMode can conflict; the device wins.
    video.deviceId = { exact: deviceId };
  } else {
    video.facingMode = { ideal: facing };
  }
  return navigator.mediaDevices.getUserMedia({ audio: false, video });
}

/**
 * Pin the track to the standard 1x view and continuous autofocus.
 *
 * On a virtual multi-camera the zoom range starts below 1 (0.5x on an iPhone),
 * so without this the stream can sit on the ultra-wide end. Both constraints
 * are optional and best effort: platforms that do not implement them simply
 * ignore the request.
 */
async function applyStandardLens(
  track: MediaStreamTrack,
): Promise<{ zoom: number | null; focusMode: string | null }> {
  const capabilities = track.getCapabilities?.() as ImageCaptureCapabilities | undefined;
  const advanced: ImageCaptureConstraintSet[] = [];

  let zoom: number | null = null;
  const range = capabilities?.zoom;
  if (range && range.min <= 1 && range.max >= 1) {
    zoom = 1;
    advanced.push({ zoom: 1 });
  }

  let focusMode: string | null = null;
  if (capabilities?.focusMode?.includes('continuous')) {
    focusMode = 'continuous';
    advanced.push({ focusMode: 'continuous' });
  }

  if (advanced.length > 0) {
    try {
      await track.applyConstraints({ advanced });
    } catch {
      // Optional constraints are best effort; the stream is still usable.
    }
  }

  return { zoom, focusMode };
}

export interface OpenCameraOptions {
  facing: Facing;
  /** A deviceId the user picked explicitly. Skips automatic selection. */
  preferredDeviceId?: string | null;
}

export interface OpenCameraResult {
  stream: MediaStream;
  selection: CameraSelection;
}

/**
 * Open the standard rear camera.
 *
 * Two phases, because device labels are only populated once permission has been
 * granted: open something, then use the now-visible labels to pick the standard
 * lens and reopen if it differs.
 */
export async function openCamera(options: OpenCameraOptions): Promise<OpenCameraResult> {
  if (!cameraSupported()) {
    throw new Error(
      'No camera API available. Camera access requires HTTPS (or localhost) and a browser that supports getUserMedia.',
    );
  }

  let preferred = options.preferredDeviceId ?? null;
  let stream: MediaStream;
  try {
    stream = await requestStream(options.facing, preferred);
  } catch (error) {
    if (!preferred) throw error;
    // Saved deviceIds rotate between sessions; fall back to automatic, which
    // includes picking the standard lens below.
    preferred = null;
    stream = await requestStream(options.facing, null);
  }

  let track = firstTrack(stream);

  if (!preferred) {
    const devices = await listCameras();
    const best = pickCamera(devices, options.facing);
    const currentId = track.getSettings().deviceId;
    if (best && best.deviceId && best.deviceId !== currentId) {
      // Many phones cannot open two cameras at once, so release the first
      // stream before asking for the better lens.
      stopStream(stream);
      try {
        stream = await requestStream(options.facing, best.deviceId);
      } catch {
        // Reopen what we had.
        stream = await requestStream(options.facing, currentId ?? null);
      }
      track = firstTrack(stream);
    }
  }

  const lens = await applyStandardLens(track);
  return {
    stream,
    selection: {
      deviceId: track.getSettings().deviceId ?? null,
      label: track.label || 'Camera',
      zoom: lens.zoom,
      focusMode: lens.focusMode,
    },
  };
}

function firstTrack(stream: MediaStream): MediaStreamTrack {
  const track = stream.getVideoTracks()[0];
  if (!track) {
    stopStream(stream);
    throw new Error('The camera produced no video track.');
  }
  return track;
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
