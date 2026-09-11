/**
 * The complete analysis pipeline: pasted SEMinR code + pasted data ->
 * estimated PLS model -> summary -> bootstrap -> mediation -> PLSpredict ->
 * CVPAT -> congruence test -> threshold assessment -> reproducible R script.
 *
 * The result is plain data (no functions, no class instances) so it can cross
 * the worker boundary, be downloaded as JSON, and — in the next version of
 * the app — be handed to a model-evaluation assistant as one self-describing
 * bundle. Every optional stage records its own error instead of failing the
 * whole run.
 */

import {
  summarizePls, summarizePlsBoot, predictPls, summarizePlsPredict, predictDA, predictEA,
  specificEffectSignificance, totalIndirectCi, dotGraph, constructType, constructItems,
  constructs as mkConstructs, composite as mkComposite, relationships as mkRelationships, paths as mkPaths,
  estimatePls, meanReplacement, naOmit, pathWeighting, pathFactorial, modeB as MODE_B, slopeAnalysis,
  parseBootArrayHtmt, htmt as htmtOf,
  version as coreVersion,
  type PlsModel, type BootModel, type PlsSummary, type PlsBootSummary, type PlsPredictSummary,
  type NamedMatrix, type SpecificEffectSignificance,
} from "@seminr/core";
import { assessCvpat, version as extrasVersion } from "@seminr/extras";
import { parseSeminrModel, requiredItems, type ParsedModel } from "./parseSeminr";
import { parseDataText, selectColumns, missingCounts } from "./data";
import { RRNG as _RRNG } from "./rrng";
import { estimateParsedModel, type EstimationOptions } from "./specify";
import type { Dataset } from "@seminr/core";
import { bootstrapShared } from "./bootstrap";
import { congruenceSpec, congruenceFromReplications, type Diagonal, type ModelCongruenceResult } from "./congruence";
import { RRNG } from "./rrng";
import { assessAnalysis, type AssessmentItem } from "./assess";
import { generateRScript } from "./rcode";
import { sanitizeSvg } from "./sanitize";

export const APP_VERSION = "1.0.0";
export const SCHEMA_VERSION = 1;

export interface AnalysisOptions {
  estimation: EstimationOptions;
  bootstrap: { enabled: boolean; nboot: number; seed: number; alpha: number };
  predict: {
    enabled: boolean;
    noFolds: number;
    technique: "predict_DA" | "predict_EA";
    seed: number;
    cvpat: boolean;
    cvpatNboot: number;
    /** The endogenous construct the PLSpredict verdict is judged on; default: the final outcome. */
    keyTarget?: string;
  };
  congruence: {
    enabled: boolean;
    nboot: number;
    seed: number;
    alpha: number;
    threshold: number;
    diagonal: Diagonal;
  };
}

export interface AnalysisInput {
  code: string;
  dataText: string;
  dataName?: string;
  options: AnalysisOptions;
}

export type StageId = "parse" | "estimate" | "bootstrap" | "predict" | "cvpat" | "congruence" | "assess";
export type StageStatus = "start" | "done" | "skipped" | "failed";

export interface AnalysisHooks {
  onStage?: (stage: StageId, status: StageStatus, detail?: string) => void;
  onProgress?: (stage: StageId, fraction: number) => void;
}

export type MeasurementClass =
  | "reflective"      // common factor (PLSc) or mode A composite: loadings / reliability / AVE / HTMT criteria
  | "formative"       // mode B composite: weights / VIF criteria
  | "single-item"
  | "unit-weights"
  | "higher-order"
  | "interaction";

export interface ConstructInfo {
  name: string;
  /** seminr mmMatrix type code, or "interaction". */
  type: string;
  class: MeasurementClass;
  /** Human-readable measurement description. */
  label: string;
  items: string[];
  /**
   * Epistemic rho: |cor(PLS construct score, first principal component of its
   * own indicators)|. Below 0.70 the score has been pulled away from its
   * indicators by the structural neighbours (interpretational confounding).
   * Undefined for single-item, interaction and higher-order constructs.
   */
  epistemicRho?: number;
}

export interface StageError { error: string }

export type MediationType =
  | "complementary"      // direct and indirect significant, same sign
  | "competitive"        // direct and indirect significant, opposite signs
  | "indirect-only"      // indirect significant, direct estimated and not significant
  | "direct-only"        // direct significant, indirect not
  | "no effect"          // neither significant
  | "indirect (direct path not in model)"   // indirect significant; the competing direct path was never estimated
  | "none (direct path not in model)";      // indirect not significant; direct path never estimated

export interface SpecificIndirectEffect extends SpecificEffectSignificance {
  /** Direct effect from -> to in the model, NaN when no direct path is specified. */
  directEst: number;
  directP: number;
  /** Zhao, Lynch & Chen (2010) typology, judged at the bootstrap alpha. */
  type: MediationType;
  /** Upsilon effect size: the product of the squared path coefficients along the chain (Lachowicz et al., 2018). */
  upsilon: number;
}

