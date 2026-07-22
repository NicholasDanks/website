/**
 * R RNG parity.
 *
 * The congruence bootstrap resamples rows, so its confidence intervals depend
 * on the exact stream of random indices. Reproducing R's Mersenne-Twister and
 * its post-3.6.0 "Rejection" discrete sampler bit-for-bit means `set.seed(123)`
 * in R and `new RRNG(123)` here resample the SAME rows — which is what makes
 * the app's numbers identical to R's rather than merely close.
 *
 * Ground truth from R 4.6.0.
 *
 * Run:  npx tsx test/rng-parity.mjs
 */

import { RRNG } from "../src/lib/congruence/rrng.ts";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("\nR 4.6.0 RNG parity");

let r = new RRNG(123);
const u = [...Array(5)].map(() => r.unifRand());
check("set.seed(123); runif(5)", u.every((v, i) => v === [
  0.28757752012461424, 0.78830513544380665, 0.40897692181169987,
  0.88301740400493145, 0.9404672842938453,
][i]));

r = new RRNG(123);
const s = [...r.sampleIntReplace(10, 10)].map((i) => i + 1).join(" ");
check("set.seed(123); sample.int(10,10,replace=TRUE)", s === "3 3 10 2 6 5 4 6 9 10", s);

r = new RRNG(42);
const u42 = [...Array(3)].map(() => r.unifRand());
check("set.seed(42); runif(3)",
  u42[0] === 0.91480604349635541 && u42[1] === 0.93707541329786181 &&
  u42[2] === 0.28613953478634357);

r = new RRNG(123);
const s344 = [...r.sampleIntReplace(344, 8)].map((i) => i + 1).join(" ");
check("set.seed(123); sample.int(344,8,replace=TRUE)",
  s344 === "179 14 195 306 118 299 229 244", s344);

console.log(failures === 0 ? "\nAll RNG parity checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
