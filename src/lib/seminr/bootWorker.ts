/**
 * One member of the replication pool. Rebuilds the fitted model from the
 * parsed specification and data it is sent (estimation is a few tens of
 * milliseconds; shipping the model object itself is impossible, it holds
 * functions), runs its slice of the resample indices, and posts the plain
 * statistics back. Spawned by bootstrap.ts from inside the analysis worker,
 * so the page's main thread never does any numerics.
 */

import { estimateParsedModel } from "./specify";
import { runReplications, type ModelSpecForWorker, type ReplicationRequest, type ReplicationBatch } from "./replicate";

export interface BootWorkerRequest extends ModelSpecForWorker, ReplicationRequest {}

export type BootWorkerResponse =
  | { type: "progress"; done: number }
  | { type: "done"; batch: ReplicationBatch }
  | { type: "error"; message: string };

const post = (m: BootWorkerResponse) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<BootWorkerRequest>) => {
  const req = e.data;
  try {
    const model = estimateParsedModel(req.parsed, req.data, req.estimation);
    const batch = runReplications(model, req, (done) => post({ type: "progress", done }));
    post({ type: "done", batch });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