/** Unidimensionality evidence for a reflective construct, as PLS-SEM Using R Ch. 4.2. */
export interface Unidimensionality {
  construct: string;
  /** Eigenvalues of the indicator correlation matrix, descending. */
  eigenvalues: number[];
  /** Horn's parallel analysis: eigenvalues adjusted by the 95th centile of random-data eigenvalues. */
  adjustedEigenvalues: number[];
  /** Revelle's beta: the worst split-half reliability over all splits (exhaustive for ≤ 12 items). */
  revelleBeta: number | null;
  alpha: number;
  /** True when only the first adjusted eigenvalue exceeds 1. */
  unidimensional: boolean;
}

/** Redundancy analysis of a formative construct against a global single-item measure (Ch. 5.3.1). */
export interface RedundancyAnalysis {
  construct: string;
  globalItem: string;
  /** Path coefficient from the formative composite to the global item (≥ 0.70 expected). */
  path: number;
  rSquared: number;
}

/** Ch. 8.3: index of moderated mediation, p(antecedent → mediator) × p(mediator × moderator → outcome). */
export interface ModeratedMediation {
  antecedent: string;
  mediator: string;
  moderator: string;
  outcome: string;
  index: number;
  ciLower: number;
  ciUpper: number;
  p: number;
}

/** Simple-slopes plot of an interaction term (Ch. 7.2). */
export interface SlopePlot {
  interaction: string;
  iv: string;
  moderator: string;
  dv: string;
  svg: string;
}

export interface MediationResult {
  specific: SpecificIndirectEffect[];
  totalIndirect: { from: string; to: string; estimate: number; ciLower: number; ciUpper: number }[];
}

export interface PredictResult {
  noFolds: number;
  technique: "predict_DA" | "predict_EA";
  seed: number;
  plsOutOfSample: NamedMatrix;
  plsInSample: NamedMatrix;
  lmOutOfSample: NamedMatrix;
  lmInSample: NamedMatrix;
  constructError: NamedMatrix;
  /** Q²predict per endogenous indicator against the whole-sample indicator mean. */
  q2Predict: Record<string, number>;
  /** RMSE of predicting each indicator by its whole-sample mean (the naive benchmark). */
  naiveRmse: Record<string, number>;
  /** Which endogenous construct each predicted indicator belongs to. */
  itemConstruct: Record<string, string>;
  /** The construct the headline verdict is judged on. */
  keyTarget: string;
  /** Shmueli et al. (2019) verdict per endogenous construct. */
  verdicts: Record<string, PredictVerdict>;
}

export type PredictPower = "high" | "medium" | "low" | "none";

export interface PredictVerdict {
  construct: string;
  /** Indicators where PLS out-of-sample RMSE < LM RMSE. */
  betterThanLm: number;
  indicators: number;
  /** Indicators where PLS RMSE exceeds the naive-mean RMSE. */
  worseThanNaive: number;
  power: PredictPower;
}

export interface CvpatResult {
  nboot: number;
  seed: number;
  lm: NamedMatrix;
  ia: NamedMatrix;
  description: string;
}

export interface AnalysisResult {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  engine: { app: string; core: string; extras: string };
  input: {
    code: string;
    dataName: string;
    options: AnalysisOptions;
  };
  data: {
    /** Cases in the pasted data. */
    n: number;
    /** Cases used for estimation (after na_omit, if chosen). */
    nEstimation: number;
    columns: number;
    /** Missing cells per model indicator, counting NaN and the missing marker. */
    missing: Record<string, number>;
    nonNumericColumns: string[];
  };
  model: {
    constructs: ConstructInfo[];
    paths: { from: string; to: string }[];
    iterations: number;
    warnings: string[];
    /** Graphviz DOT of the estimated model, as seminr's plot(model). */
    dot: string;
    /** Graphviz DOT of the bootstrapped model, as seminr's plot(boot_model). */
    dotBoot?: string;
  };
  /** Ch. 4.2: unidimensionality of every multi-item reflective / mode A construct. */
  unidimensionality: Unidimensionality[];
  /** Ch. 5.3.1: redundancy analysis for every formative construct with a detectable global item. */
  redundancy: RedundancyAnalysis[];
  /** Ch. 7.2: simple-slope plots for every interaction term. */
  slopes: SlopePlot[];
  summary: Omit<PlsSummary, "compositeScores">;
  bootstrap?: (PlsBootSummary & {
    seed: number; alpha: number; fails: number;
    /** HTMT intervals at alpha = 0.10, i.e. the one-sided 95% upper bound the textbook inspects (Ch. 4.6). */
    bootstrappedHtmt90: NamedMatrix;
  }) | StageError;
  /** Ch. 8.3: index of moderated mediation for every antecedent → mediator × moderator → outcome chain. */
  moderatedMediation?: ModeratedMediation[];
  mediation?: MediationResult | StageError;
  predict?: PredictResult | StageError;
  cvpat?: CvpatResult | StageError;
  congruence?: ModelCongruenceResult | StageError;
  assessment: AssessmentItem[];
  rScript: string;
  timingsMs: Partial<Record<StageId, number>>;
}

