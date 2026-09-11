/**
 * Bootstrap a fitted PLS model in chunks, so the caller can report progress,
 * with resample indices drawn from R's random number generator.
 *
 * On reproducibility: the draws come from rrng.ts, so a seed gives the same
 * resamples every time, here and in any other implementation of R's
 * `sample.int(n, n, replace = TRUE)`. They are NOT the resamples R's
 * `bootstrap_model()` would draw for the same seed — seminr runs its bootstrap
 * on a parallel cluster whose RNG streams (L'Ecuyer-CMRG) differ from the
 * sequential Mersenne-Twister stream. Point estimates are identical to R's;
 * bootstrap SDs and intervals agree to Monte Carlo error, not bit-for-bit.
 */

import {
  bootstrapModel, htmt, totalEffects, namedMatrix,
  type BootModel, type PlsModel, type NamedMatrix,
} from "@seminr/core";
import { RRNG } from "./rrng";

export interface ChunkedBootstrapOptions {
  nboot: number;
  seed: number;
  /** Replications per call to the estimator; smaller = smoother progress. */
  chunk?: number;
  onProgress?: (done: number, total: number) => void;
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
function describe(original: NamedMatrix, reps: readonly NamedMatrix[], square: boolean): NamedMatrix {
  const rows = original.rows;
  const cols = original.cols;
  const outCols: string[] = [];
  for (const c of cols) outCols.push(`${c} PLS Est.`, `${c} Boot Mean`, `${c} Boot SD`);
  const values = rows.map((_, i) =>
    cols.flatMap((_, j) => {
      const est = original.values[i][j];
      const v = reps.map((r) => r.values[i][j]);
      const n = v.length;
      const mean = n ? v.reduce((a, b) => a + b, 0) / n : NaN;
      const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : NaN;
      return [est, mean, sd];
    }),
  );
  void square;
  return namedMatrix(rows, outCols, values);
}

export function bootstrapInChunks(model: PlsModel, options: ChunkedBootstrapOptions): BootModel {
  const { nboot, seed, chunk = 50, onProgress } = options;
  const n = model.rawdata.values.length;
  const indices = rResampleIndices(n, nboot, seed);

  const bootPaths: NamedMatrix[] = [];
  const bootLoadings: NamedMatrix[] = [];
  const bootWeights: NamedMatrix[] = [];
  const bootHtmt: NamedMatrix[] = [];
  const bootTotalPaths: NamedMatrix[] = [];
  let boots = 0, fails = 0;
  let last: BootModel | null = null;

  for (let start = 0; start < nboot; start += chunk) {
    const slice = indices.slice(start, Math.min(nboot, start + chunk));
    // nboot must match the slice: bootstrapModel defaults to 500 replications
    // and would read past the end of `indices` otherwise.
    const part = bootstrapModel({ model, nboot: slice.length, indices: slice });
    bootPaths.push(...part.bootPaths);
    bootLoadings.push(...part.bootLoadings);
    bootWeights.push(...part.bootWeights);
    bootHtmt.push(...part.bootHtmt);
    bootTotalPaths.push(...part.bootTotalPaths);
    boots += part.boots;
    fails += part.fails;
    last = part;
    onProgress?.(Math.min(nboot, start + chunk), nboot);
  }
  if (!last) throw new Error("nboot must be at least 1.");

  const modelAsPls = { ...last, kind: "pls" as const };
  return {
    ...last,
    bootPaths,
    bootLoadings,
    bootWeights,
    bootHtmt,
    bootTotalPaths,
    pathsDescriptives: describe(model.pathCoef, bootPaths, true),
    loadingsDescriptives: describe(model.outerLoadings, bootLoadings, false),
    weightsDescriptives: describe(model.outerWeights, bootWeights, false),
    htmtDescriptives: describe(htmt(modelAsPls), bootHtmt, false),
    totalPathsDescriptives: describe(totalEffects(model.pathCoef), bootTotalPaths, true),
    boots,
    fails,
    seed,
  };
}
