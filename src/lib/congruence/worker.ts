/**
 * Runs the congruence test off the main thread.
 *
 * The bootstrap re-estimates the whole PLS model on every resample — about 10 s
 * for 2000 resamples on an eight-construct model — which would otherwise freeze
 * the page. Everything here still runs on the user's own machine; a worker is a
 * second thread, not a server.
 */

import { runIndicatorRoute } from "./runIndicator";

export interface WorkerRequest {
  code: string;
  dataText: string;
  options: {
    nboot: number;
    seed: number;
    alpha: number;
    threshold: number;
    diagonal: "rhoA" | "rhoC";
  };
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    const result = runIndicatorRoute({
      code: req.code,
      dataText: req.dataText,
      options: {
        ...req.options,
        onProgress: (fraction) => (self as any).postMessage({ type: "progress", fraction }),
      },
    });
    (self as any).postMessage({ type: "done", result });
  } catch (err) {
    (self as any).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