export function isStageError(x: unknown): x is StageError {
  return !!x && typeof x === "object" && "error" in (x as object);
}

function describeConstruct(model: PlsModel, parsed: ParsedModel, name: string): ConstructInfo {
  let type = "unknown";
  try { type = constructType(model, name); } catch { /* not in the estimated model */ }
  let items: string[] = [];
  try { items = constructItems(model, name); } catch { /* interaction / HOC */ }
  const spec = parsed.measurement.find((m) => m.name === name);
  if (spec?.kind === "construct") items = spec.items;
  if (spec?.kind === "higher_composite") items = spec.dimensions;

  let cls: MeasurementClass;
  let label: string;
  if (spec?.kind === "interaction") {
    cls = "interaction";
    label = `${spec.quadratic ? "Quadratic" : "Interaction"} term (${spec.method.replace("_", " ")})`;
  } else if (spec?.kind === "higher_composite") {
    cls = "higher-order";
    label = `Higher-order composite, ${spec.weights === "mode_B" ? "mode B" : "mode A"} (two-stage)`;
  } else if (items.length === 1) {
    cls = "single-item";
    label = "Single-item construct";
  } else if (type === "C" || spec?.reflective) {
    cls = "reflective";
    label = "Reflective common factor (PLSc)";
  } else if (type === "B" || spec?.weights === "mode_B") {
    cls = "formative";
    label = "Formative composite (mode B)";
  } else if (type === "UNIT" || spec?.weights === "unit_weights") {
    cls = "unit-weights";
    label = "Composite with unit weights";
  } else {
    cls = "reflective";
    label = "Composite, mode A (correlation weights)";
  }
  return { name, type, class: cls, label, items };
}

/** All simple chains from -> m1 [-> m2] -> to that exist in the structural model. */
function mediationChains(paths: { from: string; to: string }[], maxMediators = 2): { from: string; through: string[]; to: string }[] {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    if (!out.has(p.from)) out.set(p.from, []);
    out.get(p.from)!.push(p.to);
  }
  const chains: { from: string; through: string[]; to: string }[] = [];
  const nodes = [...new Set(paths.flatMap((p) => [p.from, p.to]))];
  for (const from of nodes) {
    const walk = (node: string, through: string[]) => {
      for (const next of out.get(node) ?? []) {
        if (next === from || through.includes(next)) continue;
        if (through.length >= 1) chains.push({ from, through: [...through], to: next });
        if (through.length < maxMediators) walk(next, [...through, next]);
      }
    };
    walk(from, []);
  }
  return chains;
}

/** Pearson correlation of two equal-length vectors. */
function cor(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

/**
 * Epistemic rho for one construct: |cor(construct score, PC1 of its items)|.
 * PC1 is the top eigenvector of the item correlation matrix (power iteration
 * on a symmetric positive semi-definite matrix, which converges to it).
 */
function epistemicRho(model: PlsModel, construct: string, items: readonly string[]): number {
  const data = model.data;
  const cols = items.map((it) => data.columns.indexOf(it));
  if (cols.some((j) => j < 0) || cols.length < 2) return NaN;
  const n = data.values.length;
  const k = cols.length;
  // standardise items
  const z: number[][] = cols.map((j) => {
    const v = data.values.map((row) => row[j]);
    const m = v.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    return v.map((x) => (x - m) / sd);
  });
  const R: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let a = 0; a < k; a++) for (let b = a; b < k; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += z[a][i] * z[b][i];
    R[a][b] = R[b][a] = sum / (n - 1);
  }
  let v = new Array<number>(k).fill(1 / Math.sqrt(k));
  for (let iter = 0; iter < 500; iter++) {
    const w = R.map((row) => row.reduce((acc, r, j) => acc + r * v[j], 0));
    const norm = Math.sqrt(w.reduce((acc, x) => acc + x * x, 0));
    const next = w.map((x) => x / norm);
    const delta = Math.max(...next.map((x, j) => Math.abs(x - v[j])));
    v = next;
    if (delta < 1e-10) break;
  }
  const pc1 = Array.from({ length: n }, (_, i) => z.reduce((acc, col, j) => acc + col[i] * v[j], 0));
  const cs = model.constructScores;
  const jc = cs.cols.indexOf(construct);
  if (jc < 0) return NaN;
  const score = cs.values.map((row) => row[jc]);
  return Math.abs(cor(score, pc1));
}

/** Standardised item columns and their correlation matrix, from the cleaned estimation data. */
function itemCorrelation(model: PlsModel, items: readonly string[]): { z: number[][]; R: number[][] } | null {
  const data = model.data;
  const cols = items.map((it) => data.columns.indexOf(it));
  if (cols.some((j) => j < 0) || cols.length < 2) return null;
  const n = data.values.length;
  const k = cols.length;
  const z: number[][] = cols.map((j) => {
    const v = data.values.map((row) => row[j]);
    const m = v.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
    return v.map((x) => (x - m) / sd);
  });
  const R: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let a = 0; a < k; a++) for (let b = a; b < k; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += z[a][i] * z[b][i];
    R[a][b] = R[b][a] = sum / (n - 1);
  }
  return { z, R };
}

