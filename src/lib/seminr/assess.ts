/**
 * Threshold-based assessment of an estimated PLS-SEM model.
 *
 * Every check carries its operational definition (what was compared with
 * what), the value, the threshold, and the source of the rule, so that a
 * reader — or a downstream model-evaluation assistant — can see exactly why
 * a flag was raised rather than trusting a traffic light. Rules follow Hair,
 * Hult, Ringle, Sarstedt, Danks & Adler, *PLS-SEM Using R* (Springer), with
 * PLSpredict from Shmueli et al. (2019), CVPAT from Liengaard et al. (2021)
 * and Sharma et al. (2023), and the congruence test from Franke, Sarstedt &
 * Danks (2021). Thresholds are rules of thumb, not laws; the notes say so
 * where the literature is soft.
 */

import type { NamedMatrix } from "@seminr/core";
import type { AnalysisResult, ConstructInfo } from "./analyze";
import { isStageError } from "./analyze";

export type AssessmentStatus = "ok" | "warn" | "fail" | "info";

export type AssessmentSection =
  | "data"
  | "reflective"
  | "formative"
  | "discriminant"
  | "structural"
  | "prediction"
  | "congruence";

export interface AssessmentItem {
  id: string;
  section: AssessmentSection;
  status: AssessmentStatus;
  /** The construct, item, pair, or path the check concerns. */
  subject: string;
  /** What was checked. */
  criterion: string;
  value: number | null;
  /** The rule, in words, e.g. "≥ 0.708". */
  threshold: string;
  message: string;
  source: string;
}

const HAIR = "Hair et al., PLS-SEM Using R";
const SHMUELI = "Shmueli et al. (2019), Eur. J. Marketing";
const CVPAT_REF = "Liengaard et al. (2021); Sharma et al. (2023)";
const FRANKE = "Franke, Sarstedt & Danks (2021), J. Bus. Res.";

function cell(m: NamedMatrix | undefined, row: string, col: string): number {
  if (!m) return NaN;
  const i = m.rows.indexOf(row), j = m.cols.indexOf(col);
  return i >= 0 && j >= 0 ? m.values[i][j] : NaN;
}

function bootRow(m: NamedMatrix | undefined, label: string): Record<string, number> | null {
  if (!m) return null;
  const i = m.rows.indexOf(label);
  if (i < 0) return null;
  const out: Record<string, number> = {};
  m.cols.forEach((c, j) => (out[c] = m.values[i][j]));
  return out;
}

function f3(x: number): string {
  return Number.isFinite(x) ? x.toFixed(3) : "n/a";
}

