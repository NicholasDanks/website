/**
 * Assessment of an estimated PLS-SEM model, in two kinds:
 *
 *   - gates: quality criteria the model must meet before its results can be
 *     interpreted (indicator reliability, internal consistency, AVE, HTMT,
 *     collinearity, epistemic reliability, sample size, convergence, basic
 *     predictive relevance). Gates carry a pass / check / problem status.
 *   - findings: what the model says (path significance, R², f², predictive
 *     power, mediation). A non-significant path is a result, not a defect,
 *     so findings never carry a traffic light.
 *
 * Every item states what was compared with what, the value, the rule and the
 * source, so a reader — or a downstream model-evaluation assistant — can see
 * exactly why it is there. Rules follow Hair, Hult, Ringle, Sarstedt, Danks &
 * Adler, *PLS-SEM Using R* (Springer), with PLSpredict from Shmueli et al.
 * (2019), CVPAT from Liengaard et al. (2021) and Sharma et al. (2023),
 * mediation typology from Zhao, Lynch & Chen (2010), HTMT inference from
 * Ringle et al. (2023), and the congruence test from Franke, Sarstedt & Danks
 * (2021). Thresholds are rules of thumb, not laws.
 */

import type { NamedMatrix } from "@seminr/core";
import type { AnalysisResult } from "./analyze";
import { isStageError } from "./analyze";

export type AssessmentStatus = "ok" | "warn" | "fail" | "info";
export type AssessmentKind = "gate" | "finding";

export type AssessmentSection =
  | "data"
  | "reflective"
  | "formative"
  | "discriminant"
  | "structural"
  | "prediction"
  | "mediation"
  | "congruence";

export interface AssessmentItem {
  id: string;
  kind: AssessmentKind;
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
const ZHAO = "Zhao, Lynch & Chen (2010), J. Consumer Res.";
const IC = "Burt (1976); Bollen (2007); StablePLS working paper";

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

const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "n/a");

