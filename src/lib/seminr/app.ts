/**
 * Client-side wiring for the /seminr/ page: gather inputs, run the analysis
 * in a worker, render the results, draw the path diagrams with wasm Graphviz,
 * and offer downloads. No network requests are made except for the demo
 * dataset, and only when the user asks for it.
 */

import type { AnalysisResult, AnalysisOptions, StageId, StageStatus } from "./analyze";
import type { WorkerMessage, WorkerRequest } from "./worker";
import { renderSections, renderStandaloneReport, REPORT_CSS, esc, type RenderContext } from "./report";

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

let worker: Worker | null = null;
let lastResult: AnalysisResult | null = null;
let lastCtx: RenderContext | null = null;
let dataName = "pasted data";

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

function readOptions(): AnalysisOptions {
  const missingRaw = val("missing-value").trim();
  return {
    estimation: {
      innerWeights: val("inner-weights") as "path_weighting" | "path_factorial",
      missing: val("missing") as "mean_replacement" | "na_omit",
      missingValue: missingRaw === "" ? undefined : Number(missingRaw),
    },
    bootstrap: {
      enabled: checked("boot-enabled"),
      nboot: Math.max(50, Math.min(10000, Math.round(num("nboot", 2000)))),
      seed: Math.round(num("seed", 123)),
      alpha: Math.min(0.5, Math.max(0.001, num("alpha", 0.05))),
    },
    predict: {
      enabled: checked("predict-enabled"),
      noFolds: Math.max(2, Math.round(num("folds", 10))),
      technique: val("technique") as "predict_DA" | "predict_EA",
      seed: Math.round(num("seed", 123)),
      cvpat: checked("cvpat-enabled"),
      cvpatNboot: Math.max(50, Math.min(5000, Math.round(num("cvpat-nboot", 1000)))),
    },
    congruence: {
      enabled: checked("congruence-enabled"),
      nboot: Math.max(50, Math.min(10000, Math.round(num("congruence-nboot", 1000)))),
      seed: Math.round(num("seed", 123)),
      alpha: Math.min(0.5, Math.max(0.001, num("alpha", 0.05))),
      threshold: Math.min(1, Math.max(0.5, num("congruence-threshold", 1))),
      diagonal: (document.querySelector('input[name="diagonal"]:checked') as HTMLInputElement)?.value === "rhoC" ? "rhoC" : "rhoA",
    },
  };
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
  $("run").textContent = busy ? "Running…" : "Run the analysis";
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
    const svg = { model: gv.dot(result.model.dot), boot: result.model.dotBoot ? gv.dot(result.model.dotBoot) : undefined };
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

function run() {
  clearError();
  const code = val("code");
  const dataText = val("data");
  if (!dataText.trim()) return showError("Paste or upload your indicator data first.");
  if (!code.trim()) return showError("Paste your SEMinR model code first.");

  const req: WorkerRequest = { code, dataText, dataName, options: readOptions() };
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
      $("elapsed").textContent = `Finished in ${((Date.now() - started) / 1000).toFixed(1)} s.`;
      renderResults(m.result);
    } else {
      setBusy(false);
      showError(m.message);
    }
  };
  worker.onerror = (err) => { setBusy(false); showError(err.message || "The analysis failed."); };
  worker.postMessage(req);
}

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

function describeData() {
  const text = val("data").trim();
  const status = $("data-status");
  if (!text) { status.textContent = ""; return; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const d = lines[0].includes("\t") ? "\t" : (lines[0].match(/;/g) ?? []).length > (lines[0].match(/,/g) ?? []).length ? ";" : ",";
  const cols = lines[0].split(d).length;
  status.textContent = `${dataName}: ${lines.length - 1} rows × ${cols} columns (${d === "\t" ? "tab" : d === ";" ? "semicolon" : "comma"}-separated).`;
}

const DEMO_CODE = `# Corporate reputation model (Hair et al., PLS-SEM Using R, Ch. 5-6)
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
  paths(from = "CUSA",                            to = "CUSL"))`;

export function mount() {
  $("run").addEventListener("click", run);
  $("cancel").addEventListener("click", () => { worker?.terminate(); worker = null; setBusy(false); });
  $("data").addEventListener("input", () => { dataName = "pasted data"; describeData(); });

  $<HTMLInputElement>("file").addEventListener("change", async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    dataName = f.name;
    $<HTMLTextAreaElement>("data").value = (await f.text()).trim();
    describeData();
  });

  $("demo").addEventListener("click", async () => {
    clearError();
    try {
      const d = await fetch("/seminr-demo/corp_rep_data.csv").then((x) => x.text());
      dataName = "corp_rep_data.csv";
      $<HTMLTextAreaElement>("data").value = d.trim();
      $<HTMLTextAreaElement>("code").value = DEMO_CODE;
      $<HTMLInputElement>("missing-value").value = "-99";
      describeData();
      $("code-status").textContent = "Demo model: the full corporate reputation model from the textbook, with four formative drivers.";
    } catch {
      showError("Could not load the demo values.");
    }
  });

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
    if (!lastCtx?.svg?.model) return;
    download(`${stem()}-model.svg`, lastCtx.svg.model, "image/svg+xml");
  });
}
