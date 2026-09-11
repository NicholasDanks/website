/**
 * Render an AnalysisResult to HTML. Used both on the page (sections injected
 * into the DOM) and for the downloadable standalone report, so the two never
 * drift. Deliberately free of @seminr/core imports: only types cross over, so
 * the page bundle stays small and the worker owns the numerics.
 */

import type { NamedMatrix } from "@seminr/core";
import type { AnalysisResult, ConstructInfo } from "./analyze";
import { isStageError } from "./analyze";
import { tallyAssessment, type AssessmentItem, type AssessmentSection } from "./assess";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export const esc = (s: unknown): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const fmt = (x: unknown, d = 3): string => {
  if (typeof x !== "number" || !Number.isFinite(x)) return "";
  return x.toFixed(d);
};

const stars = (p: number): string => (!Number.isFinite(p) ? "" : p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : p < 0.1 ? "†" : "");

function cell(m: NamedMatrix | undefined, row: string, col: string): number {
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
  caption?: string;
  /** Extra HTML column appended per row. */
  extra?: { header: string; render: (row: string) => string };
}

/** A NamedMatrix as an HTML table. */
export function matrixTable(m: NamedMatrix, o: TableOptions = {}): string {
  const d = o.digits ?? 3;
  const rows = o.dropEmptyRows
    ? m.rows.filter((_, i) => m.values[i].some((v) => Number.isFinite(v) && v !== 0))
    : m.rows;
  const head = `<tr><th class="rh">${esc(o.corner ?? "")}</th>${m.cols.map((c) => `<th>${esc(c)}</th>`).join("")}${o.extra ? `<th>${esc(o.extra.header)}</th>` : ""}</tr>`;
  const body = rows.map((r) => {
    const i = m.rows.indexOf(r);
    const cells = m.cols.map((c, j) => {
      const v = m.values[i][j];
      const cls = o.cellClass?.(r, c, v) ?? "";
      return `<td class="num ${cls}">${fmt(v, o.colDigits?.[c] ?? d)}</td>`;
    }).join("");
    return `<tr><th class="rh">${esc(r)}</th>${cells}${o.extra ? `<td>${o.extra.render(r)}</td>` : ""}</tr>`;
  }).join("");
  return `<div class="tblwrap"><table class="tbl">${o.caption ? `<caption>${esc(o.caption)}</caption>` : ""}<thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** Rows of arbitrary cells (already formatted) as an HTML table. */
export function rowsTable(headers: string[], rows: (string | number)[][], o: { caption?: string; numeric?: boolean[]; rowClass?: (i: number) => string } = {}): string {
  const head = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const body = rows.map((r, i) =>
    `<tr class="${o.rowClass?.(i) ?? ""}">${r.map((c, j) => {
      const numeric = o.numeric ? o.numeric[j] : typeof c === "number";
      const text = typeof c === "number" ? fmt(c) : c;
      return `<td class="${numeric ? "num" : ""}">${typeof c === "number" ? text : c}</td>`;
    }).join("")}</tr>`,
  ).join("");
  return `<div class="tblwrap"><table class="tbl">${o.caption ? `<caption>${esc(o.caption)}</caption>` : ""}<thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

/** A NamedMatrix as tab-separated text, for the clipboard. */
export function matrixTsv(m: NamedMatrix, digits = 6): string {
  const lines = [["", ...m.cols].join("\t")];
  m.rows.forEach((r, i) => lines.push([r, ...m.values[i].map((v) => (Number.isFinite(v) ? v.toFixed(digits) : ""))].join("\t")));
  return lines.join("\n");
}

const note = (html: string) => `<p class="note">${html}</p>`;
const h3 = (t: string, id?: string) => `<h3${id ? ` id="${id}"` : ""}>${esc(t)}</h3>`;
const details = (summary: string, inner: string, open = false) =>
  `<details${open ? " open" : ""}><summary>${esc(summary)}</summary>${inner}</details>`;
const tsvButton = (key: string) => `<button type="button" class="copy" data-tsv="${key}">Copy TSV</button>`;

/** A bootstrap summary table (rows = "X  ->  Y") rendered with p-value stars. */
function bootTable(m: NamedMatrix, corner: string): string {
  const pCol = "Bootstrap P Val";
  return matrixTable(m, {
    corner,
    colDigits: { [pCol]: 3, "T Stat.": 2 },
    cellClass: (_r, c, v) => (c === pCol ? (v < 0.05 ? "sig" : "nsig") : ""),
    extra: { header: "", render: (r) => stars(cell(m, r, pCol)) },
  });
}

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
  congruence: "Congruence",
};

