/**
 * Compare review quality and cost across Claude models on one demo model.
 *
 * Runs the full pipeline in Node (in-thread bootstrap), builds the same
 * digest the page would send, then drives the evaluator loop once per model
 * with an identical opening message. run_model calls are executed locally,
 * as the page does. Output: one transcript per model, a JSON record of
 * usage / cost / timing, and summary.md with an objective audit:
 *
 *   - ungrounded numbers: decimals in the review that appear in neither the
 *     digests sent nor the system prompt (crude fabrication signal; derived
 *     figures such as differences will also show up here, so read the list)
 *   - directive phrasing the prompt forbids ("you must", "drop", …)
 *   - coverage of the assessment areas the prompt asks for
 *   - tool calls that failed to run
 *
 * Substantive correctness still needs a human read of the transcripts.
 *
 * Run (Gemini free tier bills nothing; Claude models spend real money on your key):
 *   GEMINI_API_KEY=… npx tsx test/model-compare.mjs
 *   GEMINI_API_KEY=… npx tsx test/model-compare.mjs --models gemini-3.8-flash --repeat 2
 *   GEMINI_API_KEY=… npx tsx test/model-compare.mjs --demo moderation --question "Is SC a sound moderator?"
 *   GEMINI_API_KEY=… npx tsx test/model-compare.mjs --verbose-digest --prompt-file /path/prompt.txt   (A/B the old digest form or a prompt variant)
 *   ANTHROPIC_API_KEY=… npx tsx test/model-compare.mjs --models claude-sonnet-5   (see test/anthropic-transport.mjs)
 * Dry run against the mock endpoint (no key needed):
 *   node test/mock-gemini.mjs &  GEMINI_API_KEY=x GEMINI_BASE_URL=http://127.0.0.1:9445 npx tsx test/model-compare.mjs --models gemini-3.8-flash
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalysis } from "../src/lib/seminr/analyze.ts";
import { parseDataText } from "../src/lib/seminr/data.ts";
import { buildDigest, digestLooksSafe } from "../src/lib/seminr/digest.ts";
import { EVALUATOR_MODELS, GEMINI_ENDPOINT, SYSTEM_PROMPT, estimateCost, evaluatorModel, openingMessage, runTurn } from "../src/lib/seminr/evaluator.ts";
import { ANTHROPIC_MODELS, anthropicCost, runAnthropicTurn } from "./anthropic-transport.mjs";
import { AREAS, audit, auditLines } from "./review-audit.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const models = opt("models", EVALUATOR_MODELS.map((m) => m.id).join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const demoKey = opt("demo", "corp-rep");
const nboot = Number(opt("nboot", "1000"));
const repeat = Number(opt("repeat", "1"));
const question = opt("question", undefined);
const compact = !args.includes("--verbose-digest"); // the page sends the compact form; --verbose-digest reproduces the old one
const promptFile = opt("prompt-file");
const thinking = opt("thinking");
const systemPrompt = promptFile ? fs.readFileSync(promptFile, "utf8") : SYSTEM_PROMPT;
const outDir = opt("out", path.join(root, "test", "tmp", "model-compare", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));

const isGemini = (id) => id.startsWith("gemini");
if (models.some((m) => !isGemini(m)) && !process.env.ANTHROPIC_API_KEY) { console.error("Set ANTHROPIC_API_KEY for Claude models (or ANTHROPIC_BASE_URL to a mock plus any key)."); process.exit(1); }
if (models.some(isGemini) && !process.env.GEMINI_API_KEY) { console.error("Set GEMINI_API_KEY (or GEMINI_BASE_URL to a mock plus any key)."); process.exit(1); }

const DEMOS = {
  "corp-rep": `corp_rep_mm <- constructs(
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
  moderation: `corp_rep_mm_mod <- constructs(
  composite("COMP", multi_items("comp_", 1:3)),
  composite("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  composite("SC",   multi_items("switch_", 1:4)),
  composite("CUSL", multi_items("cusl_", 1:3)),
  interaction_term(iv = "CUSA", moderator = "SC", method = two_stage))
corp_rep_sm_mod <- relationships(
  paths(from = c("COMP", "LIKE"),          to = c("CUSA", "CUSL")),
  paths(from = c("CUSA", "SC", "CUSA*SC"), to = c("CUSL")))`,
};
if (!DEMOS[demoKey]) { console.error(`Unknown demo ${demoKey}`); process.exit(1); }

const dataText = fs.readFileSync(path.join(root, "public", "seminr-demo", "corp_rep_data.csv"), "utf8");
const dataColumns = parseDataText(dataText).data.columns;
const baseOptions = {
  estimation: { innerWeights: "path_weighting", missing: "mean_replacement", missingValue: -99 },
  bootstrap: { enabled: true, nboot, seed: 123, alpha: 0.05 },
  predict: { enabled: true, noFolds: 10, technique: "predict_DA", seed: 123, cvpat: true, cvpatNboot: Math.min(500, nboot) },
  congruence: { enabled: true, nboot: Math.min(500, nboot), seed: 123, alpha: 0.05, threshold: 1, diagonal: "rhoA" },
};

fs.mkdirSync(outDir, { recursive: true });
const log = (s) => { process.stdout.write(s + "\n"); };

// --- the model under review (cached per demo/nboot so reruns are cheap) ------
const cacheFile = path.join(root, "test", "tmp", "model-compare", `digest-${demoKey}-${nboot}${compact ? "-compact" : ""}.json`);
let digest;
if (fs.existsSync(cacheFile)) {
  digest = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  log(`digest: reused ${path.relative(root, cacheFile)}`);
} else {
  const t0 = Date.now();
  const result = await runAnalysis({ code: DEMOS[demoKey], dataText, dataName: "corp_rep_data.csv", options: baseOptions }, {
    onStage: (id, status) => { if (status === "done") process.stdout.write(`  ${id} `); },
  });
  digest = buildDigest(result, dataColumns, "current model", { compact });
  log(`\ndigest: built in ${((Date.now() - t0) / 1000).toFixed(1)} s (${JSON.stringify(digest).length} chars)`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(digest));
}
if (!digestLooksSafe(digest)) throw new Error("digest safety check failed");

/** What the page does for a run_model call: bootstrap capped, congruence off. */
async function runModel(input) {
  const options = {
    ...baseOptions,
    bootstrap: { ...baseOptions.bootstrap, enabled: input.bootstrap, nboot: Math.min(baseOptions.bootstrap.nboot, 1000) },
    predict: { ...baseOptions.predict, enabled: input.predict, cvpat: input.predict, cvpatNboot: Math.min(baseOptions.predict.cvpatNboot, 500) },
    congruence: { ...baseOptions.congruence, enabled: false },
  };
  const result = await runAnalysis({ code: input.code, dataText, dataName: "corp_rep_data.csv", options });
  const d = buildDigest(result, dataColumns, input.label, { compact });
  if (!digestLooksSafe(d)) throw new Error("Digest safety check failed; nothing was sent.");
  return d;
}

