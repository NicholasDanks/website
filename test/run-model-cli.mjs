/**
 * Command-line stand-in for the assistant's run_model tool, so a reviewer
 * without an API tool loop (e.g. a Claude Code subagent) can test alternative
 * specifications exactly as the page does: estimate locally, return the
 * aggregate digest, never the data.
 *
 * Usage:
 *   npx tsx test/run-model-cli.mjs --label "drop qual_4" --code-file spec.R [--bootstrap] [--predict] [--demo corp-rep]
 *   npx tsx test/run-model-cli.mjs --label "..." --code 'mm <- constructs(...)\nsm <- relationships(...)' --bootstrap
 * Prints the digest as JSON on stdout (or {"error": "..."}).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalysis } from "../src/lib/seminr/analyze.ts";
import { parseDataText } from "../src/lib/seminr/data.ts";
import { buildDigest, digestLooksSafe } from "../src/lib/seminr/digest.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const flag = (name) => args.includes(`--${name}`);
const label = opt("label", "alternative");
const code = opt("code-file") ? fs.readFileSync(opt("code-file"), "utf8") : (opt("code", "") ?? "").replace(/\\n/g, "\n");
if (!code.trim()) { console.log(JSON.stringify({ error: "no code given (--code or --code-file)" })); process.exit(1); }

const dataText = fs.readFileSync(path.join(root, "public", "seminr-demo", "corp_rep_data.csv"), "utf8");
const dataColumns = parseDataText(dataText).data.columns;
const options = {
  estimation: { innerWeights: "path_weighting", missing: "mean_replacement", missingValue: -99 },
  bootstrap: { enabled: flag("bootstrap"), nboot: 1000, seed: 123, alpha: 0.05 },
  predict: { enabled: flag("predict"), noFolds: 10, technique: "predict_DA", seed: 123, cvpat: flag("predict"), cvpatNboot: 500 },
  congruence: { enabled: false, nboot: 500, seed: 123, alpha: 0.05, threshold: 1, diagonal: "rhoA" },
};
try {
  const result = await runAnalysis({ code, dataText, dataName: "corp_rep_data.csv", options });
  const digest = buildDigest(result, dataColumns, label, { compact: !flag("verbose-digest") });
  if (!digestLooksSafe(digest)) throw new Error("Digest safety check failed; nothing was returned.");
  const dir = opt("save-dir");
  if (dir) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${label.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(digest)); }
  console.log(JSON.stringify(digest));
} catch (err) {
  console.log(JSON.stringify({ error: `The run failed: ${err instanceof Error ? err.message : String(err)}` }));
  process.exit(1);
}
