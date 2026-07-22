/**
 * Parity + pipeline test for the congruence app.
 *
 * 1. R RNG parity — the Mersenne-Twister and the post-3.6.0 "Rejection"
 *    sampler must reproduce R 4.6.0's streams exactly, otherwise the bootstrap
 *    draws different rows and the CIs drift.
 * 2. Full-pipeline parity — parsing the shipped demo fixtures the same way the
 *    page does, then running the test, must reproduce the numbers that
 *    congruence_core.R produces for the same seed.
 *
 * Ground truth was generated with R 4.6.0:
 *   set.seed(123); runif(5) / sample.int(...)
 *   congruence_from_scores(scores, rhoA, nboot=2000, seed=123, alpha=0.05)
 *
 * Run:  npx tsx test/congruence-parity.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RRNG } from "../src/lib/congruence/rrng.ts";
import { congruenceFromScores } from "../src/lib/congruence/congruence.ts";
import { parseScores, parseRhoA, alignRhoA } from "../src/lib/congruence/parse.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;

function check(label, ok, detail = "") {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
console.log("\nR 4.6.0 RNG parity");
// ---------------------------------------------------------------------------
{
  let r = new RRNG(123);
  const u = [...Array(5)].map(() => r.unifRand());
  const expectU = [
    0.28757752012461424, 0.78830513544380665, 0.40897692181169987,
    0.88301740400493145, 0.9404672842938453,
  ];
  check("set.seed(123); runif(5)", u.every((v, i) => v === expectU[i]));

  r = new RRNG(123);
  const s = [...r.sampleIntReplace(10, 10)].map((i) => i + 1);
  check(
    "set.seed(123); sample.int(10,10,replace=TRUE)",
    s.join(" ") === "3 3 10 2 6 5 4 6 9 10",
    s.join(" "),
  );

  r = new RRNG(42);
  const u42 = [...Array(3)].map(() => r.unifRand());
  check(
    "set.seed(42); runif(3)",
    u42[0] === 0.91480604349635541 &&
      u42[1] === 0.93707541329786181 &&
      u42[2] === 0.28613953478634357,
  );

  r = new RRNG(123);
  const s344 = [...r.sampleIntReplace(344, 8)].map((i) => i + 1);
  check(
    "set.seed(123); sample.int(344,8,replace=TRUE)",
    s344.join(" ") === "179 14 195 306 118 299 229 244",
    s344.join(" "),
  );
}

// ---------------------------------------------------------------------------
console.log("\nFull-pipeline parity vs congruence_core.R (demo fixtures, seed 123, nboot 2000)");
// ---------------------------------------------------------------------------
{
  const demo = path.join(root, "public", "congruence-demo");
  const scoresText = fs.readFileSync(path.join(demo, "demo_scores.csv"), "utf8");
  const rhoaRaw = fs.readFileSync(path.join(demo, "demo_rhoA.csv"), "utf8");

  // Exactly the transformation the page's "Load example data" button applies.
  const rhoaText = rhoaRaw
    .trim()
    .split("\n")
    .slice(1)
    .map((l) => l.replace(/"/g, "").replace(",", "\t"))
    .join("\n");

  const parsed = parseScores(scoresText);
  check("parsed 6 constructs x 344 cases", parsed.names.length === 6 && parsed.n === 344,
    `${parsed.names.length} x ${parsed.n}`);

  const rhoA = alignRhoA(parsed.names, parseRhoA(rhoaText));
  const res = congruenceFromScores(parsed.names, parsed.columns, rhoA, {
    nboot: 2000, seed: 123, alpha: 0.05, threshold: 1,
  });

  // From R: congruence_from_scores(...) — estimate, bootSD, ciLo, ciHi
  const truth = {
    "QUAL -> PERF": [0.98626729248907152, 0.0040601579356875197, 0.97619846988242465, 0.99182557978191088],
    "QUAL -> CSOR": [0.96705930038892585, 0.0077251251809401199, 0.94816852558082521, 0.97873387955077007],
    "QUAL -> ATTR": [0.96695511868807982, 0.0099104725394689366, 0.94271973791851249, 0.98109645371589149],
    "QUAL -> COMP": [0.99496572427920349, 0.0023590104250541008, 0.98843687803969704, 0.99773250357030119],
    "QUAL -> LIKE": [0.98640509563164791, 0.0052253844165624282, 0.97319097219613382, 0.99326280921851451],
    "PERF -> CSOR": [0.95275505777528491, 0.011317456946808914, 0.92615513461192334, 0.9699053857870803],
    "PERF -> ATTR": [0.96263085973826801, 0.0092925525997246457, 0.93945014844709707, 0.97659072583465256],
    "PERF -> COMP": [0.99103079246723258, 0.0039551691504779536, 0.98049604487047437, 0.99589561061231624],
    "PERF -> LIKE": [0.97461640143321815, 0.0086921849044486622, 0.95347700311372596, 0.98663325534250435],
    "CSOR -> ATTR": [0.94385986161985513, 0.013313592215309157, 0.91170716930768192, 0.96382812984784594],
    "CSOR -> COMP": [0.96213228015955221, 0.010783355245607175, 0.93658188388429475, 0.97788891415685764],
    "CSOR -> LIKE": [0.96599742274726386, 0.010037652261751002, 0.94124252946548415, 0.98030385731891823],
    "ATTR -> COMP": [0.96830178586637794, 0.010890542275353413, 0.94087837402069308, 0.98332991265083414],
    "ATTR -> LIKE": [0.96575895392064559, 0.010488393558056818, 0.93922898541365318, 0.98068277062566123],
    "COMP -> LIKE": [0.98694907577555846, 0.0061775091060845139, 0.97080954876439163, 0.99480398984546869],
  };

  const TOL = 1e-12; // relative; observed worst case is ~2e-15 (floating-point summation order)
  let worst = 0;
  let worstAt = "";
  check("15 construct pairs returned", res.rows.length === 15, String(res.rows.length));

  for (const row of res.rows) {
    const t = truth[row.pair];
    if (!t) { check(`unexpected pair ${row.pair}`, false); continue; }
    const got = [row.estimate, row.bootSD, row.ciLo, row.ciHi];
    got.forEach((g, i) => {
      const rel = Math.abs(g - t[i]) / Math.max(Math.abs(t[i]), 1e-300);
      if (rel > worst) { worst = rel; worstAt = `${row.pair}[${["est","sd","lo","hi"][i]}]`; }
    });
  }
  check(`all values within ${TOL} relative of R`, worst < TOL,
    `worst ${worst.toExponential(3)} at ${worstAt}`);
}

console.log(failures === 0 ? "\nAll parity checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
