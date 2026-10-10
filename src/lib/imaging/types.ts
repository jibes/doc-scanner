/**
 * A raster image in RGBA order, 8 bits per channel.
 *
 * The buffer is pinned to `ArrayBuffer` (rather than `ArrayBufferLike`) so the
 * data can be handed straight to `ImageData` and to `postMessage` transfer
 * lists without a cast.
 */
export interface RGBAImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/** A single-channel mask. Values are 0 (off) or 255 (on). */
export type Mask = Uint8Array;

export type Point = readonly [number, number];

/** Corners in source-image pixels, ordered top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Point, Point, Point, Point];

export function createImage(width: number, height: number): RGBAImage {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

/** Rec. 601 luma, matching the weights used throughout the pipeline. */
export function luma(r: number, g: number, b: number): number {
  return (r * 77 + g * 150 + b * 29) >> 8;
}

/** Extract a single-channel grayscale copy of an RGBA image. */
export function toGray(img: RGBAImage): Uint8Array {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = luma(data[p], data[p + 1], data[p + 2]);
  }
  return out;
}
