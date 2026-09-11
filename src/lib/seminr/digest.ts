/**
 * What the evaluation assistant is allowed to see: a compact digest of an
 * AnalysisResult made of aggregate statistics only. No data rows, no
 * construct scores, no per-case residuals — nothing from which observations
 * could be reconstructed. The digest is the ONLY thing that leaves the
 * browser, and the page shows it verbatim before anything is sent.
 *
 * Keep this file free of any reference to the raw dataset: it takes an
 * AnalysisResult, which already carries no observations (compositeScores are
 * stripped in analyze.ts), plus the data header (column names, not values).
 */

import type { NamedMatrix } from "@seminr/core";
import type { AnalysisResult } from "./analyze";
import { isStageError } from "./analyze";

const r3 = (x: number): number | null => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

function cell(m: NamedMatrix | undefined | null, row: string, col: string): number {
  if (!m) return NaN;
  const i = m.rows.indexOf(row), j = m.cols.indexOf(col);
  return i >= 0 && j >= 0 ? m.values[i][j] : NaN;
}

/** A NamedMatrix as {row: {col: value}} with rounding and NaN → null. */
function matrixToObject(m: NamedMatrix, opts: { dropZero?: boolean; lowerTriangleOnly?: boolean } = {}): Record<string, Record<string, number | null>> {
  const out: Record<string, Record<string, number | null>> = {};
  m.rows.forEach((r, i) => {
    const row: Record<string, number | null> = {};
    m.cols.forEach((c, j) => {
      const v = m.values[i][j];
      if (!Number.isFinite(v)) return;
      if (opts.dropZero && v === 0) return;
      row[c] = r3(v);
    });
    if (Object.keys(row).length) out[r] = row;
  });
  return out;
}

export interface Digest {
  schema: "seminr-digest/1";
  privacy: string;
  run: {
    label: string;
    cases: number;
    casesEstimated: number;
    missingStrategy: string;
    innerWeights: string;
    bootstrap: null | { resamples: number; alpha: number; failed: number };
    predict: null | { folds: number; technique: string; keyTarget: string };
    congruence: null | { resamples: number; diagonal: string; threshold: number };
  };
  /** Column names available in the data (names only, never values). */
  availableColumns: string[];
  modelCode: string;
  constructs: { name: string; measurement: string; class: string; items: string[]; epistemicRho: number | null }[];
  paths: { from: string; to: string; beta: number | null; p: number | null; ciLower: number | null; ciUpper: number | null; f2: number | null }[];
  rSquared: Record<string, { r2: number | null; adjusted: number | null }>;
  reliability: Record<string, Record<string, number | null>>;
  loadings: Record<string, Record<string, number | null>>;
  weights: Record<string, { indicator: string; weight: number | null; p: number | null; loading: number | null; vif: number | null }[]>;
  htmt: { pair: string; htmt: number | null; ciUpper: number | null }[];
  antecedentVif: Record<string, Record<string, number | null>>;
  constructCorrelations: Record<string, Record<string, number | null>>;
  indicatorStatistics: Record<string, Record<string, number | null>>;
  mediation: { path: string; indirect: number | null; p: number | null; direct: number | null; directP: number | null; type: string }[];
  predict: null | {
    verdicts: Record<string, { power: string; betterThanLm: number; indicators: number; worseThanNaive: number }>;
    indicators: { indicator: string; construct: string; plsRmse: number | null; lmRmse: number | null; naiveRmse: number | null; q2predict: number | null }[];
    cvpat: null | { vsLm: { diff: number | null; p: number | null }; vsIa: { diff: number | null; p: number | null } };
  };
  congruence: null | { pair: string; estimate: number | null; ciUpper: number | null; distinguishable: boolean }[];
  /** Quality gates that failed or need a look, and every finding, in words. */
  assessment: { kind: string; status: string; section: string; subject: string; criterion: string; message: string; source: string }[];
  warnings: string[];
}

/** Names come from a CSV header the user may not have written: bound them, strip control characters. */
function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80);
}

