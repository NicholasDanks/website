/**
 * The replication kernel: re-estimate the model on resampled rows and keep
 * the statistics every consumer needs. One pass serves both the bootstrap
 * (paths, loadings, weights, HTMT, total effects per resample — exactly what
 * @seminr/core's bootReplication keeps) and the congruence test (the
 * congruence coefficient of every construct pair per resample), so the
 * congruence test no longer re-estimates the model a second time.
 *
 * A batch is plain data in and plain data out, so the same function runs
 * in-thread or inside a pool of Web Workers (see bootWorker.ts) with
 * identical results: the resample indices are generated up-front from R's
 * RNG and only sliced across workers.
 */

import {
  rerun, htmt, totalEffects,
  type PlsModel, type Dataset, type BootReplication,
} from "@seminr/core";
import type { ParsedModel } from "./parseSeminr";
import type { EstimationOptions } from "./specify";
import { congruenceStatistic, type CongruenceSpec } from "./congruence";

export interface ReplicationRequest {
  /** 0-based resample row indices, one array per replication. */
  indices: number[][];
  /** How many of the leading replications keep bootstrap statistics. */
  statsCount: number;
  /** Congruence spec and how many leading replications to compute it for. */
  congruence: { spec: CongruenceSpec; count: number } | null;
}

export interface ReplicationBatch {
  /** One entry per replication with index < statsCount; null = failed. */
  stats: (BootReplication | null)[];
  /** One entry per replication with index < congruence.count; null = failed. */
  congruence: (number[] | null)[];
}

/** What a worker needs to rebuild the fitted model before replicating. */
export interface ModelSpecForWorker {
  parsed: ParsedModel;
  data: Dataset;
  estimation: EstimationOptions;
}

export function runReplications(
  model: PlsModel,
  req: ReplicationRequest,
  onProgress?: (done: number) => void,
): ReplicationBatch {
  const source = model.rawdata;
  const stats: (BootReplication | null)[] = [];
  const congruence: (number[] | null)[] = [];
  const n = req.indices.length;
  for (let b = 0; b < n; b++) {
    const idx = req.indices[b];
    const wantStats = b < req.statsCount;
    const wantCongruence = req.congruence !== null && b < req.congruence.count;
    let fit: PlsModel | null = null;
    try {
      const rows = new Array<number[]>(idx.length);
      for (let i = 0; i < idx.length; i++) rows[i] = source.values[idx[i]];
      fit = rerun(model, { data: { columns: source.columns, values: rows } });
    } catch {
      fit = null;
    }
    if (wantStats) {
      stats.push(fit ? {
        paths: fit.pathCoef,
        loadings: fit.outerLoadings,
        weights: fit.outerWeights,
        htmt: htmt(fit),
        totalPaths: totalEffects(fit.pathCoef),
      } : null);
    }
    if (wantCongruence) {
      let c: number[] | null = null;
      if (fit) {
        try { c = Array.from(congruenceStatistic(fit, req.congruence!.spec)); } catch { c = null; }
      }
      congruence.push(c);
    }
    if (onProgress && ((b & 15) === 15 || b === n - 1)) onProgress(b + 1);
  }
  return { stats, congruence };
}