// --- run ----------------------------------------------------------------------
const opening = openingMessage(digest, question);
const records = [];
for (const modelId of models) {
  const gemini = isGemini(modelId);
  const model = gemini ? evaluatorModel(modelId) : null;
  if (!gemini && !ANTHROPIC_MODELS[modelId]) { log(`skip ${modelId}: not in ANTHROPIC_MODELS`); continue; }
  for (let r = 1; r <= repeat; r++) {
    const tag = repeat > 1 ? `${modelId}-r${r}` : modelId;
    log(`\n=== ${tag} ===`);
    const session = { contents: [], digest };
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thoughts: 0 };
    const turns = [];
    let current = "";
    const tools = [];
    const grounding = [JSON.stringify(digest)];
    const flush = () => { if (current.trim()) turns.push({ type: "text", text: current }); current = ""; };
    const t0 = Date.now();
    let error = null;
    const runModelTracked = async (input) => {
      const d = await runModel(input);
      grounding.push(JSON.stringify(d));
      return d;
    };
    const events = {
      onText: (delta) => { current += delta; },
      onToolStart: (call) => { flush(); log(`  run_model: ${call.input.label}`); },
      onToolEnd: (call) => { tools.push({ label: call.input.label, code: call.input.code ?? "", bootstrap: call.input.bootstrap, predict: call.input.predict, ok: call.ok, summary: call.summary }); turns.push({ type: "tool", ...tools[tools.length - 1] }); log(`    ${call.ok ? "ok" : "FAILED"}: ${call.summary}`); },
      onUsage: (u) => { usage.input += u.input; usage.output += u.output; usage.cacheRead += u.cacheRead; usage.cacheWrite += u.cacheWrite; usage.thoughts += u.thoughts ?? 0; },
    };
    try {
      if (gemini) {
        await runTurn(process.env.GEMINI_API_KEY, session, opening, runModelTracked, events, undefined, modelId, process.env.GEMINI_BASE_URL || GEMINI_ENDPOINT, systemPrompt, thinking || undefined);
      } else {
        await runAnthropicTurn({ model: modelId, apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, opening, runModel: runModelTracked, events, systemPrompt });
      }
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log(`  ERROR ${error}`);
    }
    flush();
    const seconds = (Date.now() - t0) / 1000;
    const reviewText = turns.filter((t) => t.type === "text").map((t) => t.text).join("\n\n");
    const a = audit(reviewText, grounding.join("\n") + "\n" + systemPrompt, demoKey);
    fs.writeFileSync(path.join(outDir, `${tag}-runs.json`), JSON.stringify(grounding.slice(1).map((g) => JSON.parse(g))));
    const cost = (gemini ? estimateCost(usage, model) : anthropicCost(usage, modelId)) ?? 0;
    const rec = { tag, model: modelId, demo: demoKey, compact, promptFile: promptFile ?? null, question: question ?? null, seconds, usage, cost, toolRuns: tools.length, toolFailures: tools.filter((t) => !t.ok).length, error, audit: a };
    records.push(rec);
    fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify(rec, null, 2));
    const md = [
      `# ${tag}`, "",
      `Demo: ${demoKey} · ${seconds.toFixed(0)} s · ${tools.length} run_model calls · tokens in ${usage.input + usage.cacheRead + usage.cacheWrite} (cache read ${usage.cacheRead}) · out ${usage.output} · est. US$${cost.toFixed(3)}`,
      error ? `\n**Error:** ${error}` : "", "",
      ...turns.map((t) => t.type === "text" ? t.text : `\n> **run_model: ${t.label}** (bootstrap ${t.bootstrap}, predict ${t.predict}) — ${t.ok ? "ok" : "FAILED"}: ${t.summary}\n>\n> \`\`\`r\n> ${t.code.replace(/\n/g, "\n> ")}\n> \`\`\`\n`),
      "", "---", "", "## Audit", "",
      ...auditLines(a),
    ].join("\n");
    fs.writeFileSync(path.join(outDir, `${tag}.md`), md);
    log(`  done: ${seconds.toFixed(0)} s, US$${cost.toFixed(3)}, ${a.words} words, ${a.ungrounded.length} ungrounded, ${a.directive.length} directive${a.score ? `, rubric ${a.score.hits.length}/${a.score.hits.length + a.score.misses.length} (${a.score.errors.length} errors)` : ""}`);
  }
}

