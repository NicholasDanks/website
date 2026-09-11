/**
 * The congruence test (Franke, Sarstedt & Danks, 2021) over an estimated PLS
 * model.
 *
 * The bootstrap re-estimates the whole model on every resample, exactly as
 * seminrExtras::congruence_test() does — rather than resampling construct-score
 * rows with the measurement weights frozen, which is only an approximation.
 * The per-resample statistic lives in `congruenceStatistic`, so the app can
 * compute it inside the same replication pass as the ordinary bootstrap
 * (see replicate.ts) instead of re-estimating the model a second time.
 *
 * The reliability placed on the matrix diagonal is a choice:
 *   - "rhoA" (the shipped default) is the reliability appropriate to composite
 *     scores (Dijkstra & Henseler, 2015).
 *   - "rhoC" reproduces the published congruence_test() exactly. Validated
 *     against R 4.6.0 in test/congruence-parity.mjs, which is what proves
 *     the machinery — rhoA is the same code path with a different diagonal.
 *
 * Bootstrap draws come from rrng.ts, which reproduces R's Mersenne-Twister and
 * post-3.6.0 "Rejection" sampler, so a given seed resamples the same rows R
 * would resample.
 */

import {
  rerun,
  rhoA as rhoAOf,
  reliabilityTable,
  htmt as htmtOf,
  type PlsModel,
  type Dataset,
} from "@seminr/core";
import { RRNG } from "./rrng";

export type Diagonal = "rhoA" | "rhoC";

export interface CongruenceRow {
  pair: string;
  estimate: number;
  diff: number;
  bootSD: number;
  tStat: number | null;
  ciLo: number;
  ciHi: number;
  significant: boolean;
}

export interface CongruenceResult {
  rows: CongruenceRow[];
  alpha: number;
  threshold: number;
  nboot: number;
  loLabel: string;
  hiLabel: string;
  inference: boolean;
}

export interface ModelCongruenceOptions {
  nboot?: number;
  seed?: number;
  alpha?: number;
  threshold?: number;
  diagonal?: Diagonal;
  onProgress?: (fraction: number) => void;
}

export interface ModelCongruenceResult extends CongruenceResult {
  diagonal: Diagonal;
  reliabilities: Record<string, number>;
  /** HTMT-based congruence point estimates, when computable. */
  htmtRows?: { pair: string; estimate: number }[];
}

/** Which constructs and pairs the statistic covers, and the diagonal in use. Plain data. */
export interface CongruenceSpec {
  names: string[];
  pairs: [number, number][];
  diagonal: Diagonal;
}

/** Pull a NamedMatrix row/col by name, tolerating the {rows, cols, values} shape. */
function cell(m: any, row: string, col: string): number {
  const i = m.rows.indexOf(row);
  const j = m.cols.indexOf(col);
  return m.values[i][j];
}

/** Construct scores as column-major Float64Arrays, in `names` order. */
function scoreColumns(model: PlsModel, names: string[]): Float64Array[] {
  const cs: any = (model as any).constructScores;
  const n = cs.values.length;
  return names.map((nm) => {
    const j = cs.cols.indexOf(nm);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = cs.values[i][j];
    return out;
  });
}

/** Reliability vector for the diagonal, in `names` order. */
function reliabilities(model: PlsModel, names: string[], diagonal: Diagonal): Float64Array {
  const out = new Float64Array(names.length);
  if (diagonal === "rhoA") {
    const m: any = rhoAOf(model, names);
    names.forEach((nm, i) => {
      // rhoA() returns a single-column matrix; mode B / single-item give 1.
      const j = m.rows.indexOf(nm);
      out[i] = j >= 0 ? m.values[j][0] : cell(m, nm, m.cols[0]);
    });
  } else {
    const rt: any = reliabilityTable(model);
    names.forEach((nm, i) => {
      out[i] = cell(rt, nm, "rhoC");
    });
  }
  // Guard: reliabilities must be usable on the diagonal.
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i]) || out[i] <= 0) out[i] = 1;
    if (out[i] > 1) out[i] = 1;
  }
  return out;
}

function corWithDiagonal(cols: Float64Array[], diag: Float64Array): Float64Array[] {
  const k = cols.length;
  const n = cols[0].length;
  const mu = new Float64Array(k);
  const sd = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += cols[j][i];
    mu[j] = s / n;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = cols[j][i] - mu[j];
      ss += d * d;
    }
    sd[j] = Math.sqrt(ss / (n - 1));
  }
  const m: Float64Array[] = [];
  for (let a = 0; a < k; a++) m.push(new Float64Array(k));
  for (let a = 0; a < k; a++) {
    m[a][a] = diag[a];
    for (let b = a + 1; b < k; b++) {
      let cov = 0;
      for (let i = 0; i < n; i++) cov += (cols[a][i] - mu[a]) * (cols[b][i] - mu[b]);
      const r = cov / (n - 1) / (sd[a] * sd[b]);
      m[a][b] = r;
      m[b][a] = r;
    }
  }
  return m;
}

function cosine(m: Float64Array[], x: number, y: number): number {
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < m.length; i++) {
    sxy += m[i][x] * m[i][y];
    sxx += m[i][x] * m[i][x];
    syy += m[i][y] * m[i][y];
  }
  return sxy / Math.sqrt(sxx * syy);
}

function rSd(v: Float64Array): number {
  const n = v.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i];
  const mu = s / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = v[i] - mu; ss += d * d; }
  return Math.sqrt(ss / (n - 1));
}

