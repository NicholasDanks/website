/**
 * Client-side wiring for the /seminr/ page: validate inputs as they are
 * typed, run the analysis in a worker, render the results, draw the path
 * diagrams with wasm Graphviz, and offer downloads. No network requests are
 * made except for the demo dataset, and only when the user asks for it.
 */

import type { AnalysisResult, AnalysisOptions, StageId, StageStatus } from "./analyze";
import type { WorkerMessage, WorkerRequest } from "./worker";
import { parseSeminrModel, requiredItems, type ParsedModel } from "./parseSeminr";
import { renderSections, renderStandaloneReport, REPORT_CSS, esc, type RenderContext } from "./report";
import { buildDigest, digestLooksSafe, type Digest } from "./digest";
import { sanitizeSvg } from "./sanitize";
import type { EvaluatorSession, RunModelInput } from "./evaluator";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => $<HTMLInputElement>(id).value;
const num = (id: string, fallback: number) => { const v = Number(val(id)); return Number.isFinite(v) && val(id).trim() !== "" ? v : fallback; };
const checked = (id: string) => $<HTMLInputElement>(id).checked;

const STAGES: { id: StageId; label: string }[] = [
  { id: "parse", label: "Read model and data" },
  { id: "estimate", label: "Estimate the PLS model" },
  { id: "bootstrap", label: "Bootstrap" },
  { id: "predict", label: "PLSpredict" },
  { id: "cvpat", label: "CVPAT" },
  { id: "congruence", label: "Congruence test" },
  { id: "assess", label: "Assess against thresholds" },
];

const STORAGE_KEY = "seminr-app-v1";

let worker: Worker | null = null;
let lastResult: AnalysisResult | null = null;
let lastCtx: RenderContext | null = null;
let dataName = "pasted data";
let parsedModel: ParsedModel | null = null;
let dataColumns: string[] = [];
let lastOptions: AnalysisOptions | null = null;

// ---------------------------------------------------------------------------
// demos
// ---------------------------------------------------------------------------

interface Demo { file: string; dataName: string; code: string; codeNote: string; missingValue: string }

const DEMOS: Record<string, Demo> = {
  "corp-rep": {
    file: "/seminr-demo/corp_rep_data.csv",
    dataName: "corp_rep_data.csv",
    missingValue: "-99",
    codeNote: "Demo: the corporate reputation model of PLS-SEM Using R (Ch. 5–6), with four formative drivers of competence and likeability.",
    code: `# Corporate reputation model (Hair et al., PLS-SEM Using R, Ch. 5-6)
corp_rep_mm <- constructs(
  composite("QUAL", multi_items("qual_", 1:8), weights = mode_B),
  composite("PERF", multi_items("perf_", 1:5), weights = mode_B),
  composite("CSOR", multi_items("csor_", 1:5), weights = mode_B),
  composite("ATTR", multi_items("attr_", 1:3), weights = mode_B),
  composite("COMP", multi_items("comp_", 1:3)),
  composite("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  composite("CUSL", multi_items("cusl_", 1:3)))

corp_rep_sm <- relationships(
  paths(from = c("QUAL", "PERF", "CSOR", "ATTR"), to = c("COMP", "LIKE")),
  paths(from = c("COMP", "LIKE"),                 to = c("CUSA", "CUSL")),
  paths(from = "CUSA",                            to = "CUSL"))`,
  },
  moderation: {
    file: "/seminr-demo/corp_rep_data.csv",
    dataName: "corp_rep_data.csv",
    missingValue: "-99",
    codeNote: "Demo: the moderation model of PLS-SEM Using R (Ch. 7). Switching costs (SC) moderate the effect of satisfaction on loyalty; the interaction term is built with the two-stage approach.",
    code: `# Moderation: switching costs moderate CUSA -> CUSL (Hair et al., PLS-SEM Using R, Ch. 7)
corp_rep_mm_mod <- constructs(
  composite("COMP", multi_items("comp_", 1:3)),
  composite("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  composite("SC",   multi_items("switch_", 1:4)),
  composite("CUSL", multi_items("cusl_", 1:3)),
  interaction_term(iv = "CUSA", moderator = "SC", method = two_stage))

corp_rep_sm_mod <- relationships(
  paths(from = c("COMP", "LIKE"),          to = c("CUSA", "CUSL")),
  paths(from = c("CUSA", "SC", "CUSA*SC"), to = c("CUSL")))`,
  },
};

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

