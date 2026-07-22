/**
 * Congruence-coefficient test — a direct TypeScript port of congruence_core.R
 * from the Shiny version of this app.
 *
 * The congruence coefficient rc (Franke, Sarstedt & Danks, 2021, JBR) is the
 * cosine similarity between two constructs' correlation-pattern vectors: it
 * asks whether two constructs relate to the rest of the nomological network in
 * the same way. rc near 1 means they are empirically hard to tell apart.
 *
 * Two deliberate properties carried over from the R original:
 *
 *  1. The bootstrap resamples rows of the *construct-score* matrix with the
 *     measurement weights held fixed, rather than resampling raw indicators and
 *     re-estimating the PLS model each iteration (which is what
 *     seminrExtras::congruence_test() does). Point estimates are identical;
 *     bootstrap SEs run about 10% wider, i.e. mildly conservative.
 *  2. The reliability placed on the matrix diagonal is rho_A, the user's own
 *     input. The published function uses rho_C. These results are therefore a
 *     rho_A variant.
 *
 * Combined with rrng.ts, this reproduces the R implementation's output exactly
 * for a given seed — see test/parity.mjs.
 */

import { RRNG } from "./rrng";

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

export interface CongruenceOptions {
  nboot?: number;
  seed?: number;
  alpha?: number;
  threshold?: number;
  /** Called with progress in [0,1] so long bootstraps can yield to the UI. */
  onProgress?: (fraction: number) => void;
}

/** Pearson correlation matrix of the columns of `scores` (n x k, column-major). */
function corMatrix(scores: Float64Array[], n: number): Float64Array[] {
  const k = scores.length;
  const means = new Float64Array(k);
  const sds = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += scores[j][i];
    const mu = s / n;
    means[j] = mu;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = scores[j][i] - mu;
      ss += d * d;
    }
    sds[j] = Math.sqrt(ss / (n - 1));
  }
  const out: Float64Array[] = [];
  for (let a = 0; a < k; a++) out.push(new Float64Array(k));
  for (let a = 0; a < k; a++) {
    out[a][a] = 1;
    for (let b = a + 1; b < k; b++) {
      let cov = 0;
      for (let i = 0; i < n; i++) {
        cov += (scores[a][i] - means[a]) * (scores[b][i] - means[b]);
      }
      const r = cov / (n - 1) / (sds[a] * sds[b]);
      out[a][b] = r;
      out[b][a] = r;
    }
  }
  return out;
}

/**
 * rc between columns x and y of `mat`: cosine similarity over the full columns,
 * diagonal (reliability) included. Matches calc_congruence() in the R source.
 */
function calcCongruence(mat: Float64Array[], x: number, y: number): number {
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  const k = mat.length;
  for (let i = 0; i < k; i++) {
    const a = mat[i][x];
    const b = mat[i][y];
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** R's stats::sd — denominator n-1. */
function rSd(v: Float64Array): number {
  const n = v.length;
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i];
  const mu = s / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = v[i] - mu;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - 1));
}

