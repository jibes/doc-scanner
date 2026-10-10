import type { Page } from './store/session.svelte';
import { DetectorClient, ProcessorClient } from './worker/clients';
import type { RenderJob } from './worker/protocol';

let processorInstance: ProcessorClient | null = null;
let detectorInstance: DetectorClient | null = null;

/** The image-processing worker, created on first use and again after a failure. */
export function processor(): ProcessorClient {
  if (!processorInstance || processorInstance.dead) processorInstance = new ProcessorClient();
  return processorInstance;
}

/**
 * The page detector (ONNX model) worker, created on first use and again after
 * a failure. Hold on to the returned client rather than calling this per
 * frame, so a detector that keeps failing is not restarted in a loop.
 */
export function detector(): DetectorClient {
  if (!detectorInstance || detectorInstance.dead) detectorInstance = new DetectorClient();
  return detectorInstance;
}

/** The worker job for rendering `page` at `longEdge`. */
export function renderJob(page: Page, longEdge: number): RenderJob {
  return {
    pageId: page.id,
    source: page.source,
    sourceWidth: page.width,
    sourceHeight: page.height,
    spec: page.spec,
    longEdge,
  };
}