function readOptions(quick = false): AnalysisOptions {
  const missingRaw = val("missing-value").trim();
  const keyTarget = val("key-target");
  return {
    estimation: {
      innerWeights: val("inner-weights") as "path_weighting" | "path_factorial",
      missing: val("missing") as "mean_replacement" | "na_omit",
      missingValue: missingRaw === "" ? undefined : Number(missingRaw),
    },
    bootstrap: {
      enabled: !quick && checked("boot-enabled"),
      nboot: Math.max(50, Math.min(10000, Math.round(num("nboot", 2000)))),
      seed: Math.round(num("seed", 123)),
      alpha: Math.min(0.5, Math.max(0.001, num("alpha", 0.05))),
    },
    predict: {
      enabled: !quick && checked("predict-enabled"),
      noFolds: Math.max(2, Math.round(num("folds", 10))),
      technique: val("technique") as "predict_DA" | "predict_EA",
      seed: Math.round(num("seed", 123)),
      cvpat: checked("cvpat-enabled"),
      cvpatNboot: Math.max(50, Math.min(5000, Math.round(num("cvpat-nboot", 1000)))),
      keyTarget: keyTarget && keyTarget !== "auto" ? keyTarget : undefined,
    },
    congruence: {
      enabled: !quick && checked("congruence-enabled"),
      nboot: Math.max(50, Math.min(10000, Math.round(num("congruence-nboot", 1000)))),
      seed: Math.round(num("seed", 123)),
      alpha: Math.min(0.5, Math.max(0.001, num("alpha", 0.05))),
      threshold: Math.min(1, Math.max(0.5, num("congruence-threshold", 1))),
      diagonal: (document.querySelector('input[name="diagonal"]:checked') as HTMLInputElement)?.value === "rhoC" ? "rhoC" : "rhoA",
    },
  };
}

/** One line describing the options in force, shown when the panel is collapsed. */
function describeOptions() {
  const o = readOptions();
  const parts = [
    o.bootstrap.enabled ? `bootstrap ${o.bootstrap.nboot} resamples, α ${o.bootstrap.alpha}` : "no bootstrap",
    o.predict.enabled ? `PLSpredict ${o.predict.noFolds}-fold${o.predict.cvpat ? " + CVPAT" : ""}` : "no PLSpredict",
    o.congruence.enabled ? `congruence test (${o.congruence.diagonal === "rhoA" ? "ρA" : "ρC"})` : "no congruence test",
    `${o.estimation.missing === "na_omit" ? "drop incomplete cases" : "mean replacement"}${o.estimation.missingValue !== undefined ? ` for ${o.estimation.missingValue}` : ""}`,
    `seed ${o.bootstrap.seed}`,
  ];
  $("options-summary").textContent = parts.join(" · ");
}

const OPTION_IDS = ["missing-value", "missing", "inner-weights", "seed", "boot-enabled", "nboot", "alpha", "predict-enabled", "folds", "technique", "cvpat-enabled", "cvpat-nboot", "congruence-enabled", "congruence-nboot", "congruence-threshold", "key-target"];

function persist() {
  try {
    const opts: Record<string, string | boolean> = {};
    for (const id of OPTION_IDS) {
      const el = $<HTMLInputElement>(id);
      opts[id] = el.type === "checkbox" ? el.checked : el.value;
    }
    opts.diagonal = (document.querySelector('input[name="diagonal"]:checked') as HTMLInputElement)?.value ?? "rhoA";
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ code: val("code"), opts }));
  } catch { /* storage unavailable */ }
}

function restore(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw) as { code?: string; opts?: Record<string, string | boolean> };
    if (saved.code) $<HTMLTextAreaElement>("code").value = saved.code;
    for (const [id, v] of Object.entries(saved.opts ?? {})) {
      if (id === "diagonal") {
        const radio = document.querySelector<HTMLInputElement>(`input[name="diagonal"][value="${v}"]`);
        if (radio) radio.checked = true;
        continue;
      }
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (!el || id === "key-target") continue;
      if (el.type === "checkbox") el.checked = Boolean(v);
      else el.value = String(v);
    }
    return Boolean(saved.code);
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// live validation of the inputs
// ---------------------------------------------------------------------------

