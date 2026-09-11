/**
 * Runs the whole analysis off the main thread.
 *
 * Estimation is fast, but the bootstrap re-estimates the model on every
 * resample, and the congruence test does it again — tens of seconds on a
 * large model — which would otherwise freeze the page. Everything here still
 * runs on the user's own machine; a worker is a second thread, not a server.
 */

import { runAnalysis, type AnalysisInput, type AnalysisResult, type StageId, type StageStatus } from "./analyze";

export type WorkerRequest = AnalysisInput;

export type WorkerMessage =
  | { type: "stage"; stage: StageId; status: StageStatus; detail?: string }
  | { type: "progress"; stage: StageId; fraction: number }
  | { type: "done"; result: AnalysisResult }
  | { type: "error"; message: string };

const post = (m: WorkerMessage) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    const result = await runAnalysis(e.data, {
      onStage: (stage, status, detail) => post({ type: "stage", stage, status, detail }),
      onProgress: (stage, fraction) => post({ type: "progress", stage, fraction }),
    });
    post({ type: "done", result });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
