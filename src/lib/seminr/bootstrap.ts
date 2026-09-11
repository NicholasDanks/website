/**
 * Bootstrap a fitted PLS model — and, in the same pass, the congruence
 * coefficients — with resample indices drawn from R's random number
 * generator, spread across a pool of Web Workers when the runtime allows.
 *
 * Reproducibility: the draws come from rrng.ts, so a seed gives the same
 * resamples every time, and the pool only slices a stream that is generated
 * up-front, so parallel and sequential runs are identical. They are NOT the
 * resamples R's `bootstrap_model()` would draw for the same seed — seminr
 * runs its bootstrap on a parallel cluster whose RNG streams (L'Ecuyer-CMRG)
 * differ from the sequential Mersenne-Twister stream. Point estimates are
 * identical to R's; bootstrap SDs and intervals agree to Monte Carlo error.
 */

import {
  htmt, totalEffects, namedMatrix,
  type BootModel, type PlsModel, type NamedMatrix, type BootReplication,
} from "@seminr/core";
import { RRNG } from "./rrng";
import { runReplications, type ModelSpecForWorker, type ReplicationBatch, type ReplicationRequest } from "./replicate";
import type { CongruenceSpec } from "./congruence";
import type { BootWorkerRequest, BootWorkerResponse } from "./bootWorker";

export interface SharedBootstrapOptions {
  /** Replications that keep bootstrap statistics (0 = congruence only). */
  nboot: number;
  seed: number;
  /** Congruence coefficients for the leading `count` replications of the same stream. */
  congruence?: { spec: CongruenceSpec; count: number };
  /** Worker pool size; 0 or 1 forces the in-thread path. Default: cores − 1, at most 8. */
  workers?: number;
  /** Replications per progress report / per in-thread chunk. */
  chunk?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface SharedBootstrapResult {
  /** Present when nboot > 0. */
  boot: BootModel | null;
  /** Per-replication congruence vectors (pairs in spec order); null entries failed. */
  congruence: (number[] | null)[];
  /** Total replications run. */
  total: number;
}

/** R's `sample.int(n, n, replace = TRUE)` for each replication, 0-based. */
export function rResampleIndices(n: number, nboot: number, seed: number): number[][] {
  const rng = new RRNG(seed);
  const out: number[][] = new Array(nboot);
  for (let b = 0; b < nboot; b++) out[b] = Array.from(rng.sampleIntReplace(n, n));
  return out;
}

/**
 * Per-source-row, per-outcome descriptives in seminr's layout: for each
 * outcome column X the triple "X PLS Est." / "X Boot Mean" / "X Boot SD".
 */
function describe(original: NamedMatrix, reps: readonly NamedMatrix[]): NamedMatrix {
  const rows = original.rows;
  const cols = original.cols;
  const outCols: string[] = [];
  for (const c of cols) outCols.push(`${c} PLS Est.`, `${c} Boot Mean`, `${c} Boot SD`);
  const values = rows.map((_, i) =>
    cols.flatMap((_, j) => {
      const estimate = original.values[i][j];
      const v = reps.map((r) => r.values[i][j]);
      const n = v.length;
      const mean = n ? v.reduce((a, b) => a + b, 0) / n : NaN;
      const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
      return [estimate, mean, sd];
    }),
  );
  return namedMatrix(rows, outCols, values);
}

/** Assemble a BootModel from replication statistics, as the package's summarizeBootstrap does. */
export function assembleBootModel(model: PlsModel, replications: readonly (BootReplication | null)[], seed: number): BootModel {
  const kept = replications.filter((r): r is BootReplication => r !== null);
  const bootPaths = kept.map((r) => r.paths);
  const bootLoadings = kept.map((r) => r.loadings);
  const bootWeights = kept.map((r) => r.weights);
  const bootHtmt = kept.map((r) => r.htmt);
  const bootTotalPaths = kept.map((r) => r.totalPaths);
  return {
    ...model,
    kind: "boot",
    bootPaths,
    bootLoadings,
    bootWeights,
    bootHtmt,
    bootTotalPaths,
    pathsDescriptives: describe(model.pathCoef, bootPaths),
    loadingsDescriptives: describe(model.outerLoadings, bootLoadings),
    weightsDescriptives: describe(model.outerWeights, bootWeights),
    htmtDescriptives: describe(htmt(model), bootHtmt),
    totalPathsDescriptives: describe(totalEffects(model.pathCoef), bootTotalPaths),
    boots: kept.length,
    fails: replications.length - kept.length,
    seed,
  };
}

/** Split [0, total) into `parts` contiguous ranges whose sizes differ by at most one. */
function ranges(total: number, parts: number): [number, number][] {
  const out: [number, number][] = [];
  const base = Math.floor(total / parts);
  let extra = total % parts;
  let start = 0;
  for (let p = 0; p < parts && start < total; p++) {
    const size = base + (extra-- > 0 ? 1 : 0);
    out.push([start, start + size]);
    start += size;
  }
  return out;
}

/** Can this thread spawn Web Workers? (True in browsers, including inside a worker; false in Node.) */
export function workersAvailable(): boolean {
  return typeof Worker !== "undefined" && typeof navigator !== "undefined";
}

function defaultWorkers(): number {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency ?? 2 : 1;
  return Math.max(1, Math.min(8, cores - 1));
}

function runInWorker(spec: ModelSpecForWorker, req: ReplicationRequest, onProgress: (done: number) => void): Promise<ReplicationBatch> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./bootWorker.ts", import.meta.url), { type: "module" });
    const message: BootWorkerRequest = { ...spec, ...req };
    w.onmessage = (e: MessageEvent<BootWorkerResponse>) => {
      const m = e.data;
      if (m.type === "progress") onProgress(m.done);
      else if (m.type === "done") { w.terminate(); resolve(m.batch); }
      else { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (err) => { w.terminate(); reject(new Error(err.message || "replication worker failed")); };
    w.postMessage(message);
  });
}