function headerColumns(text: string): string[] {
  const first = text.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  const d = first.includes("\t") ? "\t" : (first.match(/;/g) ?? []).length > (first.match(/,/g) ?? []).length ? ";" : ",";
  return first.split(d).map((c) => c.trim().replace(/^["']|["']$/g, ""));
}

function refreshKeyTarget() {
  const select = $<HTMLSelectElement>("key-target");
  const current = select.value;
  const endogenous = parsedModel ? [...new Set(parsedModel.paths.flatMap((p) => p.to))] : [];
  select.innerHTML = `<option value="auto">Automatic (final outcome)</option>` + endogenous.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if (endogenous.includes(current)) select.value = current;
}

function validateCode() {
  const code = val("code");
  const status = $("code-status");
  if (!code.trim()) { parsedModel = null; status.textContent = ""; status.className = "text-xs mt-2 text-surface-500 dark:text-surface-400"; refreshKeyTarget(); return; }
  try {
    parsedModel = parseSeminrModel(code);
    const kinds = { construct: 0, higher_composite: 0, interaction: 0 };
    for (const m of parsedModel.measurement) kinds[m.kind]++;
    const nPaths = parsedModel.paths.reduce((a, p) => a + p.from.length * p.to.length, 0);
    status.textContent = `Recognised ${kinds.construct} construct${kinds.construct === 1 ? "" : "s"}${kinds.higher_composite ? `, ${kinds.higher_composite} higher-order` : ""}${kinds.interaction ? `, ${kinds.interaction} interaction term${kinds.interaction === 1 ? "" : "s"}` : ""}, ${nPaths} path${nPaths === 1 ? "" : "s"}.`;
    status.className = "text-xs mt-2 text-emerald-700 dark:text-emerald-400";
  } catch (err) {
    parsedModel = null;
    status.textContent = err instanceof Error ? err.message : String(err);
    status.className = "text-xs mt-2 text-red-700 dark:text-red-300";
  }
  refreshKeyTarget();
  validateData();
}

function validateData() {
  const text = val("data").trim();
  const status = $("data-status");
  if (!text) { dataColumns = []; status.textContent = ""; status.className = "text-xs mt-2 text-surface-500 dark:text-surface-400"; return; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  dataColumns = headerColumns(text);
  const d = lines[0].includes("\t") ? "tab" : (lines[0].match(/;/g) ?? []).length > (lines[0].match(/,/g) ?? []).length ? "semicolon" : "comma";
  let msg = `${dataName}: ${lines.length - 1} rows × ${dataColumns.length} columns (${d}-separated).`;
  let cls = "text-xs mt-2 text-surface-500 dark:text-surface-400";
  if (parsedModel) {
    const needed = requiredItems(parsedModel);
    const missing = needed.filter((c) => !dataColumns.includes(c));
    if (missing.length) {
      msg += ` Missing ${missing.length} of the ${needed.length} indicators the model needs: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? " …" : ""}.`;
      cls = "text-xs mt-2 text-red-700 dark:text-red-300";
    } else {
      msg += ` All ${needed.length} model indicators found.`;
      cls = "text-xs mt-2 text-emerald-700 dark:text-emerald-400";
    }
  }
  status.textContent = msg;
  status.className = cls;
}

function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | undefined;
  return ((...a: Parameters<T>) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }) as T;
}

// ---------------------------------------------------------------------------
// progress + errors
// ---------------------------------------------------------------------------

function showError(msg: string) {
  const el = $("error");
  el.textContent = msg;
  el.classList.remove("hidden");
  el.scrollIntoView({ block: "nearest" });
}
function clearError() { $("error").classList.add("hidden"); }

function renderStages(state: Map<StageId, { status: StageStatus; detail?: string; fraction?: number }>) {
  $("stages").innerHTML = STAGES.map(({ id, label }) => {
    const st = state.get(id);
    const icon = !st ? "○" : st.status === "done" ? "●" : st.status === "start" ? "◐" : st.status === "failed" ? "✕" : "–";
    const cls = !st ? "text-surface-400" : st.status === "done" ? "text-emerald-600 dark:text-emerald-400" : st.status === "failed" ? "text-red-600 dark:text-red-400" : st.status === "skipped" ? "text-surface-400" : "text-accent-600 dark:text-accent-400";
    const pct = st?.status === "start" && st.fraction !== undefined ? ` ${Math.round(st.fraction * 100)}%` : "";
    return `<li class="flex items-baseline gap-2 ${cls}"><span class="font-mono">${icon}</span><span>${label}${pct}</span>${st?.detail ? `<span class="text-xs text-surface-500 dark:text-surface-400">${esc(st.detail)}</span>` : ""}</li>`;
  }).join("");
}

function setBusy(busy: boolean) {
  $<HTMLButtonElement>("run").disabled = busy;
  $<HTMLButtonElement>("quick").disabled = busy;
  $("run").textContent = busy ? "Running…" : "Run the full analysis";
  $("progress-wrap").classList.toggle("hidden", !busy);
  $("cancel").classList.toggle("hidden", !busy);
}

// ---------------------------------------------------------------------------
// diagrams
// ---------------------------------------------------------------------------

type GraphvizModule = { Graphviz: { load(): Promise<{ dot(src: string): string }> } };
let graphvizPromise: Promise<{ dot(src: string): string }> | null = null;
function graphviz() {
  if (!graphvizPromise) {
    graphvizPromise = (import("@hpcc-js/wasm-graphviz") as Promise<GraphvizModule>).then((m) => m.Graphviz.load());
  }
  return graphvizPromise;
}


async function renderDiagrams(result: AnalysisResult, ctx: RenderContext) {
  try {
    const gv = await graphviz();
    const svg = { model: sanitizeSvg(gv.dot(result.model.dot)), boot: result.model.dotBoot ? sanitizeSvg(gv.dot(result.model.dotBoot)) : undefined };
    ctx.svg = svg;
    document.querySelectorAll<HTMLElement>("[data-diagram]").forEach((el) => {
      const which = el.dataset.diagram as "model" | "boot";
      if (svg[which]) el.innerHTML = svg[which]!;
    });
    $("download-svg").classList.remove("hidden");
  } catch (err) {
    document.querySelectorAll<HTMLElement>("[data-diagram]").forEach((el) => {
      el.innerHTML = `<p class="note">The diagram renderer could not load (${esc(err instanceof Error ? err.message : String(err))}). The Graphviz source is in the downloaded JSON under model.dot.</p>`;
    });
  }
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

function renderResults(result: AnalysisResult) {
  lastResult = result;
  const ctx: RenderContext = { tsv: {} };
  lastCtx = ctx;
  const sections = renderSections(result, ctx);

  if (!document.getElementById("report-css")) {
    const style = document.createElement("style");
    style.id = "report-css";
    style.textContent = REPORT_CSS;
    document.head.appendChild(style);
  }
  $("results-nav").innerHTML = sections.map((s) => `<a href="#${s.id}" class="px-2 py-1 rounded-md text-xs font-medium text-surface-600 dark:text-surface-400 hover:text-accent-600 dark:hover:text-accent-400 hover:bg-surface-100 dark:hover:bg-surface-800/60">${esc(s.title)}</a>`).join("");
  $("results-body").innerHTML = sections.map((s) => `<section id="${s.id}" class="scroll-mt-28"><h2>${esc(s.title)}</h2>${s.html}</section>`).join("");
  $("results").classList.remove("hidden");
  $("evaluate").classList.remove("hidden");
  $("eval-digest").classList.add("hidden");

  $("results-body").querySelectorAll<HTMLButtonElement>("button.copy[data-tsv]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const text = ctx.tsv[btn.dataset.tsv!];
      if (!text) return;
      await navigator.clipboard.writeText(text);
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = old), 1500);
    });
  });

  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  void renderDiagrams(result, ctx);
}