function assessmentTable(items: AssessmentItem[]): string {
  return rowsTable(
    ["", "Subject", "Criterion", "Value", "Rule", "Assessment"],
    items.map((a) => [
      `<span class="badge ${a.status}">${STATUS_LABEL[a.status]}</span>`,
      esc(a.subject),
      esc(a.criterion),
      a.value === null ? "" : fmt(a.value),
      `<span class="rule">${esc(a.threshold)}</span>`,
      `${esc(a.message)} <span class="src">${esc(a.source)}</span>`,
    ]),
    { numeric: [false, false, false, true, false, false] },
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
  const reg = (key: string, m: NamedMatrix) => { ctx.tsv[key] = matrixTsv(m); return tsvButton(key); };
  const o = r.input.options;

  // --- overview -----------------------------------------------------------------
  {
    const tally = tallyAssessment(r.assessment);
    const problems = r.assessment.filter((a) => a.status === "fail");
    const checks = r.assessment.filter((a) => a.status === "warn");
    const rest = r.assessment.filter((a) => a.status === "ok" || a.status === "info");
    const bySection = (items: AssessmentItem[]) =>
      (Object.keys(SECTION_LABEL) as AssessmentSection[])
        .map((sec) => ({ sec, items: items.filter((a) => a.section === sec) }))
        .filter((g) => g.items.length)
        .map((g) => `<h4>${esc(SECTION_LABEL[g.sec])}</h4>${assessmentTable(g.items)}`)
        .join("");

    const facts = rowsTable(
      ["", ""],
      [
        ["Cases", `${r.data.n} pasted, ${r.data.nEstimation} used for estimation`],
        ["Columns", `${r.data.columns} in the data, ${Object.keys(r.data.missing).length} used by the model`],
        ["Missing data", `${o.estimation.missing === "na_omit" ? "listwise deletion" : "mean replacement"}${o.estimation.missingValue !== undefined ? `, marker ${o.estimation.missingValue}` : ""}`],
        ["Inner weighting", o.estimation.innerWeights.replace("_", " ")],
        ["PLS iterations", String(r.model.iterations)],
        ["Bootstrap", boot ? `${boot.nboot} resamples, seed ${boot.seed}, alpha ${boot.alpha}${boot.fails ? `, ${boot.fails} failed resamples` : ""}` : "not run"],
        ["PLSpredict", r.predict && !isStageError(r.predict) ? `${r.predict.noFolds}-fold, ${r.predict.technique.replace("predict_", "")} scheme, seed ${r.predict.seed}` : "not run"],
        ["Congruence test", r.congruence && !isStageError(r.congruence) ? `${r.congruence.nboot} resamples, ${r.congruence.diagonal === "rhoA" ? "rho_A" : "rho_C"} diagonal, threshold ${r.congruence.threshold}` : "not run"],
        ["Engine", `seminr-ts ${r.engine.core}, seminrExtras-ts ${r.engine.extras}, app ${r.engine.app}`],
        ["Generated", new Date(r.generatedAt).toLocaleString()],
      ].map(([k, v]) => [`<strong>${esc(k)}</strong>`, esc(v)]),
    );

    const warnings = r.model.warnings.filter((w) => !/observations are valid/.test(w));
    out.push({
      id: "overview",
      title: "Overview",
      html: [
        `<div class="tally"><span class="badge fail">${tally.fail} problems</span><span class="badge warn">${tally.warn} to check</span><span class="badge ok">${tally.ok} passed</span><span class="badge info">${tally.info} notes</span></div>`,
        facts,
        warnings.length ? `<div class="callout">${warnings.map((w) => `<p>${esc(w)}</p>`).join("")}</div>` : "",
        h3("Constructs"),
        constructsTable(r.model.constructs),
        h3("Assessment"),
        note("Rules of thumb from <em>PLS-SEM Using R</em> (Hair, Hult, Ringle, Sarstedt, Danks &amp; Adler). A flag is a prompt to look, not a verdict; every row states what was compared with what."),
        problems.length ? `<h4>Problems</h4>${assessmentTable(problems)}` : "",
        checks.length ? `<h4>Worth checking</h4>${assessmentTable(checks)}` : "",
        details(`All ${rest.length} passed checks and notes`, bySection(rest)),
      ].join(""),
    });
  }

  // --- diagram --------------------------------------------------------------------
  out.push({
    id: "diagram",
    title: "Model diagram",
    html: [
      `<div class="diagram" data-diagram="model">${ctx.svg?.model ?? '<p class="note">Rendering the diagram…</p>'}</div>`,
      r.model.dotBoot ? details("Bootstrapped model (path coefficients with significance)", `<div class="diagram" data-diagram="boot">${ctx.svg?.boot ?? '<p class="note">Rendering…</p>'}</div>`) : "",
      note("Path diagrams as seminr's <code>plot(model)</code> and <code>plot(boot_model)</code>: the same Graphviz source rendered here in WebAssembly."),
    ].join(""),
  });

  // --- measurement model --------------------------------------------------------------
  {
    const reflective = r.model.constructs.filter((c) => c.class === "reflective" || c.class === "single-item");
    const formative = r.model.constructs.filter((c) => c.class === "formative" || c.class === "unit-weights");
    const hoc = r.model.constructs.filter((c) => c.class === "higher-order");

    const loadingRows = (cs: ConstructInfo[]) => cs.flatMap((c) => c.items.map((it) => {
      const l = cell(s.loadings, it, c.name);
      const w = cell(s.weights, it, c.name);
      const br = boot ? boot.bootstrappedLoadings : undefined;
      const label = `${it}  ->  ${c.name}`;
      const cols: (string | number)[] = [esc(c.name), esc(it), l, l * l, w];
      if (br) {
        const p = cell(br, label, "Bootstrap P Val");
        cols.push(cell(br, label, "Bootstrap SD"), cell(br, label, "T Stat."), cell(br, label, br.cols[4]), cell(br, label, br.cols[5]), `${fmt(p)} ${stars(p)}`);
      }
      return cols;
    }));
    const loadingHeaders = ["Construct", "Indicator", "Loading", "Indicator reliability", "Weight", ...(boot ? ["Boot SD", "t", boot.bootstrappedLoadings.cols[4], boot.bootstrappedLoadings.cols[5], "p"] : [])];

    const weightRows = (cs: ConstructInfo[]) => cs.flatMap((c) => c.items.map((it) => {
      const w = cell(s.weights, it, c.name);
      const l = cell(s.loadings, it, c.name);
      const vif = s.validity.vifItems[c.name]?.[it];
      const bw = boot ? boot.bootstrappedWeights : undefined;
      const label = `${it}  ->  ${c.name}`;
      const cols: (string | number)[] = [esc(c.name), esc(it), w, l, vif ?? NaN];
      if (bw) {
        const p = cell(bw, label, "Bootstrap P Val");
        cols.push(cell(bw, label, "Bootstrap SD"), cell(bw, label, "T Stat."), cell(bw, label, bw.cols[4]), cell(bw, label, bw.cols[5]), `${fmt(p)} ${stars(p)}`);
      }
      return cols;
    }));
    const weightHeaders = ["Construct", "Indicator", "Weight", "Loading", "VIF", ...(boot ? ["Boot SD", "t", boot.bootstrappedWeights.cols[4], boot.bootstrappedWeights.cols[5], "p"] : [])];

    ctx.tsv.loadings = matrixTsv(s.loadings);
    ctx.tsv.weights = matrixTsv(s.weights);
    ctx.tsv.reliability = matrixTsv(s.reliability);

    out.push({
      id: "measurement",
      title: "Measurement model",
      html: [
        h3("Reliability and convergent validity"),
        matrixTable(s.reliability, { corner: "Construct", cellClass: (_r, c, v) => (c === "AVE" ? (v < 0.5 ? "bad" : "") : c === "alpha" || c === "rhoA" || c === "rhoC" ? (v < 0.7 ? "bad" : v > 0.95 ? "warnc" : "") : "") }),
        tsvButton("reliability"),
        note("Single-item constructs and mode B composites report reliability 1 by construction. Alpha, rho_A and rho_C should sit between 0.70 and 0.95; AVE at or above 0.50."),
        reflective.length ? h3("Indicator loadings (reflective and single-item constructs)") : "",
        reflective.length ? rowsTable(loadingHeaders, loadingRows(reflective), { rowClass: (i) => (Math.abs(Number(loadingRows(reflective)[i][2])) < 0.708 ? "flag" : "") }) : "",
        reflective.length ? tsvButton("loadings") : "",
        formative.length ? h3("Indicator weights (formative and unit-weight composites)") : "",
        formative.length ? rowsTable(weightHeaders, weightRows(formative)) : "",
        formative.length ? tsvButton("weights") : "",
        formative.length ? note("For formative indicators, read the weight's significance first; an indicator with a non-significant weight but a loading of 0.50 or more is still absolutely important. VIF should be below 3 (5 at most).") : "",
        hoc.length ? h3("Higher-order constructs") : "",
        hoc.length ? rowsTable(weightHeaders, weightRows(hoc)) : "",
        details("Cross-loadings", matrixTable(s.validity.crossLoadings, { corner: "Indicator" }) + reg("crossLoadings", s.validity.crossLoadings)),
        details("All outer loadings", matrixTable(s.loadings, { corner: "Indicator", dropEmptyRows: true })),
        details("All outer weights", matrixTable(s.weights, { corner: "Indicator", dropEmptyRows: true })),
      ].join(""),
    });
  }

  // --- discriminant validity --------------------------------------------------------------
  {
    const htmtM = s.validity.htmt;
    out.push({
      id: "discriminant",
      title: "Discriminant validity",
      html: [
        h3("HTMT"),
        matrixTable(htmtM, { corner: "", cellClass: (_r, _c, v) => (v >= 0.9 ? "bad" : v >= 0.85 ? "warnc" : "") }),
        reg("htmt", htmtM),
        boot ? h3("Bootstrapped HTMT") : "",
        boot ? bootTable(boot.bootstrappedHtmt, "Pair") : "",
        boot ? reg("bootHtmt", boot.bootstrappedHtmt) : "",
        boot ? note("For HTMT, the t-statistic tests the distance from 1 and the p-value counts resamples on either side of 1. The upper confidence bound should stay below 0.90 (0.85 for conceptually distinct constructs).") : "",
        details("Fornell–Larcker criterion", matrixTable(s.validity.flCriteria, { corner: "" }) + reg("flCriteria", s.validity.flCriteria) + note("Square roots of AVE on the diagonal, construct correlations below it. HTMT is the recommended criterion; Fornell–Larcker is shown for completeness.")),
      ].join(""),
    });
  }

  // --- structural model --------------------------------------------------------------------
  {
    const pathsM = s.paths;
    const r2 = { rows: ["R^2", "AdjR^2"], cols: pathsM.cols, values: [pathsM.values[pathsM.rows.indexOf("R^2")], pathsM.values[pathsM.rows.indexOf("AdjR^2")]] } as NamedMatrix;
    const coefRows = pathsM.rows.filter((x) => !/R\^2/.test(x));
    const coefM = { rows: coefRows, cols: pathsM.cols, values: coefRows.map((x) => pathsM.values[pathsM.rows.indexOf(x)]) } as NamedMatrix;
    const f2 = s.fSquare;
    const vifRows = Object.entries(s.vifAntecedents).flatMap(([dv, ants]) => Object.entries(ants).map(([iv, v]) => [esc(iv), esc(dv), v]));
    const med = r.mediation && !isStageError(r.mediation) ? r.mediation : null;

    ctx.tsv.paths = matrixTsv(pathsM);
    ctx.tsv.fSquare = matrixTsv(f2);
    out.push({
      id: "structural",
      title: "Structural model",
      html: [
        h3("Path coefficients"),
        boot ? bootTable(boot.bootstrappedPaths, "Path") : matrixTable(coefM, { corner: "" }),
        boot ? reg("bootPaths", boot.bootstrappedPaths) : tsvButton("paths"),
        boot ? note(`Percentile bootstrap intervals from ${boot.nboot} resamples. Stars: *** p &lt; 0.001, ** p &lt; 0.01, * p &lt; 0.05, † p &lt; 0.10.`) : note("Run the bootstrap to test significance."),
        h3("Explained variance"),
        matrixTable(r2, { corner: "" }),
        h3("Effect sizes (f²)"),
        matrixTable(f2, { corner: "", dropEmptyRows: true, cellClass: (_r, _c, v) => (v === 0 ? "zero" : v >= 0.35 ? "strong" : v >= 0.15 ? "" : v >= 0.02 ? "" : "weak") }),
        tsvButton("fSquare"),
        h3("Collinearity of antecedents (VIF)"),
        rowsTable(["Antecedent", "Outcome", "VIF"], vifRows, { rowClass: (i) => (Number(vifRows[i][2]) >= 5 ? "flag" : "") }),
        boot ? h3("Total effects") : "",
        boot ? bootTable(boot.bootstrappedTotalPaths, "Path") : "",
        boot ? reg("bootTotal", boot.bootstrappedTotalPaths) : "",
        boot && boot.bootstrappedTotalIndirectPaths ? h3("Total indirect effects") : "",
        boot && boot.bootstrappedTotalIndirectPaths ? bootTable(boot.bootstrappedTotalIndirectPaths, "Path") : "",
        med && med.specific.length ? h3("Specific indirect effects (mediation)") : "",
        med && med.specific.length
          ? rowsTable(
              ["Path", "Estimate", "Boot mean", "Boot SD", "t", "CI lower", "CI upper", "p"],
              med.specific.map((e) => [esc(e.path), e.originalEst, e.bootstrapMean, e.bootstrapSd, e.tStat, e.ciLower, e.ciUpper, `${fmt(e.bootstrapP)} ${stars(e.bootstrapP)}`]),
            )
          : "",
        med && med.specific.length ? note("Every mediating chain the structural model contains, with the bootstrap distribution of the product of its path coefficients. Compare with the direct effect to classify the mediation (complementary, competitive, indirect-only).") : "",
        !boot ? details("Total effects (point estimates)", matrixTable(s.totalEffects, { corner: "", dropEmptyRows: true })) : "",
        details("Information criteria (AIC, BIC per endogenous construct)", matrixTable(s.itCriteria, { corner: "" }) + note("For comparing competing models estimated on the same data; lower is better.")),
      ].join(""),
    });
  }

  // --- prediction ----------------------------------------------------------------------------
  {
    const pr = r.predict;
    const cv = r.cvpat;
    const html: string[] = [];
    if (pr && !isStageError(pr)) {
      const items = pr.plsOutOfSample.cols;
      const rows = items.map((it) => {
        const pls = cell(pr.plsOutOfSample, "RMSE", it), lm = cell(pr.lmOutOfSample, "RMSE", it);
        return [esc(pr.itemConstruct[it] ?? ""), esc(it), pls, cell(pr.plsOutOfSample, "MAE", it), lm, cell(pr.lmOutOfSample, "MAE", it), pr.q2Predict[it] ?? NaN, pls < lm ? "PLS" : "LM"];
      });
      const better = rows.filter((x) => x[7] === "PLS").length;
      html.push(
        h3("PLSpredict"),
        rowsTable(["Construct", "Indicator", "PLS RMSE", "PLS MAE", "LM RMSE", "LM MAE", "Q²predict", "Lower RMSE"], rows, { rowClass: (i) => (rows[i][7] === "LM" || Number(rows[i][6]) <= 0 ? "flag" : "") }),
        note(`${pr.noFolds}-fold cross-validation, ${pr.technique === "predict_DA" ? "direct antecedents" : "earliest antecedents"} scheme. PLS has the lower out-of-sample RMSE for ${better} of ${items.length} indicators. Q²predict compares the out-of-sample errors with predicting the whole-sample indicator mean (a benchmark slightly stricter than the fold-wise mean SmartPLS uses).`),
        details("Construct-level prediction error", matrixTable(pr.constructError, { corner: "" }) + note("In-sample (IS) and out-of-sample (OOS) MSE/MAE of the construct scores; the overfit ratio compares the two.")),
      );
      ctx.tsv.plsPredict = ["construct\tindicator\tPLS_RMSE\tPLS_MAE\tLM_RMSE\tLM_MAE\tQ2predict", ...rows.map((x) => x.slice(0, 7).map((v) => (typeof v === "number" ? v.toFixed(6) : v)).join("\t"))].join("\n");
      html.push(tsvButton("plsPredict"));
    } else if (pr) {
      html.push(`<div class="callout">PLSpredict could not run: ${esc(pr.error)}</div>`);
    }
    if (cv && !isStageError(cv)) {
      html.push(
        h3("CVPAT"),
        matrixTable(cv.lm, { corner: "vs linear model", cellClass: (_r, c, v) => (c === "Boot P Value" ? (v < 0.05 ? "sig" : "nsig") : "") }),
        matrixTable(cv.ia, { corner: "vs indicator average", cellClass: (_r, c, v) => (c === "Boot P Value" ? (v < 0.05 ? "sig" : "nsig") : "") }),
        note(`Cross-validated predictive ability test with ${cv.nboot} bootstrap resamples. A negative, significant difference means the PLS model's average loss is lower than the benchmark's. Beating the indicator average establishes predictive validity; beating the linear model is the stronger claim.`),
      );
      ctx.tsv.cvpatLm = matrixTsv(cv.lm);
      html.push(tsvButton("cvpatLm"));
    } else if (cv) {
      html.push(`<div class="callout">CVPAT could not run: ${esc(cv.error)}</div>`);
    }
    if (html.length) out.push({ id: "prediction", title: "Predictive power", html: html.join("") });
  }

  // --- congruence ------------------------------------------------------------------------------
  {
    const cg = r.congruence;
    if (cg && !isStageError(cg)) {
      const rows = cg.rows.map((row, i) => [
        esc(row.pair.replace(" -> ", " ↔ ")), row.estimate, row.diff, row.bootSD, row.tStat ?? NaN, row.ciLo, row.ciHi,
        row.significant ? '<span class="badge ok">Yes</span>' : '<span class="badge warn">No</span>',
        cg.htmtRows ? cg.htmtRows[i].estimate : "",
      ]);
      const nonSig = cg.rows.filter((x) => !x.significant).length;
      ctx.tsv.congruence = ["pair\testimate\tdiff\tboot_sd\tt\tci_lo\tci_hi\tsignificant\thtmt_based", ...cg.rows.map((row, i) => [row.pair, row.estimate, row.diff, row.bootSD, row.tStat ?? "", row.ciLo, row.ciHi, row.significant, cg.htmtRows?.[i].estimate ?? ""].join("\t"))].join("\n");
      out.push({
        id: "congruence",
        title: "Congruence test",
        html: [
          rowsTable(["Pair", "Original est.", "Diff", "Boot SD", "t", cg.loLabel, cg.hiLabel, "Distinguishable", "HTMT-based (point est.)"], rows, { rowClass: (i) => (String(rows[i][7]).includes("warn") ? "flag" : "") }),
          tsvButton("congruence"),
          note(`${cg.rows.length} construct pairs, ${cg.nboot} bootstrap resamples, threshold ${cg.threshold}, ${cg.diagonal === "rhoA" ? "rho_A" : "rho_C"} on the diagonal. ${nonSig === 0 ? "Every pair is empirically distinguishable." : `${nonSig} pair${nonSig === 1 ? "" : "s"} could not be distinguished from the threshold.`} A pair is distinguishable when the whole confidence interval falls below the threshold (Franke, Sarstedt &amp; Danks, 2021). The HTMT-based column is congruence over the disattenuated HTMT matrix: a point estimate for comparison, not a second test.`),
          note("Reliabilities used on the diagonal: " + Object.entries(cg.reliabilities).map(([k, v]) => `${esc(k)} ${fmt(v)}`).join(" · ")),
        ].join(""),
      });
    } else if (cg) {
      out.push({ id: "congruence", title: "Congruence test", html: `<div class="callout">The congruence test could not run: ${esc(cg.error)}</div>` });
    }
  }

  // --- descriptives ----------------------------------------------------------------------------
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
        tsvButton("constructCor"),
        details("Construct score statistics", matrixTable(d.statistics.constructs, { corner: "" })),
        details("Indicator statistics", matrixTable(d.statistics.items, { corner: "Indicator", colDigits: { "No.": 0, Missing: 0 } }) + tsvButton("itemStats")),
        details("Indicator correlations", matrixTable(d.correlations.items, { corner: "" })),
      ].join(""),
    });
  }

  // --- reproduce ---------------------------------------------------------------------------------
  out.push({
    id: "reproduce",
    title: "Reproduce in R",
    html: [
      note("The same model and options with seminr and seminrExtras. Point <code>read.csv()</code> at your file."),
      `<pre class="code"><code>${esc(r.rScript)}</code></pre>`,
      details("Model code as pasted", `<pre class="code"><code>${esc(r.input.code)}</code></pre>`),
    ].join(""),
  });

  return out;
}