/** R's stats::quantile default (type 7) on an already-sorted vector. */
function quantile7(sorted: Float64Array, p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Bootstrap congruence test from construct scores.
 *
 * @param names  construct names, length k
 * @param scores column-major score vectors, each length n
 * @param rhoA   reliability per construct, aligned to `names`
 */
export function congruenceFromScores(
  names: string[],
  scores: Float64Array[],
  rhoA: Float64Array,
  options: CongruenceOptions = {},
): CongruenceResult {
  const {
    nboot = 2000,
    seed = 123,
    alpha = 0.05,
    threshold = 1,
    onProgress,
  } = options;

  const k = names.length;
  const n = scores[0].length;

  if (k < 2) throw new Error("Need at least two constructs (columns) to test congruence.");
  if (n < 3) throw new Error("Need at least three observations (rows) to bootstrap.");
  for (let j = 0; j < k; j++) {
    if (!Number.isFinite(rhoA[j]) || rhoA[j] <= 0 || rhoA[j] > 1) {
      throw new Error("Reliabilities must be finite and in (0, 1].");
    }
  }

  // Pairs in R's combn() order: (1,2), (1,3) ... (2,3) ...
  const pairs: [number, number][] = [];
  for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) pairs.push([a, b]);
  const np = pairs.length;

  // --- point estimates ------------------------------------------------------
  const base = corMatrix(scores, n);
  for (let j = 0; j < k; j++) base[j][j] = rhoA[j];
  const orig = pairs.map(([a, b]) => calcCongruence(base, a, b));

  // --- bootstrap on construct-score rows ------------------------------------
  const rng = new RRNG(seed);
  const boot: Float64Array[] = [];
  for (let r = 0; r < np; r++) boot.push(new Float64Array(nboot));

  const resampled: Float64Array[] = [];
  for (let j = 0; j < k; j++) resampled.push(new Float64Array(n));

  for (let b = 0; b < nboot; b++) {
    const idx = rng.sampleIntReplace(n, n);
    for (let j = 0; j < k; j++) {
      const src = scores[j];
      const dst = resampled[j];
      for (let i = 0; i < n; i++) dst[i] = src[idx[i]];
    }
    const m = corMatrix(resampled, n);
    for (let j = 0; j < k; j++) m[j][j] = rhoA[j];
    for (let r = 0; r < np; r++) {
      boot[r][b] = calcCongruence(m, pairs[r][0], pairs[r][1]);
    }
    if (onProgress && (b & 63) === 0) onProgress(b / nboot);
  }

  // --- assemble -------------------------------------------------------------
  const EPS = 2.220446049250313e-16; // .Machine$double.eps
  const rows: CongruenceRow[] = pairs.map(([a, b], r) => {
    const bootSD = rSd(boot[r]);
    const diff = threshold - Math.abs(orig[r]);
    const sorted = Float64Array.from(boot[r]).sort();
    const ciLo = quantile7(sorted, alpha / 2);
    const ciHi = quantile7(sorted, 1 - alpha / 2);
    return {
      pair: `${names[a]} -> ${names[b]}`,
      estimate: orig[r],
      diff,
      bootSD,
      tStat: bootSD < EPS ? null : diff / bootSD,
      ciLo,
      ciHi,
      // Significant = the whole CI sits below the threshold, i.e. the two
      // constructs ARE empirically distinguishable. Non-significant pairs are
      // the worrying ones: redundancy cannot be ruled out.
      significant: ciHi < threshold,
    };
  });

  onProgress?.(1);

  return {
    rows,
    alpha,
    threshold,
    nboot,
    loLabel: `${(alpha / 2) * 100}% CI`,
    hiLabel: `${(1 - alpha / 2) * 100}% CI`,
    inference: true,
  };
}

/**
 * Point-estimate congruence from a supplied construct matrix (a correlation or
 * disattenuated HTMT matrix). There is no raw data behind the matrix, so there
 * is no bootstrap and no significance test — coefficients only.
 */
export function congruenceFromMatrix(
  names: string[],
  matrix: Float64Array[],
  rhoA: Float64Array,
  threshold = 1,
): CongruenceResult {
  const k = names.length;
  if (k < 2) throw new Error("Need at least two constructs.");
  for (let j = 0; j < k; j++) {
    if (!Number.isFinite(rhoA[j]) || rhoA[j] <= 0 || rhoA[j] > 1) {
      throw new Error("Reliabilities must be finite and in (0, 1].");
    }
  }
  const m = matrix.map((col) => Float64Array.from(col));
  for (let j = 0; j < k; j++) m[j][j] = rhoA[j];
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      if (!Number.isFinite(m[a][b])) {
        throw new Error(
          "The matrix has empty off-diagonal cells — paste a complete matrix (or a full triangle).",
        );
      }
    }
  }
  const rows: CongruenceRow[] = [];
  for (let a = 0; a < k; a++) {
    for (let b = a + 1; b < k; b++) {
      const est = calcCongruence(m, a, b);
      rows.push({
        pair: `${names[a]} -> ${names[b]}`,
        estimate: est,
        diff: threshold - Math.abs(est),
        bootSD: NaN,
        tStat: null,
        ciLo: NaN,
        ciHi: NaN,
        significant: false,
      });
    }
  }
  return {
    rows,
    alpha: NaN,
    threshold,
    nboot: 0,
    loLabel: "",
    hiLabel: "",
    inference: false,
  };
}