function download(name: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stem(): string {
  return (dataName.replace(/\.[^.]+$/, "") || "pls-sem").replace(/[^A-Za-z0-9_-]+/g, "-");
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function run(quick: boolean) {
  clearError();
  const code = val("code");
  const dataText = val("data");
  if (!dataText.trim()) return showError("Paste or open your indicator data first.");
  if (!code.trim()) return showError("Paste your SEMinR model code first.");
  persist();

  const req: WorkerRequest = { code, dataText, dataName, options: readOptions(quick) };
  lastOptions = req.options;
  const state = new Map<StageId, { status: StageStatus; detail?: string; fraction?: number }>();
  renderStages(state);
  setBusy(true);
  $("results").classList.add("hidden");
  const started = Date.now();

  worker?.terminate();
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const m = e.data;
    if (m.type === "stage") {
      state.set(m.stage, { status: m.status, detail: m.detail });
      renderStages(state);
    } else if (m.type === "progress") {
      const st = state.get(m.stage);
      if (st) { st.fraction = m.fraction; renderStages(state); }
    } else if (m.type === "done") {
      setBusy(false);
      $("elapsed").textContent = `Finished in ${((Date.now() - started) / 1000).toFixed(1)} s.${quick ? " Quick look: no bootstrap, prediction or congruence test." : ""}`;
      renderResults(m.result);
    } else {
      setBusy(false);
      showError(m.message);
    }
  };
  worker.onerror = (err) => { setBusy(false); showError(err.message || "The analysis failed."); };
  worker.postMessage(req);
}

/** Run one analysis in a fresh worker and resolve with the result (no UI). */
function analyzeInWorker(req: WorkerRequest, onProgress?: (text: string) => void): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === "stage" && m.status === "start") onProgress?.(STAGES.find((s) => s.id === m.stage)?.label ?? m.stage);
      else if (m.type === "done") { w.terminate(); resolve(m.result); }
      else if (m.type === "error") { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (err) => { w.terminate(); reject(new Error(err.message || "The analysis failed.")); };
    w.postMessage(req);
  });
}