// ---------------------------------------------------------------------------
// standalone report
// ---------------------------------------------------------------------------

export const REPORT_CSS = `
.report{--fg:#18181b;--muted:#52525b;--line:#e4e4e7;--bg:#fff;--head:#f4f4f5;--ok:#047857;--okbg:#ecfdf5;--warn:#b45309;--warnbg:#fffbeb;--fail:#b91c1c;--failbg:#fef2f2;--info:#3f3f46;--infobg:#f4f4f5;--accent:#c2410c;color:var(--fg);font-size:14px;line-height:1.5}
.dark .report{--fg:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--bg:#18181b;--head:#27272a;--ok:#6ee7b7;--okbg:#064e3b55;--warn:#fcd34d;--warnbg:#78350f55;--fail:#fca5a5;--failbg:#7f1d1d55;--info:#d4d4d8;--infobg:#27272a;--accent:#fb923c}
.report h2{font-size:1.35rem;font-weight:700;margin:2.5rem 0 1rem;padding-top:1rem;border-top:1px solid var(--line)}
.report h3{font-size:1.05rem;font-weight:600;margin:1.5rem 0 .5rem}
.report h4{font-size:.9rem;font-weight:600;margin:1.25rem 0 .5rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.report .note{color:var(--muted);font-size:.85rem;margin:.5rem 0 1rem;max-width:72ch}
.report .callout{border:1px solid var(--line);background:var(--warnbg);color:var(--fg);padding:.75rem 1rem;border-radius:.5rem;margin:.75rem 0;font-size:.9rem}
.report .tblwrap{overflow-x:auto;border:1px solid var(--line);border-radius:.5rem;margin:.5rem 0;background:var(--bg)}
.report table.tbl{border-collapse:collapse;width:100%;font-size:.85rem}
.report .tbl caption{text-align:left;padding:.5rem .75rem;font-weight:600}
.report .tbl th{background:var(--head);text-align:left;padding:.45rem .6rem;font-weight:600;white-space:nowrap;border-bottom:1px solid var(--line)}
.report .tbl th.rh{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500;font-size:.8rem}
.report .tbl td{padding:.4rem .6rem;border-top:1px solid var(--line);vertical-align:top}
.report .tbl td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.report .tbl tbody th.rh{background:transparent;border-top:1px solid var(--line);white-space:nowrap}
.report .tbl tr.flag td,.report .tbl tr.flag th{background:var(--warnbg)}
.report .tbl td.bad{color:var(--fail);font-weight:600}
.report .tbl td.warnc{color:var(--warn);font-weight:600}
.report .tbl td.sig{color:var(--ok);font-weight:600}
.report .tbl td.nsig{color:var(--muted)}
.report .tbl td.zero{color:var(--line)}
.report .tbl td.weak{color:var(--muted)}
.report .tbl td.strong{font-weight:600}
.report .badge{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.75rem;font-weight:600;white-space:nowrap}
.report .badge.ok{color:var(--ok);background:var(--okbg)}
.report .badge.warn{color:var(--warn);background:var(--warnbg)}
.report .badge.fail{color:var(--fail);background:var(--failbg)}
.report .badge.info{color:var(--info);background:var(--infobg)}
.report .tally{display:flex;flex-wrap:wrap;gap:.5rem;margin:.5rem 0 1rem}
.report .tally .badge{font-size:.85rem;padding:.3rem .8rem}
.report .rule{color:var(--muted);font-size:.8rem}
.report .src{display:block;color:var(--muted);font-size:.75rem;margin-top:.15rem}
.report .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem}
.report details{margin:.75rem 0;border:1px solid var(--line);border-radius:.5rem;padding:.25rem .75rem}
.report details>summary{cursor:pointer;font-weight:600;padding:.4rem 0;font-size:.9rem}
.report details[open]>summary{margin-bottom:.5rem}
.report .diagram{background:#fff;border:1px solid var(--line);border-radius:.5rem;padding:1rem;overflow:auto;margin:.5rem 0}
.report .diagram svg{max-width:100%;height:auto}
.report pre.code{background:var(--head);border:1px solid var(--line);border-radius:.5rem;padding:1rem;overflow-x:auto;font-size:.8rem;line-height:1.45}
.report button.copy{font:inherit;font-size:.75rem;padding:.2rem .6rem;border:1px solid var(--line);border-radius:.4rem;background:var(--head);color:var(--fg);cursor:pointer;margin:.25rem 0 .75rem}
.report button.copy:hover{border-color:var(--accent)}
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
<footer class="note" style="margin-top:3rem">Method references: Hair, Hult, Ringle, Sarstedt, Danks &amp; Adler, <em>Partial Least Squares Structural Equation Modeling (PLS-SEM) Using R</em> (Springer); Shmueli et al. (2019); Liengaard et al. (2021); Franke, Sarstedt &amp; Danks (2021). Software: Ray, Danks &amp; Calero Valdez, SEMinR.</footer>
</main></body></html>`;
}