export function assessAnalysis(r: AnalysisResult): AssessmentItem[] {
  const items: AssessmentItem[] = [];
  const push = (it: Omit<AssessmentItem, "id">) =>
    items.push({ id: `${it.section}:${it.criterion}:${it.subject}`.replace(/\s+/g, "_"), ...it });

  const constructs = r.model.constructs;
  const summary = r.summary;
  const boot = r.bootstrap && !isStageError(r.bootstrap) ? r.bootstrap : null;
  const alpha = r.input.options.bootstrap.alpha;
  const bootPaths = boot?.bootstrappedPaths;
  const bootWeights = boot?.bootstrappedWeights;
  const bootHtmt = boot?.bootstrappedHtmt;
  const ciUpperLabel = bootPaths?.cols.find((c) => /% CI$/.test(c) && !c.startsWith(String((alpha / 2) * 100))) ?? "";

  // --- data -----------------------------------------------------------------
  const n = r.data.nEstimation;
  const maxArrows = Math.max(
    ...summary.paths.cols.map((dv) => summary.paths.rows.filter((row) => !/R\^2/.test(row) && Number.isFinite(cell(summary.paths, row, dv))).length),
    0,
  );
  push({
    section: "data", status: n >= 10 * maxArrows ? (n >= 100 ? "ok" : "warn") : "fail",
    subject: "Sample", criterion: "Sample size",
    value: n, threshold: `≥ 10 × ${maxArrows} arrows (${10 * maxArrows}); ideally ≥ 100`,
    message: `${n} cases were estimated; the busiest endogenous construct has ${maxArrows} predictors. The 10-times rule is a floor, not a power analysis — use the inverse square-root or gamma-exponential method for a proper minimum.`,
    source: `${HAIR}, Ch. 1; Kock & Hadaya (2018)`,
  });
  for (const [col, miss] of Object.entries(r.data.missing)) {
    const share = miss / r.data.n;
    if (share > 0.05) {
      push({
        section: "data", status: share > 0.15 ? "fail" : "warn", subject: col, criterion: "Missing values",
        value: share, threshold: "≤ 5% per indicator (≤ 15% tolerable)",
        message: `${col} is missing ${(share * 100).toFixed(1)}% of cases (${miss} of ${r.data.n}); ${r.input.options.estimation.missing === "na_omit" ? "those rows were dropped" : "they were mean-replaced"}.`,
        source: `${HAIR}, Ch. 2`,
      });
    }
  }
  if (r.model.iterations >= 300) {
    push({
      section: "data", status: "fail", subject: "Algorithm", criterion: "Convergence",
      value: r.model.iterations, threshold: "< 300 iterations",
      message: "The PLS algorithm hit the iteration limit; the weights may not have converged.",
      source: HAIR,
    });
  }

  // --- reflective measurement ----------------------------------------------
  const reflective = constructs.filter((c) => c.class === "reflective" || (c.class === "higher-order" && !/mode B/.test(c.label)));
  for (const c of reflective) {
    for (const it of c.items) {
      const l = cell(summary.loadings, it, c.name);
      if (!Number.isFinite(l)) continue;
      push({
        section: "reflective",
        status: Math.abs(l) >= 0.708 ? "ok" : Math.abs(l) >= 0.4 ? "warn" : "fail",
        subject: `${it} → ${c.name}`, criterion: "Indicator loading",
        value: l, threshold: "≥ 0.708 (indicator reliability ≥ 0.50)",
        message: Math.abs(l) >= 0.708
          ? `Loading ${f3(l)}; indicator reliability ${f3(l * l)}.`
          : Math.abs(l) >= 0.4
            ? `Loading ${f3(l)} is below 0.708. Keep the indicator only if removing it would not raise rhoC or AVE above their thresholds, or if content validity requires it.`
            : `Loading ${f3(l)} is below 0.40; the indicator should normally be removed.`,
        source: `${HAIR}, Ch. 4`,
      });
    }
    if (c.items.length < 2) continue;
    for (const [stat, label] of [["alpha", "Cronbach's alpha"], ["rhoA", "rho_A"], ["rhoC", "Composite reliability rho_C"]] as const) {
      const v = cell(summary.reliability, c.name, stat);
      if (!Number.isFinite(v)) continue;
      const status: AssessmentStatus = v >= 0.95 ? "warn" : v >= 0.7 ? "ok" : v >= 0.6 ? "warn" : "fail";
      push({
        section: "reflective", status, subject: c.name, criterion: label,
        value: v, threshold: "0.70 – 0.95 (0.60 – 0.70 acceptable in exploratory research)",
        message: v >= 0.95
          ? `${label} = ${f3(v)} is above 0.95: the indicators may be semantically redundant, which inflates error-term correlations and can indicate a straight-lining response pattern.`
          : v >= 0.7 ? `${label} = ${f3(v)}.`
          : v >= 0.6 ? `${label} = ${f3(v)} is below 0.70; acceptable only in exploratory research.`
          : `${label} = ${f3(v)} is below 0.60.`,
        source: `${HAIR}, Ch. 4`,
      });
    }
    const ave = cell(summary.reliability, c.name, "AVE");
    if (Number.isFinite(ave)) {
      push({
        section: "reflective", status: ave >= 0.5 ? "ok" : "fail", subject: c.name, criterion: "AVE (convergent validity)",
        value: ave, threshold: "≥ 0.50",
        message: ave >= 0.5 ? `AVE = ${f3(ave)}: the construct explains at least half of its indicators' variance.` : `AVE = ${f3(ave)}: on average the construct explains less than half of its indicators' variance.`,
        source: `${HAIR}, Ch. 4`,
      });
    }
  }

  // --- formative measurement -----------------------------------------------
  const formative = constructs.filter((c) => c.class === "formative" || (c.class === "higher-order" && /mode B/.test(c.label)));
  for (const c of formative) {
    const vifs = summary.validity.vifItems[c.name] ?? {};
    for (const it of c.items) {
      const v = vifs[it];
      if (Number.isFinite(v)) {
        push({
          section: "formative", status: v < 3 ? "ok" : v < 5 ? "warn" : "fail",
          subject: `${it} (${c.name})`, criterion: "Indicator VIF (collinearity)",
          value: v, threshold: "< 3 ideally; < 5 acceptable",
          message: v < 3 ? `VIF = ${f3(v)}.` : v < 5 ? `VIF = ${f3(v)} suggests some collinearity among the indicators of ${c.name}.` : `VIF = ${f3(v)}: critical collinearity; consider merging or removing indicators.`,
          source: `${HAIR}, Ch. 5`,
        });
      }
      const w = cell(summary.weights, it, c.name);
      const l = cell(summary.loadings, it, c.name);
      const br = bootRow(bootWeights, `${it}  ->  ${c.name}`);
      if (br) {
        const p = br["Bootstrap P Val"];
        const sig = p < alpha;
        const status: AssessmentStatus = sig ? "ok" : Math.abs(l) >= 0.5 ? "warn" : "fail";
        push({
          section: "formative", status, subject: `${it} → ${c.name}`, criterion: "Outer weight significance",
          value: w, threshold: `bootstrap p < ${alpha}; else loading ≥ 0.50`,
          message: sig
            ? `Weight ${f3(w)} is significant (p = ${f3(p)}, ${ciUpperLabel ? `CI [${f3(br[bootPaths!.cols[4]])}, ${f3(br[ciUpperLabel])}]` : ""}).`
            : Math.abs(l) >= 0.5
              ? `Weight ${f3(w)} is not significant (p = ${f3(p)}) but the loading is ${f3(l)} (≥ 0.50): the indicator is absolutely, if not relatively, important — retain it.`
              : `Weight ${f3(w)} is not significant (p = ${f3(p)}) and the loading ${f3(l)} is below 0.50: consider removal unless theory demands the indicator.`,
          source: `${HAIR}, Ch. 5`,
        });
      } else {
        push({
          section: "formative", status: "info", subject: `${it} → ${c.name}`, criterion: "Outer weight",
          value: w, threshold: "significance needs a bootstrap",
          message: `Weight ${f3(w)}, loading ${f3(l)}. Run the bootstrap to test significance.`,
          source: `${HAIR}, Ch. 5`,
        });
      }
    }
    push({
      section: "formative", status: "info", subject: c.name, criterion: "Convergent validity (redundancy analysis)",
      value: null, threshold: "path to a global single-item measure ≥ 0.70",
      message: `Not assessed here: redundancy analysis needs a separate global measure of ${c.name} regressed on the formative composite.`,
      source: `${HAIR}, Ch. 5`,
    });
  }

  // --- discriminant validity (HTMT) ----------------------------------------
  const htmtNames = constructs.filter((c) => c.class === "reflective" && c.items.length > 1).map((c) => c.name);
  const htmt = summary.validity.htmt;
  for (let a = 0; a < htmtNames.length; a++) {
    for (let b = a + 1; b < htmtNames.length; b++) {
      const x = htmtNames[a], y = htmtNames[b];
      let v = cell(htmt, x, y);
      if (!Number.isFinite(v)) v = cell(htmt, y, x);
      if (!Number.isFinite(v)) continue;
      const br = bootRow(bootHtmt, `${x}  ->  ${y}`) ?? bootRow(bootHtmt, `${y}  ->  ${x}`);
      const upper = br && ciUpperLabel ? br[ciUpperLabel] : NaN;
      let status: AssessmentStatus = v < 0.85 ? "ok" : v < 0.9 ? "warn" : "fail";
      let message = v < 0.85
        ? `HTMT = ${f3(v)}.`
        : v < 0.9
          ? `HTMT = ${f3(v)} is between 0.85 and 0.90: acceptable only if ${x} and ${y} are conceptually similar.`
          : `HTMT = ${f3(v)} is at or above 0.90: discriminant validity is in doubt.`;
      if (Number.isFinite(upper)) {
        if (upper >= 1) { status = "fail"; message += ` The bootstrap ${ciUpperLabel} upper bound ${f3(upper)} includes 1.`; }
        else if (upper >= 0.9 && status === "ok") { status = "warn"; message += ` The bootstrap ${ciUpperLabel} upper bound is ${f3(upper)} (≥ 0.90).`; }
        else message += ` Bootstrap ${ciUpperLabel} upper bound ${f3(upper)}.`;
      }
      push({
        section: "discriminant", status, subject: `${x} ↔ ${y}`, criterion: "HTMT",
        value: v, threshold: "< 0.85 (conceptually distinct) or < 0.90 (similar); CI upper bound < threshold",
        message, source: `${HAIR}, Ch. 4; Henseler, Ringle & Sarstedt (2015)`,
      });
    }
  }
  const nonReflective = constructs.filter((c) => c.class !== "reflective" || c.items.length < 2);
  if (nonReflective.length && htmtNames.length) {
    push({
      section: "discriminant", status: "info", subject: nonReflective.map((c) => c.name).join(", "),
      criterion: "HTMT scope", value: null, threshold: "reflective, multi-item constructs only",
      message: "HTMT is defined for reflectively measured constructs; single-item, formative, and interaction constructs are shown in the HTMT table for reference but not assessed.",
      source: `${HAIR}, Ch. 4`,
    });
  }

  // --- structural model ------------------------------------------------------
  for (const [dv, ants] of Object.entries(summary.vifAntecedents)) {
    for (const [iv, v] of Object.entries(ants)) {
      if (!Number.isFinite(v)) continue;
      push({
        section: "structural", status: v < 3 ? "ok" : v < 5 ? "warn" : "fail",
        subject: `${iv} → ${dv}`, criterion: "Antecedent VIF (collinearity)",
        value: v, threshold: "< 3 ideally; < 5 acceptable",
        message: v < 3 ? `VIF = ${f3(v)}.` : v < 5 ? `VIF = ${f3(v)}: some collinearity among the predictors of ${dv}.` : `VIF = ${f3(v)}: critical collinearity among the predictors of ${dv}; coefficients are unstable.`,
        source: `${HAIR}, Ch. 6`,
      });
    }
  }
  for (const dv of summary.paths.cols) {
    const r2 = cell(summary.paths, "R^2", dv);
    const adj = cell(summary.paths, "AdjR^2", dv);
    if (!Number.isFinite(r2)) continue;
    push({
      section: "structural", status: "info", subject: dv, criterion: "R² (explanatory power)",
      value: r2, threshold: "0.75 substantial · 0.50 moderate · 0.25 weak (field-dependent)",
      message: `R² = ${f3(r2)} (adjusted ${f3(adj)}): ${r2 >= 0.75 ? "substantial" : r2 >= 0.5 ? "moderate" : r2 >= 0.25 ? "weak" : "low"} in-sample explanatory power by the usual rule of thumb. Judge it against your field's benchmarks.`,
      source: `${HAIR}, Ch. 6`,
    });
  }
  for (const p of r.model.paths) {
    const est = cell(summary.paths, p.from, p.to);
    const f2 = cell(summary.fSquare, p.from, p.to);
    const br = bootRow(bootPaths, `${p.from}  ->  ${p.to}`);
    if (br) {
      const pv = br["Bootstrap P Val"];
      const lo = br[bootPaths!.cols[4]], hi = br[ciUpperLabel];
      const sig = pv < alpha;
      push({
        section: "structural", status: sig ? "ok" : "warn", subject: `${p.from} → ${p.to}`, criterion: "Path coefficient significance",
        value: est, threshold: `bootstrap p < ${alpha}; percentile CI excludes 0`,
        message: `β = ${f3(est)}, ${(100 * (1 - alpha)).toFixed(0)}% CI [${f3(lo)}, ${f3(hi)}], p = ${f3(pv)}${sig ? "" : " — not significant"}.`,
        source: `${HAIR}, Ch. 6`,
      });
    }
    if (Number.isFinite(f2)) {
      push({
        section: "structural", status: "info", subject: `${p.from} → ${p.to}`, criterion: "f² effect size",
        value: f2, threshold: "0.02 small · 0.15 medium · 0.35 large",
        message: `f² = ${f3(f2)}: ${f2 >= 0.35 ? "large" : f2 >= 0.15 ? "medium" : f2 >= 0.02 ? "small" : "negligible"} effect of ${p.from} on ${p.to}.`,
        source: `${HAIR}, Ch. 6; Cohen (1988)`,
      });
    }
  }
  if (boot && boot.nboot < 5000) {
    push({
      section: "structural", status: "info", subject: "Bootstrap", criterion: "Number of resamples",
      value: boot.nboot, threshold: "10,000 for final reporting",
      message: `${boot.nboot} resamples were used. That is fine for exploration; use 10,000 for the numbers you publish.`,
      source: `${HAIR}, Ch. 6`,
    });
  }

  // --- prediction -------------------------------------------------------------
  if (r.predict && !isStageError(r.predict)) {
    const pr = r.predict;
    const items = pr.plsOutOfSample.cols;
    let better = 0, worse = 0;
    for (const it of items) {
      const q2 = pr.q2Predict[it];
      const pls = cell(pr.plsOutOfSample, "RMSE", it);
      const lm = cell(pr.lmOutOfSample, "RMSE", it);
      if (Number.isFinite(q2)) {
        push({
          section: "prediction", status: q2 > 0 ? "ok" : "fail", subject: `${it} (${pr.itemConstruct[it] ?? ""})`, criterion: "Q²predict",
          value: q2, threshold: "> 0",
          message: q2 > 0 ? `Q²predict = ${f3(q2)}: out-of-sample predictions beat the naive indicator mean.` : `Q²predict = ${f3(q2)}: predictions are no better than the indicator mean.`,
          source: `${SHMUELI}; benchmark here is the whole-sample indicator mean`,
        });
      }
      if (Number.isFinite(pls) && Number.isFinite(lm)) {
        if (pls < lm) better++; else worse++;
        push({
          section: "prediction", status: pls < lm ? "ok" : "warn", subject: `${it} (${pr.itemConstruct[it] ?? ""})`, criterion: "PLS vs LM out-of-sample RMSE",
          value: pls - lm, threshold: "PLS RMSE < LM RMSE",
          message: `PLS ${f3(pls)} vs LM ${f3(lm)}: PLS ${pls < lm ? "beats" : "does not beat"} the linear-model benchmark for ${it}.`,
          source: SHMUELI,
        });
      }
    }
    const total = better + worse;
    if (total) {
      const verdict = better === total ? "high" : better > total / 2 ? "medium" : better > 0 ? "low" : "no";
      push({
        section: "prediction", status: verdict === "high" || verdict === "medium" ? "ok" : verdict === "low" ? "warn" : "fail",
        subject: "Model", criterion: "PLSpredict verdict",
        value: better / total, threshold: "all indicators → high; majority → medium; minority → low; none → lacks predictive power",
        message: `PLS beats LM on ${better} of ${total} endogenous indicators (out-of-sample RMSE): ${verdict} predictive power.`,
        source: SHMUELI,
      });
    }
  }
  if (r.cvpat && !isStageError(r.cvpat)) {
    for (const [name, table] of [["LM", r.cvpat.lm], ["IA", r.cvpat.ia]] as const) {
      const diff = cell(table, "Overall", "Diff");
      const p = cell(table, "Overall", "Boot P Value");
      if (!Number.isFinite(diff)) continue;
      const better = diff < 0;
      const sig = p < alpha;
      push({
        section: "prediction", status: better && sig ? "ok" : !better && sig ? "fail" : "info",
        subject: `Overall vs ${name}`, criterion: `CVPAT loss difference (PLS − ${name})`,
        value: diff, threshold: `Diff < 0 with p < ${alpha}`,
        message: `Average loss difference ${f3(diff)} (p = ${f3(p)}): PLS is ${better ? "lower" : "higher"} loss than the ${name === "LM" ? "linear-model" : "indicator-average"} benchmark${sig ? "" : ", not significantly"}.`,
        source: CVPAT_REF,
      });
    }
  }

  // --- congruence ---------------------------------------------------------------
  if (r.congruence && !isStageError(r.congruence)) {
    for (const row of r.congruence.rows) {
      push({
        section: "congruence", status: row.significant ? "ok" : "warn", subject: row.pair.replace(" -> ", " ↔ "),
        criterion: "Congruence coefficient", value: row.estimate,
        threshold: `bootstrap ${r.congruence.hiLabel} upper bound < ${r.congruence.threshold}`,
        message: row.significant
          ? `Congruence ${f3(row.estimate)}, CI [${f3(row.ciLo)}, ${f3(row.ciHi)}]: the two constructs are empirically distinguishable.`
          : `Congruence ${f3(row.estimate)}, CI [${f3(row.ciLo)}, ${f3(row.ciHi)}] reaches the threshold: redundancy in the nomological network cannot be ruled out.`,
        source: FRANKE,
      });
    }
  }

  return items;
}

/** Counts by status, for the summary strip. */
export function tallyAssessment(items: AssessmentItem[]): Record<AssessmentStatus, number> {
  const t: Record<AssessmentStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const it of items) t[it.status]++;
  return t;
}

export function constructLabel(c: ConstructInfo): string {
  return `${c.name} — ${c.label}, ${c.items.length} ${c.class === "higher-order" ? "dimension" : "item"}${c.items.length === 1 ? "" : "s"}`;
}