// ---------------------------------------------------------------------------
// evaluation assistant (bring your own Anthropic key; nothing but aggregates leaves)
// ---------------------------------------------------------------------------

const KEY_STORAGE = "seminr-anthropic-key";
let evalSession: EvaluatorSession | null = null;
let evalAbort: AbortController | null = null;
let evalBusy = false;
const evalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const alternativeRuns = new Map<string, { input: RunModelInput; result: AnalysisResult }>();
let alternativeCount = 0;
let workingTimer: ReturnType<typeof setInterval> | null = null;

/** The panel-wide "Claude is working" banner with phase and elapsed time. */
function setWorking(phase: string | null) {
  const el = $("eval-working");
  if (phase === null) {
    el.classList.add("hidden");
    if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }
    return;
  }
  el.classList.remove("hidden");
  el.querySelector(".phase")!.textContent = phase;
  if (!workingTimer) {
    const started = Date.now();
    const tick = () => { el.querySelector(".elapsed")!.textContent = `${Math.round((Date.now() - started) / 1000)} s`; };
    tick();
    workingTimer = setInterval(tick, 1000);
  }
}

/** Compare an alternative run with the model under review, in a few lines. */
function compareRuns(base: AnalysisResult, alt: AnalysisResult): string {
  const gates = (r: AnalysisResult) => r.assessment.filter((a) => a.kind === "gate");
  const g0 = gates(base), g1 = gates(alt);
  const count = (xs: typeof g0, st: string) => xs.filter((a) => a.status === st).length;
  const sig = (r: AnalysisResult) => {
    const b = r.bootstrap && !("error" in r.bootstrap) ? r.bootstrap.bootstrappedPaths : null;
    if (!b) return null;
    const pj = b.cols.indexOf("Bootstrap P Val");
    return { total: b.rows.length, supported: b.rows.filter((_, i) => b.values[i][pj] < r.input.options.bootstrap.alpha).length };
  };
  const s0 = sig(base), s1 = sig(alt);
  const key = alt.predict && !("error" in alt.predict) ? alt.predict.keyTarget : base.predict && !("error" in base.predict) ? base.predict.keyTarget : alt.summary.paths.cols[alt.summary.paths.cols.length - 1];
  const r2 = (r: AnalysisResult) => { const m = r.summary.paths; const i = m.rows.indexOf("R^2"), j = m.cols.indexOf(key); return i >= 0 && j >= 0 ? m.values[i][j] : NaN; };
  const beta = (r: AnalysisResult, from: string, to: string) => { const m = r.summary.paths; const i = m.rows.indexOf(from), j = m.cols.indexOf(to); return i >= 0 && j >= 0 ? m.values[i][j] : NaN; };
  const shared = alt.model.paths.filter((p) => base.model.paths.some((q) => q.from === p.from && q.to === p.to));
  const moved = shared.map((p) => ({ p, d: beta(alt, p.from, p.to) - beta(base, p.from, p.to) })).filter((x) => Number.isFinite(x.d)).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
  const added = alt.model.paths.filter((p) => !base.model.paths.some((q) => q.from === p.from && q.to === p.to));
  const removed = base.model.paths.filter((p) => !alt.model.paths.some((q) => q.from === p.from && q.to === p.to));
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");
  const lines = [
    `Quality gates: ${count(g1, "fail")} problems, ${count(g1, "warn")} to check (was ${count(g0, "fail")} / ${count(g0, "warn")}).`,
    s1 && s0 ? `Paths supported: ${s1.supported} of ${s1.total} (was ${s0.supported} of ${s0.total}).` : s1 ? `Paths supported: ${s1.supported} of ${s1.total}.` : "No bootstrap in this run.",
    `R² of ${key}: ${f(r2(alt))} (was ${f(r2(base))}).`,
    added.length ? `Added paths: ${added.map((p) => `${p.from} → ${p.to}`).join(", ")}.` : "",
    removed.length ? `Removed paths: ${removed.map((p) => `${p.from} → ${p.to}`).join(", ")}.` : "",
    moved.length ? `Largest coefficient changes: ${moved.map((x) => `${x.p.from} → ${x.p.to} ${f(beta(base, x.p.from, x.p.to))} → ${f(beta(alt, x.p.from, x.p.to))}`).join("; ")}.` : "",
  ].filter(Boolean);
  return `<ul class="compare">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
}

function loadKey(): string {
  try { return sessionStorage.getItem(KEY_STORAGE) ?? localStorage.getItem(KEY_STORAGE) ?? ""; } catch { return ""; }
}
function saveKey(key: string, remember: boolean) {
  try {
    sessionStorage.setItem(KEY_STORAGE, key);
    if (remember) localStorage.setItem(KEY_STORAGE, key); else localStorage.removeItem(KEY_STORAGE);
  } catch { /* storage unavailable */ }
}
function forgetKey() {
  try { sessionStorage.removeItem(KEY_STORAGE); localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ }
  $<HTMLInputElement>("api-key").value = "";
}

/** Minimal Markdown → HTML for assistant replies (headings, lists, emphasis, code). */
function mdToHtml(md: string): string {
  const lines = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let code: string[] | null = null;
  const inline = (t: string) => esc(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  let table: string[][] | null = null;
  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    out.push(`<div class="tblwrap"><table class="tbl"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    table = null;
  };
  for (const raw of lines) {
    if (/^\s*\|.*\|\s*$/.test(raw) && !code) {
      const cells = raw.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
      flushPara(); closeList();
      (table ??= []).push(cells);
      continue;
    }
    flushTable();
    if (code) {
      if (/^```/.test(raw)) { out.push(`<pre class="code"><code>${esc(code.join("\n"))}</code></pre>`); code = null; }
      else code.push(raw);
      continue;
    }
    if (/^```/.test(raw)) { flushPara(); closeList(); code = []; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(raw);
    if (h) { flushPara(); closeList(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(raw);
    if (li) {
      flushPara();
      const kind = /^\s*\d/.test(raw) ? "ol" : "ul";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (raw.trim() === "") { flushPara(); closeList(); continue; }
    para.push(raw.trim());
  }
  flushPara(); closeList(); flushTable();
  if (code) out.push(`<pre class="code"><code>${esc(code.join("\n"))}</code></pre>`);
  return out.join("");
}

function evalStatus(text: string) { $("eval-status").textContent = text; }

function appendTranscript(html: string, cls = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  $("eval-transcript").appendChild(el);
  el.scrollIntoView({ block: "nearest" });
  return el;
}

function currentDigest(label = "current model"): Digest | null {
  if (!lastResult) return null;
  return buildDigest(lastResult, dataColumns, label);
}

async function evaluatorModule() {
  return import("./evaluator");
}

function showDigestPreview() {
  const d = currentDigest();
  if (!d) return;
  const pre = $("eval-digest");
  evaluatorModule().then((m) => {
    pre.textContent = `SYSTEM PROMPT\n${m.SYSTEM_PROMPT}\n\nOPENING MESSAGE\n${m.openingMessage(d)}`;
    pre.classList.toggle("hidden");
  });
}

/** Execute a run_model request from the assistant on the user's data, locally. */
async function runModelForAssistant(input: RunModelInput, card: HTMLElement): Promise<Digest> {
  const base = lastOptions ?? readOptions();
  const options: AnalysisOptions = {
    ...base,
    bootstrap: { ...base.bootstrap, enabled: input.bootstrap, nboot: Math.min(base.bootstrap.nboot, 1000) },
    predict: { ...base.predict, enabled: input.predict, cvpat: input.predict, cvpatNboot: Math.min(base.predict.cvpatNboot, 500) },
    congruence: { ...base.congruence, enabled: false },
  };
  const started = Date.now();
  const result = await analyzeInWorker({ code: input.code, dataText: val("data"), dataName, options }, (stage) => {
    card.querySelector(".tool-stage")!.textContent = `${stage}…`;
    setWorking(`Testing alternative ${alternativeCount}: ${stage.toLowerCase()}`);
  });
  const digest = buildDigest(result, dataColumns, input.label);
  if (!digestLooksSafe(digest)) throw new Error("Digest safety check failed; nothing was sent.");
  alternativeRuns.set(input.label, { input, result });
  card.querySelector(".tool-stage")!.textContent = `done in ${((Date.now() - started) / 1000).toFixed(1)} s`;
  if (lastResult) card.querySelector(".tool-compare")!.innerHTML = `<div class="rule" style="margin:.4rem 0 .2rem">Compared with the model under review</div>${compareRuns(lastResult, result)}`;
  return digest;
}

async function evaluatorTurn(userText: string, opening: boolean) {
  const key = $<HTMLInputElement>("api-key").value.trim();
  if (!key) { evalStatus("Enter your Anthropic API key first."); return; }
  if (!lastResult) { evalStatus("Run an analysis first."); return; }
  if (evalBusy) return;
  saveKey(key, $<HTMLInputElement>("remember-key").checked);

  const m = await evaluatorModule();
  if (!evalSession || opening) {
    const digest = currentDigest();
    if (!digest || !digestLooksSafe(digest)) { evalStatus("Digest safety check failed; nothing was sent."); return; }
    evalSession = { messages: [], digest };
    $("eval-transcript").innerHTML = "";
    alternativeCount = 0;
    evalUsage.input = evalUsage.output = evalUsage.cacheRead = evalUsage.cacheWrite = 0;
  }
  const content = opening ? m.openingMessage(evalSession.digest, userText || undefined) : userText;
  appendTranscript(`<div class="who">You</div><p>${esc(opening ? (userText ? userText : "Evaluate this model and test the improvements you would recommend.") : userText)}</p>${opening ? '<p class="note">Sent with the aggregate digest shown under “What leaves the browser”.</p>' : ""}`, "user");

  // Test hook: a mock endpoint set by the headless harness. Never set in normal use.
  let testBase: string | undefined;
  try { testBase = localStorage.getItem("seminr-anthropic-base-url") ?? undefined; } catch { /* ignore */ }
  const client = m.createClient(key, testBase);
  evalBusy = true;
  evalAbort = new AbortController();
  $("eval-stop").classList.remove("hidden");
  $<HTMLButtonElement>("eval-send").disabled = true;
  $<HTMLButtonElement>("eval-start").disabled = true;
  evalStatus("Claude is reading the results…");

  let bubble: HTMLElement | null = null;
  let text = "";
  const flush = () => { if (bubble) bubble.querySelector(".body")!.innerHTML = mdToHtml(text); };
  try {
    if (opening) appendTranscript(`<div class="who">How this works</div><p class="note" style="margin:0">Claude reads the aggregate results first (this can take a minute), then usually tests a few alternative specifications on your data. Each test appears below as a numbered card while it runs here in your browser; your results above are not changed. The review follows when the tests are done.</p>`, "user");
    setWorking("Claude is reading your results");
    await m.runTurn(client, evalSession, content, (input) => {
      alternativeCount++;
      setWorking(`Testing alternative ${alternativeCount}: ${input.label}`);
      const card = appendTranscript(`<div class="who">Alternative ${alternativeCount} · run on your data at Claude's request</div><div class="tool-head"><strong>${esc(input.label)}</strong> <span class="tool-stage note">starting…</span></div><div class="tool-compare"></div><details><summary>SEMinR code Claude asked to run</summary><pre class="code"><code>${esc(input.code)}</code></pre></details><div class="tool-actions"></div>`, "tool");
      return runModelForAssistant(input, card).then((d) => {
        card.querySelector(".tool-stage")!.textContent = "done";
        const actions = card.querySelector(".tool-actions")!;
        const btn = document.createElement("button");
        btn.type = "button"; btn.className = "copy"; btn.textContent = "Load this model into the editor";
        btn.addEventListener("click", () => { $<HTMLTextAreaElement>("code").value = input.code; validateCode(); $("code").scrollIntoView({ behavior: "smooth", block: "center" }); });
        actions.appendChild(btn);
        bubble = null; text = "";
        return d;
      });
    }, {
      onText: (delta) => {
        if (!bubble) bubble = appendTranscript(`<div class="who">Claude</div><div class="body"></div>`, "assistant");
        text += delta;
        flush();
        setWorking("Claude is writing");
      },
      onToolStart: () => { evalStatus(""); },
      onToolEnd: (call) => { evalStatus(call.ok ? "" : `Run failed: ${call.summary}`); setWorking(call.ok ? "Claude is reading the alternative's results" : "Claude is continuing"); },
      onUsage: (u) => {
        evalUsage.input += u.input; evalUsage.output += u.output; evalUsage.cacheRead += u.cacheRead; evalUsage.cacheWrite += u.cacheWrite;
        $("eval-usage").textContent = `Tokens this session: ${(evalUsage.input + evalUsage.cacheRead + evalUsage.cacheWrite).toLocaleString()} in (${evalUsage.cacheRead.toLocaleString()} from cache), ${evalUsage.output.toLocaleString()} out.`;
      },
    }, evalAbort.signal);
    evalStatus("");
  } catch (err) {
    evalStatus(m.describeError(err));
  } finally {
    setWorking(null);
    evalBusy = false;
    evalAbort = null;
    $("eval-stop").classList.add("hidden");
    $<HTMLButtonElement>("eval-send").disabled = false;
    $<HTMLButtonElement>("eval-start").disabled = false;
  }
}

function mountEvaluator() {
  const key = loadKey();
  if (key) { $<HTMLInputElement>("api-key").value = key; $<HTMLInputElement>("remember-key").checked = !!localStorage.getItem(KEY_STORAGE); }
  $("eval-start").addEventListener("click", () => void evaluatorTurn(val("eval-question").trim(), true));
  $("eval-send").addEventListener("click", () => {
    const q = val("eval-question").trim();
    if (!q) return;
    $<HTMLTextAreaElement>("eval-question").value = "";
    void evaluatorTurn(q, !evalSession);
  });
  $("eval-question").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" && ((e as KeyboardEvent).metaKey || (e as KeyboardEvent).ctrlKey)) $("eval-send").click();
  });
  $("eval-stop").addEventListener("click", () => evalAbort?.abort());
  $("eval-show-digest").addEventListener("click", showDigestPreview);
  $("eval-forget").addEventListener("click", forgetKey);
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

async function loadDemo(key: string) {
  const demo = DEMOS[key];
  if (!demo) return;
  clearError();
  try {
    const d = await fetch(demo.file).then((x) => x.text());
    dataName = demo.dataName;
    $<HTMLTextAreaElement>("data").value = d.trim();
    $<HTMLTextAreaElement>("code").value = demo.code;
    $<HTMLInputElement>("missing-value").value = demo.missingValue;
    validateCode();
    $("code-status").textContent = `${$("code-status").textContent} ${demo.codeNote}`;
    describeOptions();
  } catch {
    showError("Could not load the demo values.");
  }
}

export function mount() {
  const validateCodeLive = debounce(validateCode, 250);
  const validateDataLive = debounce(() => { dataName = "pasted data"; validateData(); }, 250);

  $("run").addEventListener("click", () => run(false));
  $("quick").addEventListener("click", () => run(true));
  $("cancel").addEventListener("click", () => { worker?.terminate(); worker = null; setBusy(false); });
  $("data").addEventListener("input", validateDataLive);
  $("code").addEventListener("input", validateCodeLive);

  $<HTMLInputElement>("file").addEventListener("change", async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    dataName = f.name;
    $<HTMLTextAreaElement>("data").value = (await f.text()).trim();
    validateData();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-demo]").forEach((btn) =>
    btn.addEventListener("click", () => void loadDemo(btn.dataset.demo!)),
  );

  for (const id of OPTION_IDS) {
    document.getElementById(id)?.addEventListener("change", () => { describeOptions(); persist(); });
  }
  document.querySelectorAll('input[name="diagonal"]').forEach((el) => el.addEventListener("change", () => { describeOptions(); persist(); }));

  $("download-html").addEventListener("click", () => {
    if (!lastResult || !lastCtx) return;
    download(`${stem()}-pls-sem-report.html`, renderStandaloneReport(lastResult, lastCtx), "text/html");
  });
  $("download-json").addEventListener("click", () => {
    if (!lastResult) return;
    download(`${stem()}-pls-sem-results.json`, JSON.stringify(lastResult, null, 1), "application/json");
  });
  $("download-r").addEventListener("click", () => {
    if (!lastResult) return;
    download(`${stem()}-pls-sem.R`, lastResult.rScript, "text/plain");
  });
  $("download-svg").addEventListener("click", () => {
    if (!lastCtx?.svg) return;
    const svg = lastCtx.svg.boot ?? lastCtx.svg.model;
    if (svg) download(`${stem()}-model.svg`, svg, "image/svg+xml");
  });

  mountEvaluator();

  const restored = restore();
  const demo = new URLSearchParams(location.search).get("demo");
  if (demo && DEMOS[demo]) {
    void loadDemo(demo);
  } else if (restored) {
    validateCode();
  }
  describeOptions();
}
