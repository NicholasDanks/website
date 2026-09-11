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
  version as coreVersion,
  type PlsModel, type BootModel, type PlsSummary, type PlsBootSummary, type PlsPredictSummary,
  type NamedMatrix, type SpecificEffectSignificance,
} from "@seminr/core";
import { assessCvpat, version as extrasVersion } from "@seminr/extras";
import { parseSeminrModel, requiredItems, type ParsedModel } from "./parseSeminr";
import { parseDataText, selectColumns, missingCounts } from "./data";
import { estimateParsedModel, type EstimationOptions } from "./specify";
import { bootstrapInChunks } from "./bootstrap";
import { congruenceFromModel, type Diagonal, type ModelCongruenceResult } from "./congruence";
import { RRNG } from "./rrng";
import { assessAnalysis, type AssessmentItem } from "./assess";
import { generateRScript } from "./rcode";

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
}

export interface StageError { error: string }

export interface MediationResult {
  specific: SpecificEffectSignificance[];
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
  /** Which endogenous construct each predicted indicator belongs to. */
  itemConstruct: Record<string, string>;
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
  summary: Omit<PlsSummary, "compositeScores">;
  bootstrap?: (PlsBootSummary & { seed: number; alpha: number; fails: number }) | StageError;
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

export function runAnalysis(input: AnalysisInput, hooks: AnalysisHooks = {}): AnalysisResult {
  const { options } = input;
  const timings: Partial<Record<StageId, number>> = {};
  const stage = (id: StageId, status: StageStatus, detail?: string) => hooks.onStage?.(id, status, detail);
  const timed = <T>(id: StageId, fn: () => T): T => {
    const t = Date.now();
    try { return fn(); } finally { timings[id] = Date.now() - t; }
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
  const pathRows = model.structuralModel.toRows().map((r) => ({ from: r.source, to: r.target }));
  stage("estimate", "done", `${model.iterations} iterations`);

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
    assessment: [],
    rScript: "",
    timingsMs: timings,
  };

  // --- bootstrap ------------------------------------------------------------
  let boot: BootModel | null = null;
  if (options.bootstrap.enabled) {
    stage("bootstrap", "start");
    try {
      boot = timed("bootstrap", () =>
        bootstrapInChunks(model, {
          nboot: options.bootstrap.nboot,
          seed: options.bootstrap.seed,
          onProgress: (done, total) => hooks.onProgress?.("bootstrap", done / total),
        }),
      );
      const bs = summarizePlsBoot(boot, options.bootstrap.alpha);
      result.bootstrap = { ...bs, seed: options.bootstrap.seed, alpha: options.bootstrap.alpha, fails: boot.fails };
      result.model.dotBoot = dotGraph(boot, { title: "", alpha: options.bootstrap.alpha });
      stage("bootstrap", "done", `${boot.boots} resamples${boot.fails ? `, ${boot.fails} failed` : ""}`);

      // mediation over every chain the structural model contains
      try {
        const chains = mediationChains(pathRows);
        const specific = chains.slice(0, 80).map((c) =>
          specificEffectSignificance(boot!, { from: c.from, to: c.to, through: c.through, alpha: options.bootstrap.alpha }),
        );
        const pairs = [...new Set(chains.map((c) => `${c.from} ${c.to}`))].map((k) => k.split(" "));
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
          itemConstruct,
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

  // --- congruence -----------------------------------------------------------
  if (options.congruence.enabled) {
    stage("congruence", "start");
    try {
      result.congruence = timed("congruence", () =>
        congruenceFromModel(model, model.rawdata, {
          nboot: options.congruence.nboot,
          seed: options.congruence.seed,
          alpha: options.congruence.alpha,
          threshold: options.congruence.threshold,
          diagonal: options.congruence.diagonal,
          onProgress: (f) => hooks.onProgress?.("congruence", f),
        }),
      );
      stage("congruence", "done", `${result.congruence.rows.length} pairs`);
    } catch (err) {
      result.congruence = { error: err instanceof Error ? err.message : String(err) };
      stage("congruence", "failed", result.congruence.error);
    }
  } else {
    stage("congruence", "skipped");
  }

  // --- assessment + R script ------------------------------------------------
  stage("assess", "start");
  result.assessment = timed("assess", () => assessAnalysis(result));
  result.rScript = generateRScript(parsed, options, input.dataName);
  stage("assess", "done", `${result.assessment.length} checks`);
  return result;
}