export function buildDigest(r: AnalysisResult, availableColumns: string[], label = "current model"): Digest {
  availableColumns = availableColumns.slice(0, 500).map(cleanName);
  label = cleanName(label);
  const s = r.summary;
  const boot = r.bootstrap && !isStageError(r.bootstrap) ? r.bootstrap : null;
  const pr = r.predict && !isStageError(r.predict) ? r.predict : null;
  const cv = r.cvpat && !isStageError(r.cvpat) ? r.cvpat : null;
  const med = r.mediation && !isStageError(r.mediation) ? r.mediation : null;
  const cg = r.congruence && !isStageError(r.congruence) ? r.congruence : null;
  const o = r.input.options;
  const bp = boot?.bootstrappedPaths;
  const ciHi = bp?.cols[5] ?? "";
  const ciLo = bp?.cols[4] ?? "";

  const paths = r.model.paths.map((p) => {
    const label = `${p.from}  ->  ${p.to}`;
    return {
      from: p.from, to: p.to,
      beta: r3(cell(s.paths, p.from, p.to)),
      p: r3(cell(bp, label, "Bootstrap P Val")),
      ciLower: r3(cell(bp, label, ciLo)),
      ciUpper: r3(cell(bp, label, ciHi)),
      f2: r3(cell(s.fSquare, p.from, p.to)),
    };
  });

  const rSquared: Digest["rSquared"] = {};
  for (const dv of s.paths.cols) rSquared[dv] = { r2: r3(cell(s.paths, "R^2", dv)), adjusted: r3(cell(s.paths, "AdjR^2", dv)) };

  const loadings: Digest["loadings"] = {};
  const weights: Digest["weights"] = {};
  for (const c of r.model.constructs) {
    if (c.class === "interaction") continue;
    if (c.class === "formative" || c.class === "unit-weights" || (c.class === "higher-order" && /mode B/.test(c.label))) {
      weights[c.name] = c.items.map((it) => ({
        indicator: it,
        weight: r3(cell(s.weights, it, c.name)),
        p: r3(cell(boot?.bootstrappedWeights, `${it}  ->  ${c.name}`, "Bootstrap P Val")),
        loading: r3(cell(s.loadings, it, c.name)),
        vif: r3(s.validity.vifItems[c.name]?.[it] ?? NaN),
      }));
    } else {
      const row: Record<string, number | null> = {};
      for (const it of c.items) row[it] = r3(cell(s.loadings, it, c.name));
      loadings[c.name] = row;
    }
  }

  const htmt: Digest["htmt"] = [];
  const bh = boot?.bootstrappedHtmt;
  const hm = s.validity.htmt;
  for (let i = 0; i < hm.rows.length; i++) for (let j = 0; j < hm.cols.length; j++) {
    const v = hm.values[i][j];
    if (!Number.isFinite(v)) continue;
    const a = hm.rows[i], b = hm.cols[j];
    const up = bh ? (Number.isFinite(cell(bh, `${a}  ->  ${b}`, ciHi)) ? cell(bh, `${a}  ->  ${b}`, ciHi) : cell(bh, `${b}  ->  ${a}`, ciHi)) : NaN;
    htmt.push({ pair: `${a} <-> ${b}`, htmt: r3(v), ciUpper: r3(up) });
  }

  const antecedentVif: Digest["antecedentVif"] = {};
  for (const [dv, ants] of Object.entries(s.vifAntecedents)) {
    antecedentVif[dv] = {};
    for (const [iv, v] of Object.entries(ants)) if (Number.isFinite(v)) antecedentVif[dv][iv] = r3(v);
  }

  return {
    schema: "seminr-digest/1",
    privacy: "Aggregate statistics of a PLS-SEM model estimated in the user's browser. No observations, scores or residuals are included or available.",
    run: {
      label,
      cases: r.data.n,
      casesEstimated: r.data.nEstimation,
      missingStrategy: o.estimation.missing,
      innerWeights: o.estimation.innerWeights,
      bootstrap: boot ? { resamples: boot.nboot, alpha: boot.alpha, failed: boot.fails } : null,
      predict: pr ? { folds: pr.noFolds, technique: pr.technique, keyTarget: pr.keyTarget } : null,
      congruence: cg ? { resamples: cg.nboot, diagonal: cg.diagonal, threshold: cg.threshold } : null,
    },
    availableColumns,
    modelCode: r.input.code,
    constructs: r.model.constructs.map((c) => ({ name: c.name, measurement: c.label, class: c.class, items: c.items, epistemicRho: c.epistemicRho === undefined ? null : r3(c.epistemicRho) })),
    paths,
    rSquared,
    reliability: matrixToObject(s.reliability),
    loadings,
    weights,
    htmt,
    antecedentVif,
    constructCorrelations: matrixToObject(s.descriptives.correlations.constructs),
    indicatorStatistics: matrixToObject(s.descriptives.statistics.items),
    mediation: med ? med.specific.map((e) => ({ path: e.path, indirect: r3(e.originalEst), p: r3(e.bootstrapP), direct: r3(e.directEst), directP: r3(e.directP), type: e.type })) : [],
    predict: pr ? {
      verdicts: Object.fromEntries(Object.values(pr.verdicts).map((v) => [v.construct, { power: v.power, betterThanLm: v.betterThanLm, indicators: v.indicators, worseThanNaive: v.worseThanNaive }])),
      indicators: pr.plsOutOfSample.cols.map((it) => ({
        indicator: it, construct: pr.itemConstruct[it] ?? "",
        plsRmse: r3(cell(pr.plsOutOfSample, "RMSE", it)), lmRmse: r3(cell(pr.lmOutOfSample, "RMSE", it)),
        naiveRmse: r3(pr.naiveRmse[it]), q2predict: r3(pr.q2Predict[it]),
      })),
      cvpat: cv ? {
        vsLm: { diff: r3(cell(cv.lm, "Overall", "Diff")), p: r3(cell(cv.lm, "Overall", "Boot P Value")) },
        vsIa: { diff: r3(cell(cv.ia, "Overall", "Diff")), p: r3(cell(cv.ia, "Overall", "Boot P Value")) },
      } : null,
    } : null,
    congruence: cg ? cg.rows.map((row) => ({ pair: row.pair.replace(" -> ", " <-> "), estimate: r3(row.estimate), ciUpper: r3(row.ciHi), distinguishable: row.significant })) : null,
    assessment: r.assessment
      .filter((a) => a.kind === "finding" || a.status === "fail" || a.status === "warn")
      .map((a) => ({ kind: a.kind, status: a.status, section: a.section, subject: a.subject, criterion: a.criterion, message: a.message, source: a.source })),
    warnings: r.model.warnings.filter((w) => !/observations are valid/.test(w)),
  };
}

/** Sanity guard: the serialised digest must never carry a long numeric vector. */
export function digestLooksSafe(d: Digest): boolean {
  const text = JSON.stringify(d);
  // any array of 30+ numbers would be a data column
  return !/\[(?:-?\d+(?:\.\d+)?,\s*){30,}/.test(text);
}