/**
 * Run `max(nboot, congruence.count)` replications of one R-RNG stream and
 * return the bootstrap model plus per-replication congruence statistics.
 */
export async function bootstrapShared(
  model: PlsModel,
  spec: ModelSpecForWorker,
  options: SharedBootstrapOptions,
): Promise<SharedBootstrapResult> {
  const { nboot, seed, congruence, onProgress } = options;
  const total = Math.max(nboot, congruence?.count ?? 0);
  if (total < 1) return { boot: null, congruence: [], total: 0 };
  const n = model.rawdata.values.length;
  const indices = rResampleIndices(n, total, seed);
  const request = (from: number, to: number): ReplicationRequest => ({
    indices: indices.slice(from, to),
    statsCount: Math.max(0, Math.min(nboot, to) - from),
    congruence: congruence ? { spec: congruence.spec, count: Math.max(0, Math.min(congruence.count, to) - from) } : null,
  });

  const wantedWorkers = options.workers ?? (workersAvailable() ? defaultWorkers() : 1);
  const parts = Math.max(1, Math.min(wantedWorkers, Math.ceil(total / 25)));
  let batches: ReplicationBatch[];

  if (parts > 1 && workersAvailable()) {
    const done = new Array<number>(parts).fill(0);
    const report = () => onProgress?.(done.reduce((a, b) => a + b, 0), total);
    try {
      batches = await Promise.all(
        ranges(total, parts).map(([from, to], k) =>
          runInWorker(spec, request(from, to), (d) => { done[k] = d; report(); }),
        ),
      );
    } catch {
      // A pool failure (e.g. nested workers unsupported) must not lose the run.
      batches = [runReplications(model, request(0, total), (d) => onProgress?.(d, total))];
    }
  } else {
    const chunk = options.chunk ?? 50;
    batches = [];
    for (let from = 0; from < total; from += chunk) {
      const to = Math.min(total, from + chunk);
      batches.push(runReplications(model, request(from, to)));
      onProgress?.(to, total);
    }
  }

  const stats = batches.flatMap((b) => b.stats);
  const cong = batches.flatMap((b) => b.congruence);
  return {
    boot: nboot > 0 ? assembleBootModel(model, stats, seed) : null,
    congruence: cong,
    total,
  };
}
