/**
 * Audit a review written outside the harness (e.g. by a Claude Code subagent)
 * with the same checks test/model-compare.mjs applies.
 *
 *   npx tsx test/audit-review.mjs --review path/to/review.md --demo corp-rep [--runs dir-with-run-digests] [--digest digest.json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit, auditLines } from "./review-audit.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const demo = opt("demo", "corp-rep");
const review = fs.readFileSync(opt("review"), "utf8").split(/\n## Audit\n/)[0];
const digestFile = opt("digest", path.join(root, "test", "tmp", "model-compare", `digest-${demo}-1000.json`));
const grounding = [fs.readFileSync(digestFile, "utf8")];
const runs = opt("runs");
if (runs && fs.existsSync(runs)) for (const f of fs.readdirSync(runs)) if (f.endsWith(".json")) grounding.push(fs.readFileSync(path.join(runs, f), "utf8"));
const a = audit(review, grounding.join("\n"), demo);
console.log(auditLines(a).join("\n"));