// --- summary ------------------------------------------------------------------
const areaKeys = Object.keys(AREAS);
const rows = records.map((r) => `| ${r.tag} | ${r.error ? "error" : "ok"} | ${r.seconds.toFixed(0)} | ${r.toolRuns}${r.toolFailures ? ` (${r.toolFailures} failed)` : ""} | ${(r.usage.input + r.usage.cacheRead + r.usage.cacheWrite).toLocaleString()} | ${r.usage.output.toLocaleString()} (${r.usage.thoughts.toLocaleString()} thinking) | ${r.cost.toFixed(3)} | ${r.audit.words} | ${r.audit.citedNumbers} | ${r.audit.ungrounded.length} | ${r.audit.directive.length} | ${r.audit.latex} | ${areaKeys.filter((k) => r.audit.coverage[k]).length}/${areaKeys.length} | ${r.audit.score ? `${r.audit.score.hits.length}/${r.audit.score.hits.length + r.audit.score.misses.length} −${r.audit.score.errors.length}` : "n/a"} |`);
const summary = [
  `# Model comparison — ${demoKey}${compact ? " — compact digest" : ""}${thinking ? ` — thinking ${thinking}` : ""}${promptFile ? ` — prompt ${path.basename(promptFile)}` : ""}${question ? ` — "${question}"` : ""}`, "",
  `Same digest and opening message for every run. Cost is estimated at list prices from the usage the API reported (Gemini: paid-tier prices; the free tier bills nothing).`, "",
  "| run | status | s | run_model | tokens in | tokens out | US$ | words | numbers | ungrounded | directive | latex | coverage | rubric |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows, "",
  "Ungrounded = decimals in the review not found (to 0–3 dp) in any digest sent or in the system prompt. Derived figures (differences, ratios) count as ungrounded, so open the transcript before calling it a fabrication.", "",
  "Coverage areas: " + areaKeys.join(", ") + ".", "",
  ...records.map((r) => `- ${r.tag}: coverage missing ${areaKeys.filter((k) => !r.audit.coverage[k]).join(", ") || "nothing"}${r.audit.ungrounded.length ? `; ungrounded ${r.audit.ungrounded.join(", ")}` : ""}${r.audit.directive.length ? `; directive "${r.audit.directive.join('", "')}"` : ""}${r.audit.score?.misses.length ? `; rubric missed: ${r.audit.score.misses.join("; ")}` : ""}${r.audit.score?.errors.length ? `; rubric errors: ${r.audit.score.errors.join("; ")}` : ""}`),
].join("\n");
fs.writeFileSync(path.join(outDir, "summary.md"), summary);
log(`\nwrote ${path.relative(root, outDir)}/summary.md`);
log(summary);