function quantile7(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** The constructs a congruence test covers: every score column except interaction terms. */
export function congruenceSpec(model: PlsModel, diagonal: Diagonal): CongruenceSpec {
  const cs: any = (model as any).constructScores;
  const names: string[] = cs.cols.filter((c: string) => !c.includes("*"));
  if (names.length < 2) throw new Error("Need at least two constructs to test congruence.");
  const pairs: [number, number][] = [];
  for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) pairs.push([a, b]);
  return { names, pairs, diagonal };
}

/** Congruence coefficient of every pair for one fitted model, in `spec.pairs` order. */
export function congruenceStatistic(model: PlsModel, spec: CongruenceSpec): Float64Array {
  const diag = reliabilities(model, spec.names, spec.diagonal);
  const mat = corWithDiagonal(scoreColumns(model, spec.names), diag);
  const out = new Float64Array(spec.pairs.length);
  spec.pairs.forEach(([a, b], r) => (out[r] = cosine(mat, a, b)));
  return out;
}

export interface CongruenceFromReplicationsOptions {
  alpha?: number;
  threshold?: number;
}

/**
 * The congruence test table from the model's own statistic and the
 * per-replication statistics of the bootstrap (null entries = failed resamples).
 */
export function congruenceFromReplications(
  model: PlsModel,
  spec: CongruenceSpec,
  replications: readonly (ArrayLike<number> | null)[],
  options: CongruenceFromReplicationsOptions = {},
): ModelCongruenceResult {
  const { alpha = 0.05, threshold = 1 } = options;
  const { names, pairs } = spec;
  const orig = congruenceStatistic(model, spec);
  const diag = reliabilities(model, names, spec.diagonal);
  const kept = replications.filter((r): r is ArrayLike<number> => r !== null);

  const EPS = 2.220446049250313e-16;
  const rows: CongruenceRow[] = pairs.map(([a, b], r) => {
    const clean = Float64Array.from(kept.map((rep) => rep[r]).filter((v) => Number.isFinite(v)));
    const sd = rSd(clean);
    const diff = threshold - Math.abs(orig[r]);
    const sorted = Float64Array.from(clean).sort();
    const ciHi = quantile7(sorted, 1 - alpha / 2);
    return {
      pair: `${names[a]} -> ${names[b]}`,
      estimate: orig[r],
      diff,
      bootSD: sd,
      tStat: sd < EPS ? null : diff / sd,
      ciLo: quantile7(sorted, alpha / 2),
      ciHi,
      significant: ciHi < threshold,
    };
  });

  // --- HTMT-based congruence point estimates --------------------------------
  let htmtRows: { pair: string; estimate: number }[] | undefined;
  try {
    const h: any = htmtOf(model);
    const k = names.length;
    const hm: Float64Array[] = [];
    for (let a = 0; a < k; a++) hm.push(new Float64Array(k));
    let usable = true;
    for (let a = 0; a < k && usable; a++) {
      hm[a][a] = diag[a];
      for (let b = a + 1; b < k; b++) {
        // htmt() fills the upper triangle only; the rest is NaN.
        const ia = h.rows.indexOf(names[a]);
        const jb = h.cols.indexOf(names[b]);
        let v = ia >= 0 && jb >= 0 ? h.values[ia][jb] : NaN;
        if (!Number.isFinite(v)) {
          const ib = h.rows.indexOf(names[b]);
          const ja = h.cols.indexOf(names[a]);
          v = ib >= 0 && ja >= 0 ? h.values[ib][ja] : NaN;
        }
        if (!Number.isFinite(v)) { usable = false; break; }
        hm[a][b] = v;
        hm[b][a] = v;
      }
    }
    if (usable) {
      htmtRows = pairs.map(([a, b]) => ({
        pair: `${names[a]} -> ${names[b]}`,
        estimate: cosine(hm, a, b),
      }));
    }
  } catch {
    htmtRows = undefined;
  }

  const rel: Record<string, number> = {};
  names.forEach((nm, i) => (rel[nm] = diag[i]));

  return {
    rows,
    alpha,
    threshold,
    nboot: kept.length,
    loLabel: `${(alpha / 2) * 100}% CI`,
    hiLabel: `${(1 - alpha / 2) * 100}% CI`,
    inference: true,
    diagonal: spec.diagonal,
    reliabilities: rel,
    htmtRows,
  };
}

/**
 * Standalone congruence test: bootstrap by re-estimating the model on each
 * resample of the raw indicator data, sequentially in this thread. The app
 * normally obtains the same numbers from the shared replication pass; this
 * entry point is what the R-parity test exercises.
 */
export function congruenceFromModel(
  model: PlsModel,
  data: Dataset,
  options: ModelCongruenceOptions = {},
): ModelCongruenceResult {
  const { nboot = 2000, seed = 123, alpha = 0.05, threshold = 1, diagonal = "rhoA", onProgress } = options;
  const spec = congruenceSpec(model, diagonal);
  const rows = data.values;
  const n = rows.length;
  const rng = new RRNG(seed);
  const replications: (Float64Array | null)[] = new Array(nboot);
  for (let b = 0; b < nboot; b++) {
    const idx = rng.sampleIntReplace(n, n);
    const resampled: number[][] = new Array(n);
    for (let i = 0; i < n; i++) resampled[i] = rows[idx[i]];
    try {
      const m2 = rerun(model, { data: { columns: data.columns, values: resampled } });
      replications[b] = congruenceStatistic(m2, spec);
    } catch {
      replications[b] = null;
    }
    if (onProgress && (b & 15) === 0) onProgress(b / nboot);
  }
  onProgress?.(1);
  return congruenceFromReplications(model, spec, replications, { alpha, threshold });
}