/** Eigenvalues of a small symmetric matrix by cyclic Jacobi rotations, descending. */
function symmetricEigenvalues(A: readonly (readonly number[])[]): number[] {
  const k = A.length;
  const M = A.map((r) => [...r]);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) off += M[p][q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) {
      if (Math.abs(M[p][q]) < 1e-300) continue;
      const theta = (M[q][q] - M[p][p]) / (2 * M[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s0 = t * c;
      for (let r = 0; r < k; r++) {
        const mrp = M[r][p], mrq = M[r][q];
        M[r][p] = c * mrp - s0 * mrq;
        M[r][q] = s0 * mrp + c * mrq;
      }
      for (let r = 0; r < k; r++) {
        const mpr = M[p][r], mqr = M[q][r];
        M[p][r] = c * mpr - s0 * mqr;
        M[q][r] = s0 * mpr + c * mqr;
      }
    }
  }
  return M.map((r, i) => r[i]).sort((a, b) => b - a);
}

/**
 * Horn's parallel analysis (95th centile, as paran::paran): eigenvalues of
 * correlation matrices of random normal data with the same n and k. Returns the
 * bias to subtract per component (centile eigenvalue − 1).
 */
function parallelBias(n: number, k: number, iterations: number, seed: number): number[] {
  const rng = new _RRNG(seed);
  const normal = () => {
    const u = rng.unifRand(), v = rng.unifRand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const draws: number[][] = Array.from({ length: k }, () => []);
  for (let it = 0; it < iterations; it++) {
    const cols: number[][] = Array.from({ length: k }, () => Array.from({ length: n }, normal));
    const R: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let a = 0; a < k; a++) {
      const ma = cols[a].reduce((x, y) => x + y, 0) / n;
      for (let i = 0; i < n; i++) cols[a][i] -= ma;
    }
    const sd = cols.map((c) => Math.sqrt(c.reduce((x, y) => x + y * y, 0) / (n - 1)));
    for (let a = 0; a < k; a++) for (let b = a; b < k; b++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += cols[a][i] * cols[b][i];
      R[a][b] = R[b][a] = sum / (n - 1) / (sd[a] * sd[b]);
    }
    symmetricEigenvalues(R).forEach((e, j) => draws[j].push(e));
  }
  return draws.map((d) => {
    const sorted = d.sort((a, b) => a - b);
    const h = (sorted.length - 1) * 0.95;
    const lo = Math.floor(h), hi = Math.min(lo + 1, sorted.length - 1);
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]) - 1;
  });
}

/**
 * Revelle's beta: the lowest split-half reliability over every way of
 * splitting the items into two halves, with psych's definition of the split
 * reliability, k² × mean inter-half covariance / total variance (which treats
 * the halves as if parallel, so unequal halves are not penalised). Exhaustive
 * up to 12 items; null beyond. Reproduces the textbook's psych::iclust values.
 */
function revelleBeta(R: readonly (readonly number[])[]): number | null {
  const k = R.length;
  if (k < 2 || k > 12) return null;
  let total = 0;
  for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) total += R[a][b];
  let worst = Infinity;
  const limit = 1 << (k - 1);
  // item 0 always sits in half A, so each split is visited once; mask = limit - 1
  // would leave half B empty and is skipped. Halves need not be equal in size.
  for (let mask = 0; mask < limit - 1; mask++) {
    let cross = 0;
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
      const inA = a === 0 || (mask & (1 << (a - 1))) !== 0;
      const inB = b === 0 || (mask & (1 << (b - 1))) !== 0;
      if (inA && !inB) cross += R[a][b];
    }
    let nA = 0;
    for (let a = 0; a < k; a++) if (a === 0 || (mask & (1 << (a - 1))) !== 0) nA++;
    const nB = k - nA;
    const beta = (k * k * (cross / (nA * nB))) / total;
    if (beta < worst) worst = beta;
  }
  return worst;
}

function unidimensionality(model: PlsModel, c: ConstructInfo, alpha: number, seed: number): Unidimensionality | null {
  const ic = itemCorrelation(model, c.items);
  if (!ic) return null;
  const eigen = symmetricEigenvalues(ic.R);
  const bias = parallelBias(model.data.values.length, c.items.length, 500, seed);
  const adjusted = eigen.map((e, j) => e - bias[j]);
  return {
    construct: c.name,
    eigenvalues: eigen,
    adjustedEigenvalues: adjusted,
    revelleBeta: revelleBeta(ic.R),
    alpha,
    unidimensional: adjusted[0] > 1 && (adjusted.length < 2 || adjusted[1] <= 1),
  };
}

