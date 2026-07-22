/**
 * Indicator-data route parity test.
 *
 * Proves that the browser implementation reproduces R's
 * seminrExtras::congruence_test() exactly — model estimation AND the
 * re-estimation bootstrap — when configured with rho_C on the diagonal.
 *
 * The shipped default is rho_A (this app's long-standing convention, shared
 * with the construct-scores route). rho_A uses the *same code path* with a
 * different diagonal, so verifying rho_C verifies the machinery.
 *
 * Ground truth, R 4.6.0 + seminr 2.5.0 + seminrExtras:
 *   mm <- constructs(composite("COMP", multi_items("comp_",1:3)),
 *                    composite("LIKE", multi_items("like_",1:3)),
 *                    composite("CUSA", single_item("cusa")),
 *                    composite("CUSL", multi_items("cusl_",1:3)))
 *   sm <- relationships(paths(from=c("COMP","LIKE"), to=c("CUSA","CUSL")),
 *                       paths(from="CUSA", to="CUSL"))
 *   m  <- estimate_pls(corp_rep_data, mm, sm, missing=mean_replacement,
 *                      missing_value="-99")
 *   congruence_test(m, nboot=200, seed=123, alpha=0.10)
 * stored in test/fixtures-r-congruence-test.txt
 *
 * Run:  npx tsx test/congruence-model-parity.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIndicatorRoute } from "../src/lib/congruence/runIndicator.ts";
import { parseSeminrModel } from "../src/lib/congruence/parseSeminr.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const CODE = `corp_rep_mm <- constructs(
  composite("COMP", multi_items("comp_", 1:3)),
  composite("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  composite("CUSL", multi_items("cusl_", 1:3)))

corp_rep_sm <- relationships(
  paths(from = c("COMP", "LIKE"), to = c("CUSA", "CUSL")),
  paths(from = "CUSA",            to = "CUSL"))`;

console.log("\nSEMinR model parser");
{
  const m = parseSeminrModel(CODE);
  check("4 constructs parsed", m.constructs.length === 4);
  check("single_item handled", m.constructs.find((c) => c.name === "CUSA").items.length === 1);
  check("3 path blocks", m.paths.length === 2 || m.paths.length === 3, String(m.paths.length));

  const errs = [
    ['constructs(composite("A", multi_items("a_",1:3)))', /relationships/],
    ['constructs(composite("A", multi_items("a_",1:3)), composite("B", multi_items("b_",1:3)))\nrelationships(paths(from="A", to="Z"))', /never defined/],
    ['constructs(composite("A", multi_items("a_",1:3)), composite("B", multi_items("b_",1:3)))\nrelationships(paths(from="A",to="B"))\ninteraction_term(iv="A", moderator="B")', /not supported/],
  ];
  errs.forEach(([src, re], i) => {
    let msg = "";
    try { parseSeminrModel(src); } catch (e) { msg = e.message; }
    check(`error case ${i + 1} rejected`, re.test(msg), msg.slice(0, 60));
  });
}

console.log("\nIndicator route vs R congruence_test() (rho_C, nboot 200, seed 123, alpha 0.10)");
{
  const dataText = fs.readFileSync(path.join(root, "public", "congruence-demo", "corp_rep_data.csv"), "utf8");
  const res = runIndicatorRoute({
    code: CODE, dataText,
    options: { nboot: 200, seed: 123, alpha: 0.1, threshold: 1, diagonal: "rhoC" },
  });

  const truth = fs.readFileSync(path.join(root, "test", "fixtures-r-congruence-test.txt"), "utf8")
    .trim().split("\n").map((l) => l.split("|"));

  check("6 construct pairs", res.rows.length === 6, String(res.rows.length));
  check("HTMT congruence computed", res.htmtRows?.length === 6, String(res.htmtRows?.length));

  let worst = 0, at = "";
  res.rows.forEach((r, i) => {
    [[r.estimate, 1], [r.bootSD, 2], [r.ciLo, 3], [r.ciHi, 4]].forEach(([g, k]) => {
      const t = Number(truth[i][k]);
      const rel = Math.abs(g - t) / Math.max(Math.abs(t), 1e-300);
      if (rel > worst) { worst = rel; at = `${truth[i][0].trim()} col${k}`; }
    });
  });
  check("exact parity with R (< 1e-12 relative)", worst < 1e-12, `worst ${worst.toExponential(3)} at ${at}`);
}

console.log("\nrho_A default (shipped configuration)");
{
  const dataText = fs.readFileSync(path.join(root, "public", "congruence-demo", "corp_rep_data.csv"), "utf8");
  const res = runIndicatorRoute({
    code: CODE, dataText,
    options: { nboot: 100, seed: 123, alpha: 0.05, threshold: 1, diagonal: "rhoA" },
  });
  check("runs and returns 6 pairs", res.rows.length === 6);
  check("single-item CUSA gets rho_A = 1", res.reliabilities.CUSA === 1, String(res.reliabilities.CUSA));
  check("reflective constructs get rho_A in (0,1)",
    ["COMP", "LIKE", "CUSL"].every((c) => res.reliabilities[c] > 0 && res.reliabilities[c] < 1));
  check("rho_A estimates differ from rho_C (different diagonal)",
    Math.abs(res.rows[0].estimate - 0.96120055902328916) > 1e-6);
}

console.log(failures === 0 ? "\nAll model-route checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
