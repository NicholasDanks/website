/**
 * Runs the congruence test off the main thread.
 *
 * The indicator route re-estimates the whole PLS model on every bootstrap
 * resample — about 10 s for 2000 resamples on an eight-construct model — which
 * would otherwise freeze the page. Everything here still runs on the user's own
 * machine; a worker is a second thread, not a server.
 */

import { congruenceFromScores } from "./congruence";
import { parseScores, parseRhoA, alignRhoA } from "./parse";
import { runIndicatorRoute } from "./runIndicator";

export type WorkerRequest =
  | {
      mode: "scores";
      scoresText: string;
      rhoaText: string;
      options: { nboot: number; seed: number; alpha: number; threshold: number };
    }
  | {
      mode: "indicator";
      code: string;
      dataText: string;
      options: {
        nboot: number;
        seed: number;
        alpha: number;
        threshold: number;
        diagonal: "rhoA" | "rhoC";
      };
    };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const onProgress = (fraction: number) =>
    (self as any).postMessage({ type: "progress", fraction });

  try {
    if (req.mode === "scores") {
      const parsed = parseScores(req.scoresText);
      const rhoA = alignRhoA(parsed.names, parseRhoA(req.rhoaText));
      const result = congruenceFromScores(parsed.names, parsed.columns, rhoA, {
        ...req.options,
        onProgress,
      });
      (self as any).postMessage({ type: "done", result });
    } else {
      const result = runIndicatorRoute({
        code: req.code,
        dataText: req.dataText,
        options: { ...req.options, onProgress },
      });
      (self as any).postMessage({ type: "done", result });
    }
  } catch (err) {
    (self as any).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