export function assessAnalysis(r: AnalysisResult): AssessmentItem[] {
  const items: AssessmentItem[] = [];
  const gate = (it: Omit<AssessmentItem, "id" | "kind">) =>
    items.push({ id: `gate:${it.section}:${it.criterion}:${it.subject}`.replace(/\s+/g, "_"), kind: "gate", ...it });
  const finding = (it: Omit<AssessmentItem, "id" | "kind" | "status">) =>
    items.push({ id: `finding:${it.section}:${it.criterion}:${it.subject}`.replace(/\s+/g, "_"), kind: "finding", status: "info", ...it });

  const constructs = r.model.constructs;
  const summary = r.summary;
  const boot = r.bootstrap && !isStageError(r.bootstrap) ? r.bootstrap : null;
  const alpha = r.input.options.bootstrap.alpha;
  const bootPaths = boot?.bootstrappedPaths;
  const bootWeights = boot?.bootstrappedWeights;
  // The textbook inspects the HTMT bootstrap at alpha = 0.10 (Ch. 4.6): the 95% one-sided upper bound.
  const bootHtmt = boot?.bootstrappedHtmt90 ?? boot?.bootstrappedHtmt;
  const htmtHiCol = bootHtmt?.cols[5] ?? "";
  const ciLo = bootPaths?.cols[4] ?? "";
  const ciHi = bootPaths?.cols[5] ?? "";
  const ciLabel = `${(100 * (1 - alpha)).toFixed(0)}%`;

  // --- data and estimation ---------------------------------------------------
  const n = r.data.nEstimation;
  const maxArrows = Math.max(
    ...summary.paths.cols.map((dv) => summary.paths.rows.filter((row) => !/R\^2/.test(row) && Number.isFinite(cell(summary.paths, row, dv))).length),
    0,
  );
  gate({
    section: "data", status: n >= 10 * maxArrows ? (n >= 100 ? "ok" : "warn") : "fail",
    subject: "Sample", criterion: "Sample size",
    value: n, threshold: `≥ 10 × ${maxArrows} arrows (${10 * maxArrows}); ideally ≥ 100`,
    message: `${n} cases were estimated; the busiest endogenous construct has ${maxArrows} predictors. The 10-times rule is a floor, not a power analysis — use the inverse square-root or gamma-exponential method for a proper minimum.`,
    source: `${HAIR}, Ch. 1; Kock & Hadaya (2018)`,
  });
  for (const [col, miss] of Object.entries(r.data.missing)) {
    const share = miss / r.data.n;
    if (share > 0.05) {
      gate({
        section: "data", status: share > 0.15 ? "fail" : "warn", subject: col, criterion: "Missing values",
        value: share, threshold: "≤ 5% per indicator (≤ 15% tolerable)",
        message: `${col} is missing ${(share * 100).toFixed(1)}% of cases (${miss} of ${r.data.n}); ${r.input.options.estimation.missing === "na_omit" ? "those rows were dropped" : "they were mean-replaced"}.`,
        source: `${HAIR}, Ch. 2`,
      });
    }
  }
  if (r.model.iterations >= 300) {
    gate({
      section: "data", status: "fail", subject: "Algorithm", criterion: "Convergence",
      value: r.model.iterations, threshold: "< 300 iterations",
      message: "The PLS algorithm hit the iteration limit; the weights may not have converged.",
      source: HAIR,
    });
  }

  // --- reflective measurement --------------------------------------------------
  const reflective = constructs.filter((c) => c.class === "reflective" || (c.class === "higher-order" && !/mode B/.test(c.label)));
  for (const c of reflective) {
    for (const it of c.items) {
      const l = cell(summary.loadings, it, c.name);
      if (!Number.isFinite(l)) continue;
      gate({
        section: "reflective",
        status: Math.abs(l) >= 0.708 ? "ok" : Math.abs(l) >= 0.4 ? "warn" : "fail",
        subject: `${it} → ${c.name}`, criterion: "Indicator loading",
        value: l, threshold: "≥ 0.708 (indicator reliability ≥ 0.50)",
        message: Math.abs(l) >= 0.708
          ? `Loading ${f3(l)}; indicator reliability ${f3(l * l)}.`
          : Math.abs(l) >= 0.4
            ? `Loading ${f3(l)} is below 0.708. Remove the indicator only if that lifts rho_C or AVE above their thresholds and content validity survives.`
            : `Loading ${f3(l)} is below 0.40; the indicator should normally be removed.`,
        source: `${HAIR}, Ch. 4`,
      });
    }
    if (c.items.length < 2) continue;
    for (const [stat, label] of [["alpha", "Cronbach's alpha"], ["rhoA", "rho_A"], ["rhoC", "Composite reliability rho_C"]] as const) {
      const v = cell(summary.reliability, c.name, stat);
      if (!Number.isFinite(v)) continue;
      const status: AssessmentStatus = v >= 0.95 ? "warn" : v >= 0.7 ? "ok" : v >= 0.6 ? "warn" : "fail";
      gate({
        section: "reflective", status, subject: c.name, criterion: label,
        value: v, threshold: "0.70 – 0.95 (0.60 – 0.70 exploratory only)",
        message: v >= 0.95
          ? `${label} = ${f3(v)} is above 0.95: the indicators may be semantically redundant, which inflates error-term correlations and can indicate straight-lining.`
          : v >= 0.7 ? `${label} = ${f3(v)}.`
          : v >= 0.6 ? `${label} = ${f3(v)} is below 0.70; acceptable only in exploratory research.`
          : `${label} = ${f3(v)} is below 0.60.`,
        source: `${HAIR}, Ch. 4`,
      });
    }
    const ave = cell(summary.reliability, c.name, "AVE");
    if (Number.isFinite(ave)) {
      gate({
        section: "reflective", status: ave >= 0.5 ? "ok" : "fail", subject: c.name, criterion: "AVE (convergent validity)",
        value: ave, threshold: "≥ 0.50",
        message: ave >= 0.5 ? `AVE = ${f3(ave)}: the construct explains at least half of its indicators' variance.` : `AVE = ${f3(ave)}: on average the construct explains less than half of its indicators' variance.`,
        source: `${HAIR}, Ch. 4`,
      });
    }
    if (c.epistemicRho !== undefined) {
      gate({
        section: "reflective", status: c.epistemicRho >= 0.7 ? "ok" : "warn", subject: c.name, criterion: "Epistemic rho (score follows its own indicators)",
        value: c.epistemicRho, threshold: "≥ 0.70",
        message: c.epistemicRho >= 0.7
          ? `rho_ε = ${f3(c.epistemicRho)}: the construct score is anchored in its indicators.`
          : `rho_ε = ${f3(c.epistemicRho)}: the inner weighting has pulled the score away from its indicators toward its structural neighbours. Check for weak structural connections; StablePLS inner weighting is the remedy.`,
        source: IC,
      });
    }
  }

  // --- unidimensionality (Ch. 4.2) ----------------------------------------------
  for (const u of r.unidimensionality) {
    const ev = u.adjustedEigenvalues;
    gate({
      section: "reflective", status: u.unidimensional ? "ok" : "warn", subject: u.construct, criterion: "Unidimensionality (parallel analysis)",
      value: ev[0], threshold: "only the first adjusted eigenvalue > 1",
      message: `Adjusted eigenvalues ${ev.map(f3).join(", ")} (raw ${u.eigenvalues.map(f3).join(", ")}): ${u.unidimensional ? "one dimension retained." : `${ev.filter((e) => e > 1).length} dimensions retained — the indicators may not measure a single construct.`}${u.revelleBeta !== null ? ` Revelle's β = ${f3(u.revelleBeta)} vs α = ${f3(u.alpha)}${u.revelleBeta < 0.7 || u.alpha - u.revelleBeta > 0.15 ? "; a β well below α points to a lumpy item set" : ""}.` : ""}`,
      source: `${HAIR}, Ch. 4.2; Horn (1965); Revelle (1979)`,
    });
  }

  // --- formative measurement ---------------------------------------------------
  const formative = constructs.filter((c) => c.class === "formative" || c.class === "unit-weights" || (c.class === "higher-order" && /mode B/.test(c.label)));
  for (const c of formative) {
    const vifs = summary.validity.vifItems[c.name] ?? {};
    for (const it of c.items) {
      const v = vifs[it];
      if (Number.isFinite(v)) {
        gate({
          section: "formative", status: v < 3 ? "ok" : v < 5 ? "warn" : "fail",
          subject: `${it} (${c.name})`, criterion: "Indicator VIF (collinearity)",
          value: v, threshold: "< 3 ideally; < 5 acceptable",
          message: v < 3 ? `VIF = ${f3(v)}.` : v < 5 ? `VIF = ${f3(v)}: some collinearity among the indicators of ${c.name}.` : `VIF = ${f3(v)}: critical collinearity; merge or remove indicators, or split into a higher-order construct.`,
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
        gate({
          section: "formative", status, subject: `${it} → ${c.name}`, criterion: "Outer weight (relative contribution)",
          value: w, threshold: `bootstrap p < ${alpha}; else loading ≥ 0.50`,
          message: sig
            ? `Weight ${f3(w)} is significant (p = ${f3(p)}, ${ciLabel} CI [${f3(br[ciLo])}, ${f3(br[ciHi])}]).`
            : Math.abs(l) >= 0.5
              ? `Weight ${f3(w)} is not significant (p = ${f3(p)}) but the loading is ${f3(l)} (≥ 0.50): the indicator is absolutely, if not relatively, important — retain it.`
              : `Weight ${f3(w)} is not significant (p = ${f3(p)}) and the loading ${f3(l)} is below 0.50: consider removal unless content validity demands the indicator.`,
          source: `${HAIR}, Ch. 5`,
        });
      }
    }
    if (c.epistemicRho !== undefined) {
      gate({
        section: "formative", status: c.epistemicRho >= 0.7 ? "ok" : "fail", subject: c.name, criterion: "Epistemic rho (score follows its own indicators)",
        value: c.epistemicRho, threshold: "≥ 0.70",
        message: c.epistemicRho >= 0.7
          ? `rho_ε = ${f3(c.epistemicRho)}: the composite is anchored in its indicators. For a mode B construct this is the only reliability diagnostic available.`
          : `rho_ε = ${f3(c.epistemicRho)}: interpretational confounding — the composite has been displaced from its indicators toward its structural neighbours. Mode B constructs need at least two structural connections; StablePLS inner weighting is the remedy.`,
        source: IC,
      });
    }
    const red = r.redundancy.find((x) => x.construct === c.name);
    if (red) {
      gate({
        section: "formative", status: red.path >= 0.7 ? "ok" : "fail", subject: c.name, criterion: "Convergent validity (redundancy analysis)",
        value: red.path, threshold: "path to the global single-item measure ≥ 0.70 (R² ≥ 0.50)",
        message: `${c.name} → ${red.globalItem}: path ${f3(red.path)}, R² ${f3(red.rSquared)}. ${red.path >= 0.7 ? "The formative composite captures the concept its global item measures." : "The formative indicators do not adequately capture the concept; review content coverage."}`,
        source: `${HAIR}, Ch. 5.3.1; Cheah et al. (2018)`,
      });
    } else {
      gate({
        section: "formative", status: "info", subject: c.name, criterion: "Convergent validity (redundancy analysis)",
        value: null, threshold: "path to a global single-item measure ≥ 0.70",
        message: `Not assessed: no global single-item measure of ${c.name} was found in the data (the app looks for a column named like ${c.name.toLowerCase()}_global). Add one to run the redundancy analysis.`,
        source: `${HAIR}, Ch. 5.3.1; Cheah et al. (2018)`,
      });
    }
  }

  // --- discriminant validity ---------------------------------------------------
  const htmtNames = constructs.filter((c) => c.class === "reflective" && c.items.length > 1).map((c) => c.name);
  const htmt = summary.validity.htmt;
  for (let a = 0; a < htmtNames.length; a++) {
    for (let b = a + 1; b < htmtNames.length; b++) {
      const x = htmtNames[a], y = htmtNames[b];
      let v = cell(htmt, x, y);
      if (!Number.isFinite(v)) v = cell(htmt, y, x);
      if (!Number.isFinite(v)) continue;
      const br = bootRow(bootHtmt, `${x}  ->  ${y}`) ?? bootRow(bootHtmt, `${y}  ->  ${x}`);
      const upper = br ? br[htmtHiCol] : NaN;
      let status: AssessmentStatus = v < 0.85 ? "ok" : v < 0.9 ? "warn" : "fail";
      let message = v < 0.85
        ? `HTMT = ${f3(v)}.`
        : v < 0.9
          ? `HTMT = ${f3(v)} is between 0.85 and 0.90: acceptable only if ${x} and ${y} are conceptually similar.`
          : `HTMT = ${f3(v)} is at or above 0.90: discriminant validity is in doubt.`;
      if (Number.isFinite(upper)) {
        if (upper >= 1) { status = "fail"; message += ` The 95% one-sided upper bound ${f3(upper)} includes 1.`; }
        else if (upper >= 0.9 && status === "ok") { status = "warn"; message += ` The 95% one-sided upper bound is ${f3(upper)} (≥ 0.90).`; }
        else if (upper >= 0.85 && status === "ok") { status = "warn"; message += ` The 95% one-sided upper bound is ${f3(upper)} (≥ 0.85): distinctness holds only if ${x} and ${y} are conceptually similar.`; }
        else if (upper >= 0.8 && status === "ok") { status = "warn"; message += ` The 95% one-sided upper bound is ${f3(upper)}, within a few hundredths of the 0.85 threshold: a point to discuss, not a failure.`; }
        else message += ` 95% one-sided upper bound ${f3(upper)}.`;
      }
      gate({
        section: "discriminant", status, subject: `${x} ↔ ${y}`, criterion: "HTMT",
        value: v, threshold: "< 0.85 (distinct) or < 0.90 (similar); 95% one-sided upper bound below the threshold",
        message, source: `${HAIR}, Ch. 4.6; Henseler, Ringle & Sarstedt (2015); Ringle et al. (2023)`,
      });
    }
  }
  if (htmtNames.length) {
    gate({
      section: "discriminant", status: "info", subject: "HTMT", criterion: "HTMT2 not available",
      value: null, threshold: "HTMT2 for congeneric constructs",
      message: "The engine computes the original HTMT, which assumes equal loadings within a construct. HTMT2 (geometric mean) is the recommended criterion when loadings differ; it is not available in seminr-ts. Re-check borderline pairs in cSEM if it matters.",
      source: "Roemer, Schuberth & Henseler (2021), IMDS",
    });
  }

  // --- structural gates ---------------------------------------------------------
  for (const [dv, ants] of Object.entries(summary.vifAntecedents)) {
    for (const [iv, v] of Object.entries(ants)) {
      if (!Number.isFinite(v)) continue;
      gate({
        section: "structural", status: v < 3 ? "ok" : v < 5 ? "warn" : "fail",
        subject: `${iv} → ${dv}`, criterion: "Antecedent VIF (collinearity)",
        value: v, threshold: "< 3 ideally; < 5 acceptable",
        message: v < 3 ? `VIF = ${f3(v)}.` : v < 5 ? `VIF = ${f3(v)}: some collinearity among the predictors of ${dv}.` : `VIF = ${f3(v)}: critical collinearity among the predictors of ${dv}; coefficients are unstable.`,
        source: `${HAIR}, Ch. 6`,
      });
    }
  }
  if (boot && boot.nboot < 5000) {
    gate({
      section: "structural", status: "info", subject: "Bootstrap", criterion: "Number of resamples",
      value: boot.nboot, threshold: "≥ 5,000; 10,000 for publication",
      message: `${boot.nboot} resamples were used. Fine for exploration; use 10,000 for the numbers you publish.`,
      source: `${HAIR}, Ch. 6; Becker et al. (2023)`,
    });
  }

  // --- structural findings ------------------------------------------------------
  for (const dv of summary.paths.cols) {
    const r2 = cell(summary.paths, "R^2", dv);
    const adj = cell(summary.paths, "AdjR^2", dv);
    if (!Number.isFinite(r2)) continue;
    finding({
      section: "structural", subject: dv, criterion: "R² (explanatory power)",
      value: r2, threshold: "0.75 substantial · 0.50 moderate · 0.25 weak (field-dependent)",
      message: `R² = ${f3(r2)} (adjusted ${f3(adj)}): ${r2 >= 0.75 ? "substantial" : r2 >= 0.5 ? "moderate" : r2 >= 0.25 ? "weak" : "low"} in-sample explanatory power by the usual rule of thumb. Judge it against your field's benchmarks.`,
      source: `${HAIR}, Ch. 6`,
    });
  }
  for (const p of r.model.paths) {
    const est = cell(summary.paths, p.from, p.to);
    const f2 = cell(summary.fSquare, p.from, p.to);
    const br = bootRow(bootPaths, `${p.from}  ->  ${p.to}`);
    const size = Number.isFinite(f2) ? (f2 >= 0.35 ? "large" : f2 >= 0.15 ? "medium" : f2 >= 0.02 ? "small" : "negligible") : "";
    if (br) {
      const pv = br["Bootstrap P Val"];
      const sig = pv < alpha;
      finding({
        section: "structural", subject: `${p.from} → ${p.to}`, criterion: "Path coefficient",
        value: est, threshold: `${ciLabel} percentile CI excludes 0; f² 0.02 / 0.15 / 0.35`,
        message: `β = ${f3(est)}, ${ciLabel} CI [${f3(br[ciLo])}, ${f3(br[ciHi])}], p = ${f3(pv)}: ${sig ? "supported" : "not supported"}${size ? `; f² = ${f3(f2)} (${size} effect)` : ""}.${sig && Math.abs(est) < 0.1 ? " The effect is significant but trivially small." : ""}`,
        source: `${HAIR}, Ch. 6`,
      });
    } else {
      finding({
        section: "structural", subject: `${p.from} → ${p.to}`, criterion: "Path coefficient",
        value: est, threshold: "significance needs a bootstrap",
        message: `β = ${f3(est)}${size ? `; f² = ${f3(f2)} (${size} effect)` : ""}. Run the bootstrap to test it.`,
        source: `${HAIR}, Ch. 6`,
      });
    }
  }

  // --- mediation findings -------------------------------------------------------
  if (r.mediation && !isStageError(r.mediation)) {
    for (const e of r.mediation.specific) {
      const sig = e.bootstrapP < alpha;
      const ups = Number.isFinite(e.upsilon) ? ` υ = ${f3(e.upsilon)} (${e.upsilon >= 0.09 ? "large" : e.upsilon >= 0.04 ? "medium" : e.upsilon >= 0.01 ? "small" : "negligible"}).` : "";
      finding({
        section: "mediation", subject: e.path, criterion: "Specific indirect effect",
        value: e.originalEst, threshold: `${ciLabel} percentile CI excludes 0; typology by direct × indirect significance; υ 0.01 / 0.04 / 0.09`,
        message: `Indirect effect ${f3(e.originalEst)}, ${ciLabel} CI [${f3(e.ciLower)}, ${f3(e.ciUpper)}], p = ${f3(e.bootstrapP)}${sig ? "" : " — not significant"}; direct effect ${Number.isFinite(e.directEst) ? `${f3(e.directEst)} (p = ${f3(e.directP)})` : "not in the model, so full vs partial mediation cannot be judged"}: ${e.type}.${ups}`,
        source: `${ZHAO}; Nitzl, Roldán & Cepeda (2016); Lachowicz, Preacher & Kelley (2018); ${HAIR}, Ch. 8`,
      });
    }
  }

  for (const mm of r.moderatedMediation ?? []) {
    finding({
      section: "mediation", subject: `${mm.antecedent} → ${mm.mediator} × ${mm.moderator} → ${mm.outcome}`, criterion: "Index of moderated mediation",
      value: mm.index, threshold: `${ciLabel} percentile CI of p1 × p5 excludes 0`,
      message: `Index ${f3(mm.index)}, ${ciLabel} CI [${f3(mm.ciLower)}, ${f3(mm.ciUpper)}], p = ${f3(mm.p)}: the indirect effect of ${mm.antecedent} on ${mm.outcome} through ${mm.mediator} ${mm.p < alpha ? "depends on" : "does not significantly depend on"} ${mm.moderator}.`,
      source: `${HAIR}, Ch. 8.3; Hayes (2015)`,
    });
  }

  // --- prediction ---------------------------------------------------------------
  if (r.predict && !isStageError(r.predict)) {
    const pr = r.predict;
    for (const it of pr.plsOutOfSample.cols) {
      const pls = cell(pr.plsOutOfSample, "RMSE", it);
      const naive = pr.naiveRmse[it];
      if (Number.isFinite(pls) && Number.isFinite(naive)) {
        gate({
          section: "prediction", status: pls <= naive ? "ok" : "fail", subject: `${it} (${pr.itemConstruct[it] ?? ""})`, criterion: "Basic predictive relevance (PLS vs naive mean)",
          value: pr.q2Predict[it] ?? null, threshold: "PLS RMSE ≤ mean-prediction RMSE (Q²predict > 0)",
          message: pls <= naive
            ? `PLS RMSE ${f3(pls)} vs naive ${f3(naive)}; Q²predict = ${f3(pr.q2Predict[it])}.`
            : `PLS RMSE ${f3(pls)} exceeds the naive mean's ${f3(naive)}: the model predicts ${it} worse than its average. That is a serious concern.`,
          source: `${SHMUELI}; benchmark here is the whole-sample indicator mean`,
        });
      }
    }
    for (const v of Object.values(pr.verdicts)) {
      const key = v.construct === pr.keyTarget;
      finding({
        section: "prediction", subject: `${v.construct}${key ? " (key target)" : ""}`, criterion: "PLSpredict verdict",
        value: v.indicators ? v.betterThanLm / v.indicators : null, threshold: "PLS RMSE < LM RMSE: all → high; majority → medium; minority → low; none → no predictive power",
        message: `PLS beats the linear-model benchmark on ${v.betterThanLm} of ${v.indicators} indicators of ${v.construct}: ${v.power === "none" ? "no" : v.power} predictive power.${v.worseThanNaive ? ` ${v.worseThanNaive} indicator${v.worseThanNaive === 1 ? "" : "s"} predicted worse than the naive mean.` : ""}`,
        source: SHMUELI,
      });
    }
  }
  if (r.cvpat && !isStageError(r.cvpat)) {
    for (const [name, table] of [["IA", r.cvpat.ia], ["LM", r.cvpat.lm]] as const) {
      const diff = cell(table, "Overall", "Diff");
      const p = cell(table, "Overall", "Boot P Value");
      if (!Number.isFinite(diff)) continue;
      const better = diff < 0;
      const sig = p < alpha;
      finding({
        section: "prediction", subject: `Overall vs ${name}`, criterion: `CVPAT loss difference (PLS − ${name})`,
        value: diff, threshold: `Diff < 0 with p < ${alpha}`,
        message: `Average loss difference ${f3(diff)} (p = ${f3(p)}): PLS ${better ? "beats" : "does not beat"} the ${name === "LM" ? "linear-model" : "indicator-average"} benchmark${sig ? "" : ", not significantly"}. ${name === "IA" ? "Beating the indicator average establishes predictive validity." : "Beating the linear model is the stronger claim; part of any advantage can be regularisation from compressing many indicators into few composites."}`,
        source: CVPAT_REF,
      });
    }
  }

  // --- congruence ---------------------------------------------------------------
  if (r.congruence && !isStageError(r.congruence)) {
    for (const row of r.congruence.rows) {
      gate({
        section: "congruence", status: row.significant ? "ok" : "warn", subject: row.pair.replace(" -> ", " ↔ "),
        criterion: "Congruence coefficient", value: row.estimate,
        threshold: `bootstrap ${r.congruence.hiLabel} upper bound < ${r.congruence.threshold}`,
        message: row.significant
          ? `Congruence ${f3(row.estimate)}, CI [${f3(row.ciLo)}, ${f3(row.ciHi)}]: the two constructs are empirically distinguishable in the nomological network.`
          : `Congruence ${f3(row.estimate)}, CI [${f3(row.ciLo)}, ${f3(row.ciHi)}] reaches the threshold: redundancy in the nomological network cannot be ruled out.`,
        source: FRANKE,
      });
    }
  }

  return items;
}

/** Gate counts by status, for the verdict strip. */
export function tallyGates(items: AssessmentItem[]): Record<AssessmentStatus, number> {
  const t: Record<AssessmentStatus, number> = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const it of items) if (it.kind === "gate") t[it.status]++;
  return t;
}
