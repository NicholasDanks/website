/**
 * Render an AnalysisResult to HTML. Used both on the page (sections injected
 * into the DOM) and for the downloadable standalone report, so the two never
 * drift. Deliberately free of @seminr/core imports: only types cross over, so
 * the page bundle stays small and the worker owns the numerics.
 *
 * Presentation rules:
 *   - findings first, evidence second, provenance last (inverted pyramid);
 *   - colour (red / amber) is reserved for quality gates that fail or need a
 *     look; a pass gets no colour, and a finding never gets a traffic light;
 *   - weight, not hue, marks findings: an estimate whose interval excludes
 *     zero is bold, one that does not is muted;
 *   - one emphasised number per row; bootstrap mean / SD / t are audit
 *     columns and are muted;
 *   - the threshold sits in the column header, next to the number it judges.
 */

import type { NamedMatrix } from "@seminr/core";
import type { AnalysisResult, ConstructInfo, PredictPower } from "./analyze";
import { isStageError } from "./analyze";
import { needsAction, tallyGates, worthALook, type AssessmentItem, type AssessmentSection } from "./assess";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const fmt = (x: unknown, d = 3): string => {
  if (typeof x !== "number" || !Number.isFinite(x)) return "";
  const t = x.toFixed(d);
  return t === `-${(0).toFixed(d)}` ? (0).toFixed(d) : t;
};

const pfmt = (p: number): string => (!Number.isFinite(p) ? "" : p < 0.001 ? "&lt; 0.001" : p.toFixed(3));
/** "p = 0.027" or "p &lt; 0.001", for running text. */
const pText = (p: number): string => (p < 0.001 ? "p &lt; 0.001" : `p = ${pfmt(p)}`);

function cell(m: NamedMatrix | undefined | null, row: string, col: string): number {
  if (!m) return NaN;
  const i = m.rows.indexOf(row), j = m.cols.indexOf(col);
  return i >= 0 && j >= 0 ? m.values[i][j] : NaN;
}

export interface TableOptions {
  digits?: number;
  /** Header for the row-name column. */
  corner?: string;
  /** Per-cell CSS class. */
  cellClass?: (row: string, col: string, v: number) => string;
  /** Per-column digit override. */
  colDigits?: Record<string, number>;
  /** Drop rows whose cells are all NaN/0. */
  dropEmptyRows?: boolean;
  /** Column header overrides (e.g. to add the threshold). */
  colLabels?: Record<string, string>;
  /** Columns rendered muted (audit statistics). */
  auditCols?: string[];
}