/** Find a global single-item measure for a formative construct, by the textbook's naming (qual_global for QUAL). */
function findGlobalItem(c: ConstructInfo, columns: readonly string[]): string | null {
  const lower = new Map(columns.map((col) => [col.toLowerCase(), col]));
  const name = c.name.toLowerCase();
  const stub = c.items.length ? c.items[0].replace(/\d+$/, "") : "";
  const candidates = [`${name}_global`, `${name}global`, `${stub}global`, `${stub}_global`, `global_${name}`, `${name}_overall`, `${name}_g`];
  for (const cand of candidates) {
    const hit = lower.get(cand.toLowerCase());
    if (hit && !c.items.includes(hit)) return hit;
  }
  return null;
}

function redundancyAnalysis(c: ConstructInfo, globalItem: string, full: Dataset, options: EstimationOptions): RedundancyAnalysis {
  const data = selectColumns(full, [...c.items, globalItem]);
  const mm = mkConstructs(mkComposite(c.name, c.items, MODE_B), mkComposite(`${c.name}_global`, [globalItem]));
  const sm = mkRelationships(mkPaths({ from: c.name, to: `${c.name}_global` }));
  const m = estimatePls({
    data, measurementModel: mm, structuralModel: sm,
    innerWeights: options.innerWeights === "path_factorial" ? pathFactorial : pathWeighting,
    missing: options.missing === "na_omit" ? naOmit : meanReplacement,
    missingValue: options.missingValue,
  });
  const pc = m.pathCoef;
  const path = pc.values[pc.rows.indexOf(c.name)][pc.cols.indexOf(`${c.name}_global`)];
  return { construct: c.name, globalItem, path, rSquared: path * path };
}

function naiveRmse(actuals: NamedMatrix, items: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const j = actuals.cols.indexOf(item);
    if (j < 0) continue;
    const y = actuals.values.map((r) => r[j]);
    const mean = y.reduce((a, b) => a + b, 0) / y.length;
    out[item] = Math.sqrt(y.reduce((a, b) => a + (b - mean) ** 2, 0) / y.length);
  }
  return out;
}

function classifyMediation(directEst: number, directP: number, indirectEst: number, indirectP: number, alpha: number): MediationType {
  const iSig = indirectP < alpha;
  if (!Number.isFinite(directEst)) return iSig ? "indirect (direct path not in model)" : "none (direct path not in model)";
  const dSig = Number.isFinite(directP) && directP < alpha;
  if (iSig && dSig) return Math.sign(directEst) === Math.sign(indirectEst) ? "complementary" : "competitive";
  if (iSig) return "indirect-only";
  if (dSig) return "direct-only";
  return "no effect";
}

function q2Predict(residuals: NamedMatrix, actuals: NamedMatrix): Record<string, number> {
  const out: Record<string, number> = {};
  residuals.cols.forEach((item, j) => {
    const ja = actuals.cols.indexOf(item);
    if (ja < 0) return;
    const y = actuals.values.map((r) => r[ja]);
    const mean = y.reduce((a, b) => a + b, 0) / y.length;
    let sse = 0, sst = 0;
    for (let i = 0; i < y.length; i++) {
      sse += residuals.values[i][j] ** 2;
      sst += (y[i] - mean) ** 2;
    }
    out[item] = 1 - sse / sst;
  });
  return out;
}

