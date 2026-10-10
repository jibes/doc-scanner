import { DetectorClient, ProcessorClient } from './worker/clients';

let processorInstance: ProcessorClient | null = null;
let detectorInstance: DetectorClient | null = null;

/** The image-processing worker, created on first use. */
export function processor(): ProcessorClient {
  processorInstance ??= new ProcessorClient();
  return processorInstance;
}

/** The page detector (ONNX model) worker, created on first use. */
export function detector(): DetectorClient {
  detectorInstance ??= new DetectorClient();
  return detectorInstance;
}