/** A NamedMatrix as an HTML table. */
export function matrixTable(m: NamedMatrix, o: TableOptions = {}): string {
  const d = o.digits ?? 3;
  const rows = o.dropEmptyRows
    ? m.rows.filter((_, i) => m.values[i].some((v) => Number.isFinite(v) && v !== 0))
    : m.rows;
  const audit = new Set(o.auditCols ?? []);
  const head = `<tr><th class="rh">${esc(o.corner ?? "")}</th>${m.cols.map((c) => `<th class="num ${audit.has(c) ? "audit" : ""}">${o.colLabels?.[c] ?? esc(c)}</th>`).join("")}</tr>`;
  const body = rows.map((r) => {
    const i = m.rows.indexOf(r);
    const cells = m.cols.map((c, j) => {
      const v = m.values[i][j];
      const cls = `${o.cellClass?.(r, c, v) ?? ""} ${audit.has(c) ? "audit" : ""}`;
      return `<td class="num ${cls}">${fmt(v, o.colDigits?.[c] ?? d)}</td>`;
    }).join("");
    return `<tr><th class="rh">${esc(r)}</th>${cells}</tr>`;
  }).join("");
  return `<div class="tblwrap"><table class="tbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** Rows of arbitrary cells (already formatted) as an HTML table. */
export function rowsTable(headers: string[], rows: (string | number)[][], o: { numeric?: boolean[]; rowClass?: (i: number) => string; auditCols?: number[]; tableClass?: string } = {}): string {
  const audit = new Set(o.auditCols ?? []);
  const head = `<tr>${headers.map((h, j) => `<th class="${o.numeric?.[j] ? "num" : ""} ${audit.has(j) ? "audit" : ""}">${h}</th>`).join("")}</tr>`;
  const body = rows.map((r, i) =>
    `<tr class="${o.rowClass?.(i) ?? ""}">${r.map((c, j) => {
      const numeric = o.numeric ? o.numeric[j] : typeof c === "number";
      const text = typeof c === "number" ? fmt(c) : c;
      return `<td class="${numeric ? "num" : ""} ${audit.has(j) ? "audit" : ""}">${text}</td>`;
    }).join("")}</tr>`,
  ).join("");
  return `<div class="tblwrap"><table class="tbl ${o.tableClass ?? ""}"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** A NamedMatrix as tab-separated text, for the clipboard. */
export function matrixTsv(m: NamedMatrix, digits = 6): string {
  const lines = [["", ...m.cols].join("\t")];
  m.rows.forEach((r, i) => lines.push([r, ...m.values[i].map((v) => (Number.isFinite(v) ? v.toFixed(digits) : ""))].join("\t")));
  return lines.join("\n");
}

const note = (html: string) => `<p class="note">${html}</p>`;
const h3 = (t: string) => `<h3>${esc(t)}</h3>`;
const h4 = (t: string) => `<h4>${esc(t)}</h4>`;
const details = (summary: string, inner: string, open = false) =>
  `<details${open ? " open" : ""}><summary>${esc(summary)}</summary>${inner}</details>`;
const tsvButton = (key: string, label: string) => `<button type="button" class="copy" data-tsv="${key}">Copy ${esc(label)} as TSV</button>`;

/** β with weight by significance: bold when the CI excludes 0, muted otherwise. */
const est = (v: number, sig: boolean | null): string =>
  sig === null ? fmt(v) : sig ? `<strong class="est">${fmt(v)}</strong>` : `<span class="ns">${fmt(v)}</span>`;

const gateClass = (a: AssessmentItem) => (worthALook(a) ? "gate-adv" : a.status === "fail" ? "gate-fail" : a.status === "warn" ? "gate-warn" : "");

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

export interface ReportSection {
  id: string;
  title: string;
  html: string;
}

export interface RenderContext {
  /** Rendered SVG diagrams, when the page has produced them. */
  svg?: { model?: string; boot?: string };
  /** Registry of matrices exposed to "Copy TSV" buttons. */
  tsv: Record<string, string>;
}

const STATUS_LABEL = { ok: "Pass", warn: "Check", fail: "Problem", info: "Note" } as const;
const SECTION_LABEL: Record<AssessmentSection, string> = {
  data: "Data and estimation",
  reflective: "Reflective measurement",
  formative: "Formative measurement",
  discriminant: "Discriminant validity",
  structural: "Structural model",
  prediction: "Predictive power",
  mediation: "Mediation",
  congruence: "Congruence",
};
const POWER_LABEL: Record<PredictPower, string> = { high: "high", medium: "medium", low: "low", none: "no" };

function assessmentTable(items: AssessmentItem[], withStatus = true): string {
  return rowsTable(
    [withStatus ? "" : "", "Subject", "Criterion", "Value", "Rule", "Assessment"],
    items.map((a) => [
      withStatus && a.kind === "gate" ? (worthALook(a) ? '<span class="badge adv">Worth a look</span>' : `<span class="badge ${a.status}">${STATUS_LABEL[a.status]}</span>`) : "",
      `<span class="nowrap">${esc(a.subject)}</span>`,
      esc(a.criterion),
      a.value === null ? "" : fmt(a.value),
      `<span class="rule">${esc(a.threshold)}</span>`,
      `${esc(a.message)} <span class="src">${esc(a.source)}</span>`,
    ]),
    { numeric: [false, false, false, true, false, false], rowClass: (i) => (items[i].kind === "gate" ? gateClass(items[i]) : ""), tableClass: "tbl-gates" },
  );
}

function constructsTable(cs: ConstructInfo[]): string {
  return rowsTable(
    ["Construct", "Measurement", "Indicators"],
    cs.map((c) => [`<strong>${esc(c.name)}</strong>`, esc(c.label), `<span class="mono">${esc(c.items.join(", "))}</span>`]),
  );
}

export function renderSections(r: AnalysisResult, ctx: RenderContext): ReportSection[] {
  const out: ReportSection[] = [];
  const s = r.summary;
  const boot = r.bootstrap && !isStageError(r.bootstrap) ? r.bootstrap : null;
  const pr = r.predict && !isStageError(r.predict) ? r.predict : null;
  const cv = r.cvpat && !isStageError(r.cvpat) ? r.cvpat : null;
  const med = r.mediation && !isStageError(r.mediation) ? r.mediation : null;
  const cg = r.congruence && !isStageError(r.congruence) ? r.congruence : null;
  const o = r.input.options;
  const alpha = o.bootstrap.alpha;
  const ciLabel = `${(100 * (1 - alpha)).toFixed(0)}% CI`;
  const reg = (key: string, m: NamedMatrix, label: string) => { ctx.tsv[key] = matrixTsv(m); return tsvButton(key, label); };
  const gates = r.assessment.filter((a) => a.kind === "gate");
  const findings = r.assessment.filter((a) => a.kind === "finding");
  const bp = boot?.bootstrappedPaths;
  const pathStat = (from: string, to: string) => {
    const label = `${from}  ->  ${to}`;
    const i = bp ? bp.rows.indexOf(label) : -1;
    if (!bp || i < 0) return null;
    const g = (c: string) => bp.values[i][bp.cols.indexOf(c)];
    const p = g("Bootstrap P Val");
    return { t: g("T Stat."), p, lo: g(bp.cols[4]), hi: g(bp.cols[5]), sig: p < alpha };
  };

  const endogenous = s.paths.cols;
  const sources = new Set(r.model.paths.map((p) => p.from));
  const keyTarget = pr?.keyTarget ?? endogenous.find((c) => !sources.has(c)) ?? endogenous[endogenous.length - 1];

  // =========================================================================
  // 1. Summary: verdict, gate problems, diagram
  // =========================================================================
  {
    const measurementGates = gates.filter((g) => ["data", "reflective", "formative", "discriminant", "congruence"].includes(g.section));
    const mFail = measurementGates.filter((g) => g.status === "fail");
    const mWarn = measurementGates.filter((g) => g.status === "warn" && needsAction(g));
    const mLook = measurementGates.filter(worthALook);
    const listSubjects = (xs: AssessmentItem[], max = 3) => {
      const names = [...new Set(xs.map((x) => `${x.criterion.replace(/ \(.*\)$/, "")} ${x.subject}`))];
      return esc(names.slice(0, max).join("; ")) + (names.length > max ? ` and ${names.length - max} more` : "");
    };
    const lookText = (xs: AssessmentItem[]) => (xs.length ? ` <span class="v-adv">${xs.length} worth a look</span>: ${listSubjects(xs)}.` : "");
    const measurementVerdict = mFail.length
      ? `<strong class="v-fail">${mFail.length} problem${mFail.length === 1 ? "" : "s"}</strong>${mWarn.length ? `, ${mWarn.length} to check` : ""}. ${listSubjects(mFail)}.${lookText(mLook)}`
      : mWarn.length
        ? `<strong class="v-warn">${mWarn.length} to check</strong>. ${listSubjects(mWarn)}.${lookText(mLook)}`
        : `<strong class="v-ok">No action needed.</strong>${mLook.length ? lookText(mLook) : " All gates passed."}`;
    const structuralGates = gates.filter((g) => g.section === "structural");
    const sAct = structuralGates.filter(needsAction);
    const sLook = structuralGates.filter(worthALook);
    const collinearityText = sAct.length
      ? ` <span class="v-warn">${sAct.length} collinearity ${sAct.length === 1 ? "gate" : "gates"} to check</span>: ${listSubjects(sAct)}.`
      : sLook.length ? ` <span class="v-adv">Collinearity worth a look</span> (VIF 3–5): ${esc(sLook.map((g) => g.subject).join(", "))}.` : "";

    const nPaths = r.model.paths.length;
    const supported = r.model.paths.filter((p) => pathStat(p.from, p.to)?.sig).length;
    const r2Key = cell(s.paths, "R^2", keyTarget);
    const structuralVerdict = bp
      ? `<strong>${supported} of ${nPaths}</strong> paths supported at α = ${alpha}. R² of ${esc(keyTarget)} = <strong>${fmt(r2Key)}</strong>${r.model.paths.filter((p) => !pathStat(p.from, p.to)?.sig).length ? `. Not supported: ${esc(r.model.paths.filter((p) => !pathStat(p.from, p.to)?.sig).map((p) => `${p.from} → ${p.to}`).join(", "))}.` : "."}`
      : `${nPaths} paths estimated; R² of ${esc(keyTarget)} = <strong>${fmt(r2Key)}</strong>. Run the bootstrap to test them.`;
    const structuralLine = structuralVerdict + collinearityText;

    let predictionVerdict = "Not run.";
    if (pr) {
      const v = pr.verdicts[pr.keyTarget];
      const lm = cv ? cell(cv.lm, "Overall", "Diff") : NaN;
      const lmP = cv ? cell(cv.lm, "Overall", "Boot P Value") : NaN;
      predictionVerdict = v
        ? `<strong>${POWER_LABEL[v.power].replace(/^./, (c) => c.toUpperCase())} predictive power</strong> for ${esc(pr.keyTarget)}: PLS beats the linear model on ${v.betterThanLm} of ${v.indicators} indicators.${v.worseThanNaive ? ` <span class="v-fail">${v.worseThanNaive} worse than the naive mean.</span>` : ""}${cv && Number.isFinite(lm) ? ` CVPAT vs LM: loss difference ${fmt(lm)}, ${pText(lmP)}.` : ""}`
        : "No endogenous indicators to predict.";
    } else if (r.predict && isStageError(r.predict)) {
      predictionVerdict = `Not available: ${esc(r.predict.error)}`;
    }

    const sectionOrder = (g: AssessmentItem) => ["data", "reflective", "formative", "discriminant", "congruence", "structural", "prediction"].indexOf(g.section);
    const byOrder = (a: AssessmentItem, b: AssessmentItem) => sectionOrder(a) - sectionOrder(b) || (a.status === "fail" ? 0 : 1) - (b.status === "fail" ? 0 : 1);
    const actionGates = gates.filter(needsAction).sort(byOrder);
    const lookGates = gates.filter(worthALook).sort(byOrder);

    const primary = boot && r.model.dotBoot ? "boot" : "model";
    const secondary = primary === "boot" ? "model" : null;
    const diagram = (which: "model" | "boot") =>
      `<div class="diagram" data-diagram="${which}">${ctx.svg?.[which] ?? '<p class="note">Rendering the diagram…</p>'}</div>`;

    out.push({
      id: "summary",
      title: "Summary",
      html: [
        `<div class="verdict">
          <div class="v-row"><span class="v-label">Measurement</span><span class="v-text">${measurementVerdict}</span></div>
          <div class="v-row"><span class="v-label">Structural</span><span class="v-text">${structuralLine}</span></div>
          <div class="v-row"><span class="v-label">Prediction</span><span class="v-text">${predictionVerdict}</span></div>
        </div>`,
        note(`${r.data.nEstimation} cases · ${r.model.constructs.length} constructs · ${nPaths} paths · ${boot ? `${boot.nboot} bootstrap resamples, percentile ${ciLabel}` : "no bootstrap"}${pr ? ` · PLSpredict ${pr.noFolds}-fold` : ""}${cg ? " · congruence test" : ""}. Full run details at the end.`),
        actionGates.length ? h3("Quality gates that need action") : "",
        actionGates.length ? assessmentTable(actionGates) : "",
        actionGates.length ? note("Measurement problems come first because the structural results below assume the constructs measure what they claim. Fix or justify these before reading further.") : "",
        lookGates.length ? details(`${lookGates.length} ${lookGates.length === 1 ? "check" : "checks"} worth a look — no action required`, assessmentTable(lookGates) + note("Each of these is within the rules; its assessment says why it is listed. Mention them where a reviewer would expect it, but nothing needs fixing.")) : "",
        h3(primary === "boot" ? "Model with bootstrap significance" : "Estimated model"),
        diagram(primary),
        primary === "boot" ? note("Path coefficients with bootstrap t-values and p-values, as seminr's <code>plot(boot_model)</code>. Stars: *** p &lt; 0.001, ** p &lt; 0.01, * p &lt; 0.05.") : note("Outer weights and loadings with path coefficients, as seminr's <code>plot(model)</code>."),
        secondary ? details("Estimated model without bootstrap statistics", diagram(secondary)) : "",
      ].join(""),
    });
  }

  // =========================================================================
  // 2. Structural model: findings
  // =========================================================================
  {
    const rows = r.model.paths.map((p) => {
      const b = cell(s.paths, p.from, p.to);
      const f2 = cell(s.fSquare, p.from, p.to);
      const st = pathStat(p.from, p.to);
      const size = Number.isFinite(f2) ? (f2 >= 0.35 ? "large" : f2 >= 0.15 ? "medium" : f2 >= 0.02 ? "small" : "negligible") : "";
      const cols: (string | number)[] = [`<span class="nowrap">${esc(p.from)} → ${esc(p.to)}</span>`, est(b, st ? st.sig : null)];
      if (st) cols.push(fmt(st.t, 2), pfmt(st.p), `<span class="nowrap">[${fmt(st.lo)}, ${fmt(st.hi)}]</span>`);
      cols.push(`${fmt(f2)}${size ? ` <span class="rule">${size}</span>` : ""}`);
      if (st) cols.push(st.sig ? "Supported" : `<span class="ns">Not supported</span>`);
      return cols;
    });
    const headers = ["Path", "β", ...(bp ? ["t", "p", ciLabel] : []), "f²", ...(bp ? ["Decision"] : [])];
    const numeric = [false, true, ...(bp ? [true, true, false] : []), true, ...(bp ? [false] : [])];

    const r2Rows = endogenous.map((dv) => {
      const r2 = cell(s.paths, "R^2", dv);
      const adj = cell(s.paths, "AdjR^2", dv);
      const q2 = pr ? Object.entries(pr.q2Predict).filter(([it]) => pr.itemConstruct[it] === dv).map(([, v]) => v) : [];
      const label = r2 >= 0.75 ? "substantial" : r2 >= 0.5 ? "moderate" : r2 >= 0.25 ? "weak" : "low";
      return [`<strong>${esc(dv)}</strong>${dv === keyTarget ? ' <span class="rule">key target</span>' : ""}`, r2, adj, `<span class="rule">${label}</span>`, q2.length ? (fmt(Math.min(...q2)) === fmt(Math.max(...q2)) ? fmt(q2[0]) : `${fmt(Math.min(...q2))} – ${fmt(Math.max(...q2))}`) : ""];
    });

    const vifRows = Object.entries(s.vifAntecedents).flatMap(([dv, ants]) => Object.entries(ants).map(([iv, v]) => [`<span class="nowrap">${esc(iv)} → ${esc(dv)}</span>`, v]));
    const vifGate = (v: number) => (v >= 5 ? "gate-fail" : v >= 3 ? "gate-adv" : "");

    ctx.tsv.paths = matrixTsv(s.paths);
    ctx.tsv.fSquare = matrixTsv(s.fSquare);
    if (bp) ctx.tsv.bootPaths = matrixTsv(bp);

    // mediation
    let mediationHtml = "";
    if (med && med.specific.length) {
      const sigChains = med.specific.filter((e) => e.bootstrapP < alpha);
      const upsLabel = (u: number) => (!Number.isFinite(u) ? "" : u >= 0.09 ? "large" : u >= 0.04 ? "medium" : u >= 0.01 ? "small" : "negligible");
      const medRows = (xs: typeof med.specific) => xs.map((e) => [
        `<span class="nowrap">${esc(e.path)}</span>`, est(e.originalEst, e.bootstrapP < alpha), pfmt(e.bootstrapP), `<span class="nowrap">[${fmt(e.ciLower)}, ${fmt(e.ciUpper)}]</span>`,
        `${fmt(e.upsilon)} <span class="rule">${upsLabel(e.upsilon)}</span>`,
        Number.isFinite(e.directEst) ? est(e.directEst, e.directP < alpha) : '<span class="rule">not in model</span>', Number.isFinite(e.directP) ? pfmt(e.directP) : "",
        /not in model|no effect/.test(e.type) ? `<span class="ns">${e.type}</span>` : e.type,
      ]);
      const medHeaders = ["Indirect path", "Indirect effect", "p", ciLabel, "υ <span class='rule'>0.01 / 0.04 / 0.09</span>", "Direct effect", "p", "Mediation type"];
      mediationHtml = [
        h3("Mediation"),
        sigChains.length
          ? rowsTable(medHeaders, medRows(sigChains), { numeric: [false, true, true, false, true, true, true, false] })
          : note("No specific indirect effect is significant at α = " + alpha + "."),
        note(`Every chain the structural model contains was tested by bootstrapping the product of its path coefficients; ${sigChains.length} of ${med.specific.length} are significant and shown above. υ is the product of the squared path coefficients (Ch. 8.2; 0.01 small, 0.04 medium, 0.09 large). Types follow Zhao, Lynch &amp; Chen (2010) and are only assigned when the competing direct path is in the model; otherwise the row says so, because full vs partial mediation cannot be judged without it.`),
        med.specific.length > sigChains.length ? details(`All ${med.specific.length} indirect paths`, rowsTable(medHeaders, medRows(med.specific), { numeric: [false, true, true, false, true, true, true, false] })) : "",
        r.moderatedMediation && r.moderatedMediation.length ? h4("Index of moderated mediation (Ch. 8.3)") : "",
        r.moderatedMediation && r.moderatedMediation.length ? rowsTable(["Antecedent → mediator × moderator → outcome", "Index (p1 × p5)", ciLabel, "p"], r.moderatedMediation.map((m) => [`<span class="nowrap">${esc(m.antecedent)} → ${esc(m.mediator)} × ${esc(m.moderator)} → ${esc(m.outcome)}</span>`, est(m.index, m.p < alpha), `<span class="nowrap">[${fmt(m.ciLower)}, ${fmt(m.ciUpper)}]</span>`, pfmt(m.p)]), { numeric: [false, true, false, true] }) : "",
        r.moderatedMediation && r.moderatedMediation.length ? note("The product of the antecedent → mediator path and the interaction → outcome path, bootstrapped: a significant index means the indirect effect depends on the moderator (Hayes, 2015).") : "",
      ].join("");
    }
    const slopesHtml = r.slopes.length
      ? [h3("Moderation: simple slopes (Ch. 7.2)"), ...r.slopes.map((sp) => `<h4>${esc(sp.iv)} → ${esc(sp.dv)} at −1 SD, mean and +1 SD of ${esc(sp.moderator)}</h4><div class="diagram">${sp.svg}</div>`), note("The interaction term's path coefficient and f² are in the table above; the plot shows how the slope of the focal relationship changes with the moderator, as seminr's <code>slope_analysis()</code>.")].join("")
      : "";

    out.push({
      id: "structural",
      title: "Structural model",
      html: [
        h3("Path coefficients"),
        rowsTable(headers, rows, { numeric }),
        bp ? reg("bootPaths", bp, "path coefficients") : tsvButton("paths", "path coefficients"),
        bp
          ? note(`Standardised coefficients with percentile bootstrap intervals from ${boot!.nboot} resamples (two-tailed, α = ${alpha}). Bold: the interval excludes zero. f²: 0.02 small, 0.15 medium, 0.35 large (Cohen, 1988). A supported path with |β| below 0.10 is statistically real but practically trivial.`)
          : note("Point estimates only. Run the bootstrap for t-values, p-values and intervals."),
        h3("Explained variance"),
        rowsTable(["Endogenous construct", "R²", "Adjusted R²", "Rule of thumb", pr ? "Q²predict (indicator range)" : ""].filter((h) => h !== ""), r2Rows.map((row) => (pr ? row : row.slice(0, 4))), { numeric: [false, true, true, false, false] }),
        note("R² rules of thumb (0.25 weak, 0.50 moderate, 0.75 substantial) are field-dependent; in consumer research 0.20 can be high. Q²predict comes from PLSpredict below."),
        h3("Collinearity of predictors"),
        rowsTable(["Predictor → outcome", "VIF <span class='rule'>&lt; 3 ideal, &lt; 5 max</span>"], vifRows, { rowClass: (i) => vifGate(Number(vifRows[i][1])) }),
        slopesHtml,
        mediationHtml,
        boot ? details("Total effects (direct + indirect)", matrixTable(boot.bootstrappedTotalPaths, { corner: "Path", auditCols: ["Bootstrap Mean", "Bootstrap SD", "T Stat."], colDigits: { "Bootstrap P Val": 3, "T Stat.": 2 } }) + reg("bootTotal", boot.bootstrappedTotalPaths, "total effects")) : details("Total effects (point estimates)", matrixTable(s.totalEffects, { corner: "", dropEmptyRows: true })),
        details("f² matrix", matrixTable(s.fSquare, { corner: "", dropEmptyRows: true }) + tsvButton("fSquare", "f²")),
        details("Information criteria (AIC, BIC per endogenous construct)", matrixTable(s.itCriteria, { corner: "" }) + note("For comparing competing models on the same data; lower is better. Use BIC or GM for model selection, not R².")),
      ].join(""),
    });
  }

  // =========================================================================
  // 3. Measurement model: gates as evidence
  // =========================================================================
  {
    const reflective = r.model.constructs.filter((c) => c.class === "reflective" || c.class === "single-item" || (c.class === "higher-order" && !/mode B/.test(c.label)));
    const formative = r.model.constructs.filter((c) => c.class === "formative" || c.class === "unit-weights" || (c.class === "higher-order" && /mode B/.test(c.label)));
    const rel = (c: string, stat: string) => cell(s.reliability, c, stat);
    const relClass = (v: number, stat: string) => stat === "AVE" ? (v < 0.5 ? "gate-fail" : "") : (v < 0.6 ? "gate-fail" : v < 0.7 || v > 0.95 ? "gate-warn" : "");

    // Table 1: reflective
    const refRows: (string | number)[][] = [];
    const refRowClass: string[] = [];
    for (const c of reflective) {
      c.items.forEach((it, k) => {
        const l = cell(s.loadings, it, c.name);
        const first = k === 0;
        const multi = c.items.length > 1;
        const lc = Math.abs(l) < 0.4 ? "gate-fail" : Math.abs(l) < 0.708 ? "gate-warn" : "";
        const stat = (name: string) => (first && multi ? `<span class="${relClass(rel(c.name, name), name)}">${fmt(rel(c.name, name))}</span>` : "");
        refRows.push([
          first ? `<strong>${esc(c.name)}</strong>${multi ? "" : ' <span class="rule">single item</span>'}` : "",
          `<span class="mono">${esc(it)}</span>`,
          `<span class="${lc}">${fmt(l)}</span>`,
          fmt(l * l),
          stat("alpha"), stat("rhoA"), stat("rhoC"), stat("AVE"),
          first && c.epistemicRho !== undefined ? `<span class="${c.epistemicRho < 0.7 ? "gate-warn" : ""}">${fmt(c.epistemicRho)}</span>` : "",
        ]);
        refRowClass.push(lc);
      });
    }
    const refTable = refRows.length
      ? rowsTable(
          ["Construct", "Indicator", "Loading <span class='rule'>≥ 0.708</span>", "λ² <span class='rule'>≥ 0.50</span>", "α <span class='rule'>0.70–0.95</span>", "ρ<sub>A</sub> <span class='rule'>0.70–0.95</span>", "ρ<sub>C</sub> <span class='rule'>0.70–0.95</span>", "AVE <span class='rule'>≥ 0.50</span>", "ρ<sub>ε</sub> <span class='rule'>≥ 0.70</span>"],
          refRows,
          { numeric: [false, false, true, true, true, true, true, true, true], rowClass: (i) => refRowClass[i] },
        )
      : "";

    // Table 3: formative
    const bw = boot?.bootstrappedWeights ?? null;
    const forRows: (string | number)[][] = [];
    const forRowClass: string[] = [];
    for (const c of formative) {
      c.items.forEach((it, k) => {
        const w = cell(s.weights, it, c.name);
        const l = cell(s.loadings, it, c.name);
        const vif = s.validity.vifItems[c.name]?.[it] ?? NaN;
        const label = `${it}  ->  ${c.name}`;
        const p = bw ? cell(bw, label, "Bootstrap P Val") : NaN;
        const sig = bw ? p < alpha : null;
        const keep = sig === true ? "" : sig === false ? (Math.abs(l) >= 0.5 ? "gate-adv" : "gate-fail") : "";
        const vc = vif >= 5 ? "gate-fail" : vif >= 3 ? "gate-adv" : "";
        const row: (string | number)[] = [
          k === 0 ? `<strong>${esc(c.name)}</strong>` : "",
          `<span class="mono">${esc(it)}</span>`,
          est(w, sig),
        ];
        if (bw) row.push(fmt(cell(bw, label, "T Stat."), 2), pfmt(p), `<span class="nowrap">[${fmt(cell(bw, label, bw.cols[4]))}, ${fmt(cell(bw, label, bw.cols[5]))}]</span>`);
        row.push(`<span class="${sig === false && Math.abs(l) < 0.5 ? "gate-fail" : ""}">${fmt(l)}</span>`, `<span class="${vc}">${fmt(vif)}</span>`, k === 0 && c.epistemicRho !== undefined ? `<span class="${c.epistemicRho < 0.7 ? "gate-fail" : ""}">${fmt(c.epistemicRho)}</span>` : "");
        forRows.push(row);
        forRowClass.push(keep || vc);
      });
    }
    const forHeaders = ["Construct", "Indicator", "Weight", ...(bw ? ["t", "p <span class='rule'>&lt; " + alpha + "</span>", ciLabel] : []), "Loading <span class='rule'>≥ 0.50 if weight n.s.</span>", "VIF <span class='rule'>&lt; 3 ideal, &lt; 5 max</span>", "ρ<sub>ε</sub> <span class='rule'>≥ 0.70</span>"];
    const forTable = forRows.length ? rowsTable(forHeaders, forRows, { numeric: [false, false, true, ...(bw ? [true, true, false] : []), true, true, true], rowClass: (i) => forRowClass[i] }) : "";

    // HTMT
    const htmtM = s.validity.htmt;
    const bh = boot?.bootstrappedHtmt90 ?? boot?.bootstrappedHtmt ?? null;
    const reflectiveNames = new Set(r.model.constructs.filter((c) => c.class === "reflective" && c.items.length > 1).map((c) => c.name));
    const htmtPairs = bh
      ? bh.rows.filter((label) => label.split("  ->  ").every((n) => reflectiveNames.has(n))).map((label) => {
          const v = cell(bh, label, "Original Est.");
          const hi = cell(bh, label, bh.cols[5]);
          const cls = hi >= 1 ? "gate-fail" : v >= 0.9 ? "gate-fail" : v >= 0.85 || hi >= 0.9 ? "gate-warn" : "";
          return { row: [`<span class="nowrap">${esc(label.replace("  ->  ", " ↔ "))}</span>`, `<span class="${cls}">${fmt(v)}</span>`, `<span class="nowrap ${hi >= 0.9 ? "gate-warn" : ""}">[${fmt(cell(bh, label, bh.cols[4]))}, ${fmt(hi)}]</span>`], cls };
        })
      : [];

    ctx.tsv.reliability = matrixTsv(s.reliability);
    ctx.tsv.loadings = matrixTsv(s.loadings);
    ctx.tsv.weights = matrixTsv(s.weights);

    const measurementGates = gates.filter((g) => ["reflective", "formative", "discriminant", "congruence"].includes(g.section));
    const measurementGateProblems = measurementGates.filter(needsAction);
    const measurementLook = measurementGates.filter(worthALook);

    out.push({
      id: "measurement",
      title: "Measurement model",
      html: [
        measurementGateProblems.length === 0
          ? note(`<strong>No measurement gate needs action.</strong>${measurementLook.length ? ` ${measurementLook.length} ${measurementLook.length === 1 ? "is" : "are"} worth a look (shaded blue below).` : ""} The tables below are the evidence.`)
          : note(`${measurementGateProblems.length} gate${measurementGateProblems.length === 1 ? " needs" : "s need"} action; ${measurementGateProblems.length === 1 ? "it is" : "they are"} highlighted in the tables below and listed in the summary.${measurementLook.length ? ` ${measurementLook.length} more ${measurementLook.length === 1 ? "is" : "are"} worth a look (shaded blue).` : ""}`),
        refTable ? h3("Reflective and mode A constructs") : "",
        refTable,
        refTable ? tsvButton("reliability", "reliability") + tsvButton("loadings", "loadings") : "",
        r.unidimensionality.length ? h4("Unidimensionality (Ch. 4.2)") : "",
        r.unidimensionality.length ? rowsTable(
          ["Construct", "Eigenvalues (PC1, PC2, …)", "Adjusted by parallel analysis <span class='rule'>only PC1 &gt; 1</span>", "Revelle's β", "α", "Verdict"],
          r.unidimensionality.map((u) => [`<strong>${esc(u.construct)}</strong>`, u.eigenvalues.map((e) => fmt(e, 2)).join(", "), u.adjustedEigenvalues.map((e) => fmt(e, 2)).join(", "), u.revelleBeta === null ? "" : fmt(u.revelleBeta, 2), fmt(u.alpha, 2), u.unidimensional ? "one dimension" : `<span class="gate-warn">${u.adjustedEigenvalues.filter((e) => e > 1).length} dimensions</span>`]),
          { numeric: [false, false, false, true, true, false], rowClass: (i) => (r.unidimensionality[i].unidimensional ? "" : "gate-warn") },
        ) : "",
        r.unidimensionality.length ? note("Horn's parallel analysis (95th centile, 500 random datasets) subtracts the eigenvalue bias expected from noise; a construct is unidimensional when only the first adjusted eigenvalue exceeds 1. Revelle's β is the worst split-half reliability over every split (psych's definition, as the book's iclust call) and should sit close to α; a β far below α suggests the items form more than one cluster.") : "",
        refTable ? note("Loadings at or above 0.708 give indicator reliability of at least 0.50. Reliability (α, ρ<sub>A</sub>, ρ<sub>C</sub>) should fall between 0.70 and 0.95; above 0.95 the indicators are redundant. AVE at or above 0.50 establishes convergent validity. ρ<sub>ε</sub> is the correlation of the construct score with the first principal component of its own indicators; below 0.70 the inner weighting has displaced the score (interpretational confounding). Single-item constructs have no reliability statistics by construction.") : "",
        forTable ? h3("Formative and unit-weight constructs") : "",
        forTable,
        forTable ? tsvButton("weights", "weights") : "",
        formative.length ? h4("Convergent validity: redundancy analysis (Ch. 5.3.1)") : "",
        formative.length ? (r.redundancy.length
          ? rowsTable(["Construct", "Global item", "Path <span class='rule'>≥ 0.70</span>", "R² <span class='rule'>≥ 0.50</span>"], r.redundancy.map((x) => [`<strong>${esc(x.construct)}</strong>`, `<span class="mono">${esc(x.globalItem)}</span>`, `<span class="${x.path < 0.7 ? "gate-fail" : ""}">${fmt(x.path)}</span>`, fmt(x.rSquared)]), { numeric: [false, false, true, true], rowClass: (i) => (r.redundancy[i].path < 0.7 ? "gate-fail" : "") })
          : note(`No global single-item measure was found for ${formative.map((c) => c.name).join(", ")}. Name one <code>construct_global</code> (as the textbook's <code>qual_global</code>) and the redundancy analysis runs automatically.`)) : "",
        formative.length && r.redundancy.length && r.redundancy.length < formative.length ? note(`No global item found for ${formative.filter((c) => !r.redundancy.some((x) => x.construct === c.name)).map((c) => c.name).join(", ")}.`) : "",
        forTable ? note("Read the weight's significance first. A non-significant weight with a loading of 0.50 or more still marks an absolutely important indicator (keep it); below 0.50, removal needs a content-validity argument. VIF above 5 destabilises the weights. ρ<sub>ε</sub> is the only reliability diagnostic available for a mode B composite. Convergent validity (redundancy analysis against a global item) cannot be assessed without that extra item.") : "",
        boot ? details("Bootstrapped loadings", matrixTable(boot.bootstrappedLoadings, { corner: "Indicator → construct", auditCols: ["Bootstrap Mean", "Bootstrap SD", "T Stat."], colDigits: { "Bootstrap P Val": 3, "T Stat.": 2 } })) : "",
        details("Cross-loadings", matrixTable(s.validity.crossLoadings, { corner: "Indicator" }) + reg("crossLoadings", s.validity.crossLoadings, "cross-loadings") + note("Each indicator should load highest on its own construct.")),

        h3("Discriminant validity (HTMT)"),
        matrixTable(htmtM, { corner: "", cellClass: (rn, cn, v) => (!(reflectiveNames.has(rn) && reflectiveNames.has(cn)) ? "ns" : v >= 0.9 ? "gate-fail" : v >= 0.85 ? "gate-warn" : "") }),
        reg("htmt", htmtM, "HTMT"),
        `<p class="note legend"><span class="sw gate-warn"></span> 0.85 – 0.90: acceptable only for conceptually similar constructs &nbsp; <span class="sw gate-fail"></span> ≥ 0.90: discriminant validity in doubt. Grey values involve a formative, single-item or interaction construct: shown for reference, not assessed.</p>`,
        htmtPairs.length ? `<h4>HTMT inference for reflective pairs (bootstrap, <span class="nocase">α</span> = 0.10)</h4>` : "",
        htmtPairs.length ? rowsTable(["Pair", "HTMT <span class='rule'>&lt; 0.85 / 0.90</span>", "90% interval <span class='rule'>95% one-sided upper bound below the threshold</span>"], htmtPairs.map((x) => x.row), { numeric: [false, true, false], rowClass: (i) => htmtPairs[i].cls }) : "",
        htmtPairs.length ? reg("bootHtmt", bh!, "HTMT intervals") : "",
        htmtPairs.length ? note("As in the textbook (Ch. 4.6), the bootstrap summary for HTMT uses α = 0.10, so the upper bound is the 95% one-sided limit that should stay below the threshold (Ringle et al., 2023). Only pairs of reflective multi-item constructs are tested; HTMT is undefined for formative and single-item constructs. The engine computes the original HTMT; HTMT2 (Roemer, Schuberth &amp; Henseler, 2021), the criterion for unequal loadings, is not available here.") : "",
        details("Fornell–Larcker criterion", matrixTable(s.validity.flCriteria, { corner: "" }) + reg("flCriteria", s.validity.flCriteria, "Fornell–Larcker") + note("Square roots of AVE on the diagonal, construct correlations below it. Legacy criterion; rely on HTMT.")),

        cg ? h3("Congruence in the nomological network") : "",
        cg ? (() => {
          const rows = cg.rows.map((row, i) => [
            `<span class="nowrap">${esc(row.pair.replace(" -> ", " ↔ "))}</span>`, row.estimate, `<span class="nowrap">[${fmt(row.ciLo)}, ${fmt(row.ciHi)}]</span>`,
            row.significant ? "Distinguishable" : `<span class="gate-warn">Not distinguishable</span>`,
            cg.htmtRows ? cg.htmtRows[i].estimate : "", row.bootSD, row.tStat ?? NaN,
          ]);
          const nonSig = cg.rows.filter((x) => !x.significant).length;
          ctx.tsv.congruence = ["pair\testimate\tdiff\tboot_sd\tt\tci_lo\tci_hi\tsignificant\thtmt_based", ...cg.rows.map((row, i) => [row.pair, row.estimate, row.diff, row.bootSD, row.tStat ?? "", row.ciLo, row.ciHi, row.significant, cg.htmtRows?.[i].estimate ?? ""].join("\t"))].join("\n");
          return [
            rowsTable(["Pair", `Congruence <span class='rule'>&lt; ${cg.threshold}</span>`, `${cg.loLabel.replace(" CI", "")}–${cg.hiLabel}`, "Verdict", "HTMT-based (point est.)", "Boot SD", "t"], rows, { numeric: [false, true, false, false, true, true, true], rowClass: (i) => (cg.rows[i].significant ? "" : "gate-warn"), auditCols: [5, 6] }),
            tsvButton("congruence", "congruence test"),
            note(`${cg.rows.length} pairs, ${cg.nboot} resamples, ${cg.diagonal === "rhoA" ? "ρ<sub>A</sub>" : "ρ<sub>C</sub>"} on the diagonal. ${nonSig === 0 ? "Every pair is empirically distinguishable." : `${nonSig} pair${nonSig === 1 ? "" : "s"} cannot be distinguished from the threshold: redundancy in the nomological network cannot be ruled out.`} A pair is distinguishable when the whole interval lies below the threshold (Franke, Sarstedt &amp; Danks, 2021). The HTMT-based column is congruence over the disattenuated HTMT matrix, a point estimate for comparison rather than a second test.`),
          ].join("");
        })() : "",
        r.congruence && isStageError(r.congruence) ? `<div class="callout">The congruence test could not run: ${esc(r.congruence.error)}</div>` : "",
      ].join(""),
    });
  }

  // =========================================================================
  // 4. Prediction
  // =========================================================================
  {
    const html: string[] = [];
    if (pr) {
      const items = pr.plsOutOfSample.cols;
      const rmse = (m: NamedMatrix, it: string) => cell(m, "RMSE", it);
      const mae = (m: NamedMatrix, it: string) => cell(m, "MAE", it);
      const verdictRows = Object.values(pr.verdicts).map((v) => [
        `<strong>${esc(v.construct)}</strong>${v.construct === pr.keyTarget ? ' <span class="rule">key target</span>' : ""}`,
        `${v.betterThanLm} of ${v.indicators}`,
        v.worseThanNaive ? `<span class="gate-fail">${v.worseThanNaive}</span>` : "0",
        `<strong>${POWER_LABEL[v.power]}</strong>`,
      ]);
      const rows = items.map((it) => {
        const pls = rmse(pr.plsOutOfSample, it), lm = rmse(pr.lmOutOfSample, it), naive = pr.naiveRmse[it];
        return {
          row: [
            esc(pr.itemConstruct[it] ?? ""), `<span class="mono">${esc(it)}</span>`,
            pls < lm ? `<strong class="est">${fmt(pls)}</strong>` : fmt(pls), fmt(lm), `<span class="${pls > naive ? "gate-fail" : ""}">${fmt(naive)}</span>`,
            `<span class="${(pr.q2Predict[it] ?? 0) <= 0 ? "gate-fail" : ""}">${fmt(pr.q2Predict[it])}</span>`,
            mae(pr.plsOutOfSample, it), mae(pr.lmOutOfSample, it),
          ],
          cls: pls > naive ? "gate-fail" : "",
        };
      });
      html.push(
        h3("PLSpredict"),
        rowsTable(["Endogenous construct", "Indicators where PLS RMSE &lt; LM RMSE", "Indicators worse than the naive mean", "Predictive power"], verdictRows, { numeric: [false, false, false, false] }),
        note(`${pr.noFolds}-fold cross-validation, ${pr.technique === "predict_DA" ? "direct" : "earliest"} antecedents scheme, seed ${pr.seed}. Verdict rule (Shmueli et al., 2019): PLS below the linear-model benchmark on all indicators → high; the majority → medium; a minority → low; none → no predictive power. Judge the model on its key target construct, not on every construct at once.`),
        rowsTable(["Construct", "Indicator", "PLS RMSE", "LM RMSE", "Naive RMSE", "Q²predict <span class='rule'>&gt; 0</span>", "PLS MAE", "LM MAE"], rows.map((x) => x.row), { numeric: [false, false, true, true, true, true, true, true], rowClass: (i) => rows[i].cls, auditCols: [6, 7] }),
        tsvButton("plsPredict", "PLSpredict"),
        note("Bold PLS RMSE: lower than the linear-model benchmark. Naive RMSE predicts each indicator by its whole-sample mean; a PLS RMSE above it means the model predicts that indicator worse than its average. Q²predict is 1 − PLS MSE / naive MSE against the same benchmark, slightly stricter than the fold-wise mean SmartPLS uses."),
        details("Construct-level prediction error", matrixTable(pr.constructError, { corner: "" }) + note("In-sample (IS) and out-of-sample (OOS) MSE/MAE of the construct scores; the overfit ratio compares the two.")),
      );
      ctx.tsv.plsPredict = ["construct\tindicator\tPLS_RMSE\tLM_RMSE\tnaive_RMSE\tQ2predict\tPLS_MAE\tLM_MAE", ...items.map((it) => [pr.itemConstruct[it], it, rmse(pr.plsOutOfSample, it), rmse(pr.lmOutOfSample, it), pr.naiveRmse[it], pr.q2Predict[it], mae(pr.plsOutOfSample, it), mae(pr.lmOutOfSample, it)].map((v) => (typeof v === "number" ? v.toFixed(6) : v)).join("\t"))].join("\n");
    } else if (r.predict && isStageError(r.predict)) {
      html.push(`<div class="callout">PLSpredict could not run: ${esc(r.predict.error)}</div>`);
    }
    if (cv) {
      const cvTable = (m: NamedMatrix, bench: string) => rowsTable(
        ["Construct", "PLS loss", `${bench} loss`, "Difference <span class='rule'>&lt; 0 favours PLS</span>", "t", `p <span class='rule'>&lt; ${alpha}</span>`],
        m.rows.map((row) => {
          const d = cell(m, row, "Diff");
          return [row === "Overall" ? "<strong>Overall</strong>" : esc(row), fmt(cell(m, row, m.cols[0])), fmt(cell(m, row, m.cols[1])), d < 0 ? `<strong class="est">${fmt(d)}</strong>` : `<span class="ns">${fmt(d)}</span>`, fmt(cell(m, row, "Boot T value"), 2), pfmt(cell(m, row, "Boot P Value"))];
        }),
        { numeric: [false, true, true, true, true, true], auditCols: [4] },
      );
      ctx.tsv.cvpatIa = matrixTsv(cv.ia);
      html.push(
        h3("CVPAT"),
        h4("Against the indicator average"),
        cvTable(cv.ia, "Indicator average"),
        tsvButton("cvpatIa", "CVPAT vs indicator average"),
        h4("Against the linear model"),
        cvTable(cv.lm, "Linear model"),
        note(`Cross-validated predictive ability test, ${cv.nboot} bootstrap resamples. A negative difference means PLS has the lower average loss; the p-value tests it. Beating the indicator average establishes predictive validity (the floor); beating the linear model is the stronger claim, and part of any advantage there can be regularisation from compressing many indicators into few composites (Liengaard et al., 2021; Sharma et al., 2023).`),
      );
      ctx.tsv.cvpatLm = matrixTsv(cv.lm);
      html.push(tsvButton("cvpatLm", "CVPAT vs linear model"));
    } else if (r.cvpat && isStageError(r.cvpat)) {
      html.push(`<div class="callout">CVPAT could not run: ${esc(r.cvpat.error)}</div>`);
    }
    if (html.length) out.push({ id: "prediction", title: "Predictive power", html: html.join("") });
  }

  // =========================================================================
  // 5. Descriptives
  // =========================================================================
  {
    const d = s.descriptives;
    ctx.tsv.itemStats = matrixTsv(d.statistics.items);
    ctx.tsv.constructCor = matrixTsv(d.correlations.constructs);
    out.push({
      id: "descriptives",
      title: "Descriptives",
      html: [
        h3("Construct correlations"),
        matrixTable(d.correlations.constructs, { corner: "" }),
        tsvButton("constructCor", "construct correlations"),
        details("Construct score statistics", matrixTable(d.statistics.constructs, { corner: "" })),
        details("Indicator statistics", matrixTable(d.statistics.items, { corner: "Indicator", colDigits: { "No.": 0, Missing: 0 } }) + tsvButton("itemStats", "indicator statistics")),
        details("Indicator correlations", matrixTable(d.correlations.items, { corner: "" })),
      ].join(""),
    });
  }

  // =========================================================================
  // 6. Run details, every check, reproduce
  // =========================================================================
  {
    const tally = tallyGates(r.assessment);
    const facts = rowsTable(
      ["", ""],
      [
        ["Data", `${r.input.dataName}: ${r.data.n} cases, ${r.data.columns} columns; ${r.data.nEstimation} cases used for estimation`],
        ["Missing data", `${o.estimation.missing === "na_omit" ? "listwise deletion" : "mean replacement"}${o.estimation.missingValue !== undefined ? `, marker ${o.estimation.missingValue}` : ""}`],
        ["Estimation", `${o.estimation.innerWeights.replace("_", " ")} scheme, ${r.model.iterations} iterations`],
        ["Bootstrap", boot ? `${boot.nboot} resamples, seed ${boot.seed}, alpha ${boot.alpha}, percentile intervals${boot.fails ? `, ${boot.fails} failed resamples` : ""}` : "not run"],
        ["PLSpredict", pr ? `${pr.noFolds}-fold, ${pr.technique.replace("predict_", "")} scheme, seed ${pr.seed}, key target ${pr.keyTarget}` : "not run"],
        ["CVPAT", cv ? `${cv.nboot} resamples` : "not run"],
        ["Congruence test", cg ? `${cg.nboot} resamples, ${cg.diagonal === "rhoA" ? "rho_A" : "rho_C"} diagonal, threshold ${cg.threshold}, alpha ${cg.alpha}` : "not run"],
        ["Engine", `seminr-ts ${r.engine.core}, seminrExtras-ts ${r.engine.extras}, app ${r.engine.app}`],
        ["Generated", new Date(r.generatedAt).toLocaleString()],
      ].map(([k, v]) => [`<strong>${esc(k)}</strong>`, esc(v)]),
    );
    const bySection = (items: AssessmentItem[]) =>
      (Object.keys(SECTION_LABEL) as AssessmentSection[])
        .map((sec) => ({ sec, items: items.filter((a) => a.section === sec) }))
        .filter((g) => g.items.length)
        .map((g) => `<h4>${esc(SECTION_LABEL[g.sec])}</h4>${assessmentTable(g.items)}`)
        .join("");
    const warnings = r.model.warnings.filter((w) => !/observations are valid/.test(w));

    out.push({
      id: "details",
      title: "Run details and reproduction",
      html: [
        facts,
        warnings.length ? `<div class="callout">${warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div>` : "",
        h3("Constructs"),
        constructsTable(r.model.constructs),
        details(`All ${gates.length} quality gates (${tally.fail} problems, ${tally.warn} to check, ${tally.advisory} worth a look, ${tally.ok} passed, ${tally.info} notes)`, bySection(gates)),
        details(`All ${findings.length} findings in words`, bySection(findings)),
        h3("Reproduce in R"),
        note("The same model and options with seminr and seminrExtras. Point <code>read.csv()</code> at your file."),
        `<pre class="code"><code>${esc(r.rScript)}</code></pre>`,
        details("Model code as pasted", `<pre class="code"><code>${esc(r.input.code)}</code></pre>`),
      ].join(""),
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// standalone report
// ---------------------------------------------------------------------------

export const REPORT_CSS = `
.report{--fg:#18181b;--muted:#52525b;--line:#e4e4e7;--bg:#fff;--head:#f4f4f5;--ok:#047857;--okbg:#ecfdf5;--warn:#b45309;--warnbg:#fffbeb;--fail:#b91c1c;--failbg:#fef2f2;--info:#3f3f46;--infobg:#f4f4f5;--accent:#c2410c;--adv:#1d4ed8;--advbg:#eff6ff;color:var(--fg);font-size:14px;line-height:1.5}
.dark .report{--fg:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--bg:#18181b;--head:#27272a;--ok:#6ee7b7;--okbg:#064e3b55;--warn:#fcd34d;--warnbg:#78350f55;--fail:#fca5a5;--failbg:#7f1d1d55;--info:#d4d4d8;--infobg:#27272a;--accent:#fb923c;--adv:#93c5fd;--advbg:#1e3a8a44}
.report h2{font-size:1.35rem;font-weight:700;margin:2.5rem 0 1rem;padding-top:1rem;border-top:1px solid var(--line)}
.report h3{font-size:1.05rem;font-weight:600;margin:1.75rem 0 .5rem}
.report h4{font-size:.85rem;font-weight:600;margin:1.25rem 0 .5rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.report .note{color:var(--muted);font-size:.85rem;margin:.5rem 0 1rem;max-width:80ch}
.report .callout{border:1px solid var(--line);background:var(--warnbg);color:var(--fg);padding:.75rem 1rem;border-radius:.5rem;margin:.75rem 0;font-size:.9rem}
.report .verdict{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:.5rem;background:var(--bg);padding:.5rem 1rem;margin:.25rem 0 .75rem}
.report .v-row{display:flex;gap:1rem;padding:.55rem 0;border-top:1px solid var(--line);font-size:.95rem}
.report .v-row:first-child{border-top:none}
.report .v-label{flex:0 0 7.5rem;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-size:.75rem;padding-top:.2rem}
.report .v-text{flex:1;min-width:0}
.report .v-fail{color:var(--fail)}
.report .v-warn{color:var(--warn)}
.report .v-ok{color:var(--ok)}
.report .v-adv{color:var(--adv);font-weight:600}
.report .nocase{text-transform:none}
.report .tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:.5rem;margin:.5rem 0;background:var(--bg)}
.report table.tbl{border-collapse:collapse;width:100%;font-size:.85rem}
.report .tbl th{background:var(--head);text-align:left;padding:.45rem .6rem;font-weight:600;white-space:nowrap;border-bottom:1px solid var(--line);vertical-align:bottom}
.report .tbl th.rh{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500;font-size:.8rem}
.report .tbl td{padding:.4rem .6rem;border-top:1px solid var(--line);vertical-align:top}
.report .tbl th.num{text-align:right}
.report .tbl td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.report .tbl tbody th.rh{background:transparent;border-top:1px solid var(--line);white-space:nowrap}
.report .tbl .audit,.report .tbl th.audit{color:var(--muted);font-weight:400;font-size:.8rem}
.report .tbl tr.gate-fail td,.report .tbl tr.gate-fail th{background:var(--failbg)}
.report .tbl tr.gate-warn td,.report .tbl tr.gate-warn th{background:var(--warnbg)}
.report .tbl tr.gate-adv td,.report .tbl tr.gate-adv th{background:var(--advbg)}
.report span.gate-adv{color:var(--adv);font-weight:600}
.report table.tbl-gates td:last-child{min-width:20rem}
.report .gate-fail{color:var(--fail);font-weight:600}
.report .gate-warn{color:var(--warn);font-weight:600}
.report td.gate-fail,.report td.gate-warn{font-weight:600}
.report .est{font-weight:700}
.report .ns{color:var(--muted)}
.report .badge{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.75rem;font-weight:600;white-space:nowrap}
.report .badge.ok{color:var(--muted);background:var(--infobg)}
.report .badge.warn{color:var(--warn);background:var(--warnbg)}
.report .badge.fail{color:var(--fail);background:var(--failbg)}
.report .badge.info{color:var(--info);background:var(--infobg)}
.report .badge.adv{color:var(--adv);background:var(--advbg)}
.report .rule{color:var(--muted);font-size:.78rem;font-weight:400}
.report .src{display:block;color:var(--muted);font-size:.75rem;margin-top:.15rem}
.report .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem}
.report .nowrap{white-space:nowrap}
.report .legend .sw{display:inline-block;width:.9em;height:.9em;border-radius:.2em;vertical-align:-.1em;margin-right:.3em}
.report .legend .sw.gate-warn{background:var(--warnbg);border:1px solid var(--warn)}
.report .legend .sw.gate-fail{background:var(--failbg);border:1px solid var(--fail)}
.report details{margin:.75rem 0;border:1px solid var(--line);border-radius:.5rem;padding:.25rem .75rem}
.report details>summary{cursor:pointer;font-weight:600;padding:.4rem 0;font-size:.9rem}
.report details[open]>summary{margin-bottom:.5rem}
.report .diagram{background:#fff;border:1px solid var(--line);border-radius:.5rem;padding:1rem;overflow:auto;margin:.5rem 0}
.report .diagram svg{max-width:100%;height:auto}
.report .diagram.diagram-tall svg{width:100%;height:65vh}
.report button.diagram-expand{margin-top:0}
.diagram-dialog{width:min(96vw,1400px);max-width:none;height:92vh;max-height:none;padding:0;border:1px solid var(--line);border-radius:.75rem;background:var(--bg);color:var(--fg)}
.diagram-dialog::backdrop{background:#0009}
.diagram-dialog .dd-bar{display:flex;gap:.5rem;align-items:center;padding:.5rem .75rem;border-bottom:1px solid var(--line)}
.diagram-dialog .dd-bar button{font:inherit;font-size:.85rem;padding:.25rem .7rem;border:1px solid var(--line);border-radius:.4rem;background:var(--head);color:var(--fg);cursor:pointer}
.diagram-dialog .dd-bar .dd-close{margin-left:auto}
.diagram-dialog .dd-body{overflow:auto;height:calc(92vh - 3rem);background:#fff}
.report pre.code{background:var(--head);border:1px solid var(--line);border-radius:.5rem;padding:1rem;overflow-x:auto;font-size:.8rem;line-height:1.45}
.report button.copy{font:inherit;font-size:.75rem;padding:.2rem .6rem;border:1px solid var(--line);border-radius:.4rem;background:var(--head);color:var(--fg);cursor:pointer;margin:.25rem .25rem .75rem 0}
.report button.copy:hover{border-color:var(--accent)}
.report .msg{border:1px solid var(--line);border-radius:.6rem;padding:.75rem 1rem;background:var(--bg)}
.report .msg.user{background:var(--head)}
.report .msg.tool{border-style:dashed}
.report .msg .who{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:.35rem}
.report .msg .body p{margin:.4rem 0}
.report .msg .body ul,.report .msg .body ol{margin:.4rem 0 .4rem 1.25rem}
.report .msg .body h3,.report .msg .body h4,.report .msg .body h5{margin:.9rem 0 .3rem;font-size:.95rem}
.report .msg .tool-head{margin-bottom:.25rem}
.report .msg details{margin:.4rem 0}
.report .msg ul.compare{margin:.2rem 0 .4rem 1.1rem;font-size:.85rem}
.report .msg .body .tblwrap{margin:.5rem 0}
@media (max-width:640px){.report .v-row{flex-direction:column;gap:.2rem}.report .v-label{flex:none}
.report table.tbl-gates thead{display:none}
.report table.tbl-gates,.report table.tbl-gates tbody{display:block}
.report table.tbl-gates tr{display:grid;grid-template-columns:auto 1fr auto;gap:.2rem .6rem;align-items:baseline;padding:.6rem .75rem;border-top:1px solid var(--line)}
.report table.tbl-gates tr:first-child{border-top:none}
.report table.tbl-gates tr.gate-fail{background:var(--failbg)}
.report table.tbl-gates tr.gate-warn{background:var(--warnbg)}
.report table.tbl-gates tr.gate-adv{background:var(--advbg)}
.report table.tbl-gates td{display:block;border:none;padding:0;min-width:0;background:transparent!important}
.report table.tbl-gates td:nth-child(3){order:1;grid-column:1/-1;font-weight:600}
.report table.tbl-gates td:nth-child(5){order:2;grid-column:1/-1}
.report table.tbl-gates td:nth-child(6){order:3;grid-column:1/-1;min-width:0}
.report table.tbl-gates .nowrap{white-space:normal}}
@media print{.report button.copy{display:none}.report details{border:none;padding:0}.report details>summary{display:none}.report details:not([open])>*:not(summary){display:block}}
`;

export function renderStandaloneReport(r: AnalysisResult, ctx: RenderContext): string {
  const sections = renderSections(r, ctx);
  const title = `PLS-SEM analysis — ${esc(r.input.dataName)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fafafa}main{max-width:1100px;margin:0 auto;padding:2rem 1.25rem}header h1{font-size:1.6rem;margin:0 0 .25rem}header p{color:#52525b;margin:0}nav{font-size:.85rem;margin:1rem 0 0}nav a{margin-right:1rem;color:#c2410c}${REPORT_CSS}</style>
</head><body><main class="report">
<header><h1>${title}</h1><p>Estimated in the browser with seminr-ts ${esc(r.engine.core)} · ${esc(new Date(r.generatedAt).toLocaleString())} · nicholasdanks.com/seminr</p>
<nav>${sections.map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`).join("")}</nav></header>
${sections.map((s) => `<section id="${s.id}"><h2>${esc(s.title)}</h2>${s.html}</section>`).join("\n")}
<footer class="note" style="margin-top:3rem">Method references: Hair, Hult, Ringle, Sarstedt, Danks &amp; Adler, <em>Partial Least Squares Structural Equation Modeling (PLS-SEM) Using R</em> (Springer); Shmueli et al. (2019); Liengaard et al. (2021); Sharma et al. (2023); Zhao, Lynch &amp; Chen (2010); Ringle et al. (2023); Franke, Sarstedt &amp; Danks (2021). Software: Ray, Danks &amp; Calero Valdez, SEMinR.</footer>
</main></body></html>`;
}