export async function runAnalysis(input: AnalysisInput, hooks: AnalysisHooks = {}): Promise<AnalysisResult> {
  const { options } = input;
  const timings: Partial<Record<StageId, number>> = {};
  const stage = (id: StageId, status: StageStatus, detail?: string) => hooks.onStage?.(id, status, detail);
  const timed = <T>(id: StageId, fn: () => T): T => {
    const t = Date.now();
    try { return fn(); } finally { timings[id] = Date.now() - t; }
  };
  const timedAsync = async <T>(id: StageId, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try { return await fn(); } finally { timings[id] = Date.now() - t; }
  };

  // --- parse ----------------------------------------------------------------
  stage("parse", "start");
  const { parsed, data, parsedData } = timed("parse", () => {
    const parsed = parseSeminrModel(input.code);
    const parsedData = parseDataText(input.dataText);
    const needed = requiredItems(parsed);
    const missing = needed.filter((i) => !parsedData.data.columns.includes(i));
    if (missing.length) {
      throw new Error(
        `The data is missing ${missing.length} indicator${missing.length === 1 ? "" : "s"} the model needs: ` +
          missing.slice(0, 8).join(", ") + (missing.length > 8 ? " …" : "") +
          `. Columns found: ${parsedData.data.columns.slice(0, 6).join(", ")}${parsedData.data.columns.length > 6 ? " …" : ""}`,
      );
    }
    const nonNumericUsed = parsedData.nonNumeric.filter((c) => needed.includes(c));
    if (nonNumericUsed.length) {
      throw new Error(
        `These model indicators contain non-numeric values: ${nonNumericUsed.join(", ")}. Recode them as numbers first.`,
      );
    }
    return { parsed, data: selectColumns(parsedData.data, needed), parsedData };
  });
  stage("parse", "done", `${data.values.length} cases × ${parsedData.data.columns.length} columns`);

  // --- estimate -------------------------------------------------------------
  stage("estimate", "start");
  const model = timed("estimate", () => estimateParsedModel(parsed, data, options.estimation));
  const summary = summarizePls(model);
  const constructInfos = parsed.measurement.map((m) => describeConstruct(model, parsed, m.name));
  for (const c of constructInfos) {
    if ((c.class === "reflective" || c.class === "formative" || c.class === "unit-weights") && c.items.length > 1) {
      try {
        const rho = epistemicRho(model, c.name, c.items);
        if (Number.isFinite(rho)) c.epistemicRho = rho;
      } catch { /* leave undefined */ }
    }
  }
  const pathRows = model.structuralModel.toRows().map((r) => ({ from: r.source, to: r.target }));
  stage("estimate", "done", `${model.iterations} iterations`);

  // Ch. 4.2 unidimensionality for reflective / mode A multi-item constructs
  const unidim: Unidimensionality[] = [];
  for (const c of constructInfos) {
    if (c.class !== "reflective" || c.items.length < 2) continue;
    try {
      const u = unidimensionality(model, c, (() => { const m = summary.reliability; const i = m.rows.indexOf(c.name); return i >= 0 ? m.values[i][m.cols.indexOf("alpha")] : NaN; })(), options.bootstrap.seed);
      if (u) unidim.push(u);
    } catch { /* skip */ }
  }
  // Ch. 5.3.1 redundancy analysis wherever a global item can be found in the data
  const redundancy: RedundancyAnalysis[] = [];
  for (const c of constructInfos) {
    if (c.class !== "formative" && c.class !== "unit-weights") continue;
    const g = findGlobalItem(c, parsedData.data.columns);
    if (!g) continue;
    try { redundancy.push(redundancyAnalysis(c, g, parsedData.data, options.estimation)); } catch { /* skip */ }
  }
  // Ch. 7.2 simple slopes for every interaction term with a path into a construct
  const slopes: SlopePlot[] = [];
  for (const m of parsed.measurement) {
    if (m.kind !== "interaction" || m.quadratic) continue;
    for (const p of pathRows) {
      if (p.from !== m.name) continue;
      try { slopes.push({ interaction: m.name, iv: m.iv, moderator: m.moderator, dv: p.to, svg: sanitizeSvg(String(slopeAnalysis(model, p.to, m.moderator, m.iv))) }); } catch { /* skip */ }
    }
  }

  const result: AnalysisResult = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    engine: { app: APP_VERSION, core: coreVersion, extras: extrasVersion },
    input: { code: input.code, dataName: input.dataName ?? "pasted data", options },
    data: {
      n: parsedData.data.values.length,
      nEstimation: model.data.values.length,
      columns: parsedData.data.columns.length,
      missing: missingCounts(data, options.estimation.missingValue),
      nonNumericColumns: parsedData.nonNumeric,
    },
    model: {
      constructs: constructInfos,
      paths: pathRows,
      iterations: model.iterations,
      warnings: model.warnings,
      dot: dotGraph(model, { title: "" }),
    },
    summary: (() => { const { compositeScores: _cs, ...rest } = summary; return rest; })(),
    unidimensionality: unidim,
    redundancy,
    slopes,
    assessment: [],
    rScript: "",
    timingsMs: timings,
  };

  // --- bootstrap and congruence: one replication pass ----------------------
  // The congruence test bootstraps by re-estimating the model on resampled
  // rows — the same work as the bootstrap — so when both are requested with
  // one seed they share a single pass over one R-RNG stream. This is exact:
  // the leading resamples of the stream are what a standalone congruence run
  // would draw.
  const spec = { parsed, data, estimation: options.estimation };
  const wantBoot = options.bootstrap.enabled;
  const wantCong = options.congruence.enabled;
  const fused = wantBoot && wantCong && options.bootstrap.seed === options.congruence.seed;
  let boot: BootModel | null = null;
  let congSpec: ReturnType<typeof congruenceSpec> | null = null;
  if (wantCong) {
    try { congSpec = congruenceSpec(model, options.congruence.diagonal); }
    catch (err) { result.congruence = { error: err instanceof Error ? err.message : String(err) }; }
  }
  const finishCongruence = (reps: (number[] | null)[]) => {
    if (!congSpec) return;
    result.congruence = congruenceFromReplications(model, congSpec, reps, {
      alpha: options.congruence.alpha,
      threshold: options.congruence.threshold,
    });
  };

  if (wantBoot) {
    stage("bootstrap", "start");
    if (fused && congSpec) stage("congruence", "start", "sharing the bootstrap resamples");
    try {
      const shared = await timedAsync("bootstrap", () =>
        bootstrapShared(model, spec, {
          nboot: options.bootstrap.nboot,
          seed: options.bootstrap.seed,
          congruence: fused && congSpec ? { spec: congSpec, count: options.congruence.nboot } : undefined,
          onProgress: (done, total) => hooks.onProgress?.("bootstrap", done / total),
        }),
      );
      boot = shared.boot;
      if (!boot) throw new Error("The bootstrap produced no replications.");
      const bs = summarizePlsBoot(boot, options.bootstrap.alpha);
      result.bootstrap = {
        ...bs, seed: options.bootstrap.seed, alpha: options.bootstrap.alpha, fails: boot.fails,
        bootstrappedHtmt90: parseBootArrayHtmt(htmtOf(model), boot.bootHtmt, 0.10),
      };
      // Ch. 8.3 index of moderated mediation: antecedent -> mediator, mediator*moderator -> outcome
      try {
        const mm: ModeratedMediation[] = [];
        for (const m of parsed.measurement) {
          if (m.kind !== "interaction" || m.quadratic) continue;
          for (const out of pathRows.filter((p) => p.from === m.name)) {
            for (const ante of pathRows.filter((p) => p.to === m.iv)) {
              const prod = boot.bootPaths.map((bp) => {
                const g = (a: string, b: string) => bp.values[bp.rows.indexOf(a)][bp.cols.indexOf(b)];
                return g(ante.from, m.iv) * g(m.name, out.to);
              }).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
              const q = (pq: number) => { const h = (prod.length - 1) * pq; const lo = Math.floor(h), hi = Math.min(lo + 1, prod.length - 1); return prod[lo] + (h - lo) * (prod[hi] - prod[lo]); };
              const below = prod.filter((v) => v <= 0).length / prod.length;
              const pc = model.pathCoef;
              const g0 = (a: string, b: string) => pc.values[pc.rows.indexOf(a)][pc.cols.indexOf(b)];
              mm.push({ antecedent: ante.from, mediator: m.iv, moderator: m.moderator, outcome: out.to, index: g0(ante.from, m.iv) * g0(m.name, out.to), ciLower: q(options.bootstrap.alpha / 2), ciUpper: q(1 - options.bootstrap.alpha / 2), p: 2 * Math.min(below, 1 - below) });
            }
          }
        }
        if (mm.length) result.moderatedMediation = mm;
      } catch { /* optional */ }
      result.model.dotBoot = dotGraph(boot, { title: "", alpha: options.bootstrap.alpha });
      stage("bootstrap", "done", `${boot.boots} resamples${boot.fails ? `, ${boot.fails} failed` : ""}`);
      if (fused && congSpec) {
        try {
          finishCongruence(shared.congruence);
          stage("congruence", "done", `${congSpec.pairs.length} pairs, from the bootstrap resamples`);
        } catch (err) {
          result.congruence = { error: err instanceof Error ? err.message : String(err) };
          stage("congruence", "failed", result.congruence.error);
        }
      }

      // mediation over every chain the structural model contains
      try {
        const chains = mediationChains(pathRows);
        const bp = (result.bootstrap as PlsBootSummary).bootstrappedPaths;
        const specific: SpecificIndirectEffect[] = chains.slice(0, 80).map((c) => {
          const e = specificEffectSignificance(boot!, { from: c.from, to: c.to, through: c.through, alpha: options.bootstrap.alpha });
          const label = `${c.from}  ->  ${c.to}`;
          const i = bp.rows.indexOf(label);
          const directEst = i >= 0 ? bp.values[i][bp.cols.indexOf("Original Est.")] : NaN;
          const directP = i >= 0 ? bp.values[i][bp.cols.indexOf("Bootstrap P Val")] : NaN;
          const chain = [c.from, ...c.through, c.to];
          let upsilon = 1;
          for (let k = 0; k + 1 < chain.length; k++) {
            const m = result.summary.paths;
            const i = m.rows.indexOf(chain[k]), j = m.cols.indexOf(chain[k + 1]);
            upsilon *= i >= 0 && j >= 0 ? m.values[i][j] ** 2 : NaN;
          }
          return { ...e, directEst, directP, type: classifyMediation(directEst, directP, e.originalEst, e.bootstrapP, options.bootstrap.alpha), upsilon };
        });
        const pairs = [...new Set(chains.map((c) => `${c.from} ${c.to}`))].map((k) => k.split(" "));
        const totalIndirect = pairs.map(([from, to]) => {
          const ci = totalIndirectCi(boot!, { from, to, alpha: options.bootstrap.alpha });
          const estimate = (() => {
            const m = result.summary.totalIndirectEffects;
            const i = m.rows.indexOf(from), j = m.cols.indexOf(to);
            return i >= 0 && j >= 0 ? m.values[i][j] : NaN;
          })();
          return { from, to, estimate, ciLower: ci.lower, ciUpper: ci.upper };
        });
        result.mediation = { specific, totalIndirect };
      } catch (err) {
        result.mediation = { error: err instanceof Error ? err.message : String(err) };
      }
    } catch (err) {
      result.bootstrap = { error: err instanceof Error ? err.message : String(err) };
      stage("bootstrap", "failed", result.bootstrap.error);
      if (fused) stage("congruence", "failed", result.bootstrap.error);
    }
  } else {
    stage("bootstrap", "skipped");
  }

  // --- PLSpredict -----------------------------------------------------------
  if (options.predict.enabled) {
    stage("predict", "start");
    try {
      const pr = timed("predict", () => {
        const n = model.data.values.length;
        // The same shuffle seminr's predict_pls() draws after set.seed(seed).
        const ordering = Array.from(new RRNG(options.predict.seed).sampleIntNoReplace(n, n));
        const prediction = predictPls({
          model,
          noFolds: options.predict.noFolds,
          technique: options.predict.technique === "predict_EA" ? predictEA : predictDA,
          ordering,
        });
        const ps: PlsPredictSummary = summarizePlsPredict(prediction);
        const itemConstruct: Record<string, string> = {};
        for (const c of constructInfos) for (const it of c.items) itemConstruct[it] = c.name;
        const naive = naiveRmse(prediction.items.itemActuals, ps.plsOutOfSample.cols);
        const rmse = (m: NamedMatrix, it: string) => m.values[m.rows.indexOf("RMSE")][m.cols.indexOf(it)];
        const verdicts: Record<string, PredictVerdict> = {};
        for (const it of ps.plsOutOfSample.cols) {
          const cname = itemConstruct[it] ?? "?";
          const v = (verdicts[cname] ??= { construct: cname, betterThanLm: 0, indicators: 0, worseThanNaive: 0, power: "none" });
          v.indicators++;
          if (rmse(ps.plsOutOfSample, it) < rmse(ps.lmOutOfSample, it)) v.betterThanLm++;
          if (rmse(ps.plsOutOfSample, it) > naive[it]) v.worseThanNaive++;
        }
        for (const v of Object.values(verdicts)) {
          v.power = v.betterThanLm === v.indicators ? "high" : v.betterThanLm > v.indicators / 2 ? "medium" : v.betterThanLm > 0 ? "low" : "none";
        }
        // Default key target: an endogenous construct that predicts nothing else (the final outcome).
        const endogenous = Object.keys(verdicts);
        const sources = new Set(pathRows.map((p) => p.from));
        const requested = options.predict.keyTarget;
        const keyTarget = requested && verdicts[requested]
          ? requested
          : endogenous.find((c) => !sources.has(c)) ?? endogenous[endogenous.length - 1] ?? "";
        return {
          noFolds: options.predict.noFolds,
          technique: options.predict.technique,
          seed: options.predict.seed,
          plsOutOfSample: ps.plsOutOfSample,
          plsInSample: ps.plsInSample,
          lmOutOfSample: ps.lmOutOfSample,
          lmInSample: ps.lmInSample,
          constructError: ps.constructError,
          q2Predict: q2Predict(prediction.items.plsOutOfSampleResiduals, prediction.items.itemActuals),
          naiveRmse: naive,
          itemConstruct,
          keyTarget,
          verdicts,
        } satisfies PredictResult;
      });
      result.predict = pr;
      stage("predict", "done", `${options.predict.noFolds}-fold`);
    } catch (err) {
      result.predict = { error: err instanceof Error ? err.message : String(err) };
      stage("predict", "failed", result.predict.error);
    }

    if (options.predict.cvpat) {
      stage("cvpat", "start");
      try {
        const cv = timed("cvpat", () =>
          assessCvpat(model, {
            nboot: options.predict.cvpatNboot,
            seed: options.predict.seed,
            noFolds: options.predict.noFolds,
            // One-tailed, H1: PLS predicts better than the benchmark — as the textbook (Ch. 6.3).
            testtype: "greater",
          }),
        );
        if (!cv) throw new Error("CVPAT is not defined for this model (higher-order models are not supported).");
        result.cvpat = {
          nboot: options.predict.cvpatNboot,
          seed: options.predict.seed,
          lm: cv.cvpatCompareLm,
          ia: cv.cvpatCompareIa,
          description: cv.description,
        };
        stage("cvpat", "done");
      } catch (err) {
        result.cvpat = { error: err instanceof Error ? err.message : String(err) };
        stage("cvpat", "failed", result.cvpat.error);
      }
    } else {
      stage("cvpat", "skipped");
    }
  } else {
    stage("predict", "skipped");
    stage("cvpat", "skipped");
  }

  // --- congruence on its own stream (bootstrap off, or a different seed) ----
  if (wantCong && !fused && congSpec) {
    stage("congruence", "start");
    try {
      const shared = await timedAsync("congruence", () =>
        bootstrapShared(model, spec, {
          nboot: 0,
          seed: options.congruence.seed,
          congruence: { spec: congSpec!, count: options.congruence.nboot },
          onProgress: (done, total) => hooks.onProgress?.("congruence", done / total),
        }),
      );
      finishCongruence(shared.congruence);
      stage("congruence", "done", `${congSpec.pairs.length} pairs`);
    } catch (err) {
      result.congruence = { error: err instanceof Error ? err.message : String(err) };
      stage("congruence", "failed", result.congruence.error);
    }
  } else if (!wantCong) {
    stage("congruence", "skipped");
  }

  // --- assessment + R script ------------------------------------------------
  stage("assess", "start");
  result.assessment = timed("assess", () => assessAnalysis(result));
  result.rScript = generateRScript(parsed, options, input.dataName);
  stage("assess", "done", `${result.assessment.length} checks`);
  return result;
}
