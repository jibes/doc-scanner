import type { ScanSettings } from '../imaging/pipeline';
import type { Quad } from '../imaging/types';

export interface SerializedImage {
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

export interface WarpRequest {
  id: number;
  type: 'warp';
  image: SerializedImage;
  quad: Quad;
  maxLongEdge: number;
}

export interface ProcessRequest {
  id: number;
  type: 'process';
  image: SerializedImage;
  settings: ScanSettings;
}

export type WorkerRequest = WarpRequest | ProcessRequest;

export type WorkerResponse =
  | { id: number; type: 'stage'; stage: string }
  | { id: number; type: 'result'; image: SerializedImage }
  | { id: number; type: 'error'; message: string };
