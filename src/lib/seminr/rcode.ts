/**
 * Emit an R script that reproduces the analysis with seminr / seminrExtras, so
 * a browser run is never a dead end: the same model and options in R.
 */

import type { ParsedModel, ParsedMeasurement } from "./parseSeminr";
import type { AnalysisOptions } from "./analyze";

function q(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Collapse `stub1, stub2, stub3` into multi_items("stub", 1:3) where possible. */
function itemsExpr(items: string[]): string {
  if (items.length === 1) return `single_item(${q(items[0])})`;
  const m = items.map((it) => /^(.*?)(\d+)$/.exec(it));
  if (m.every((x) => x !== null)) {
    const stub = m[0]![1];
    const nums = m.map((x) => Number(x![2]));
    if (m.every((x) => x![1] === stub)) {
      const consecutive = nums.every((v, i) => i === 0 || v === nums[i - 1] + 1);
      if (consecutive) return `multi_items(${q(stub)}, ${nums[0]}:${nums[nums.length - 1]})`;
      return `multi_items(${q(stub)}, c(${nums.join(", ")}))`;
    }
  }
  return `c(${items.map(q).join(", ")})`;
}

function measurementLine(m: ParsedMeasurement): string {
  switch (m.kind) {
    case "construct": {
      if (m.reflective) return `reflective(${q(m.name)}, ${itemsExpr(m.items)})`;
      const w = m.weights === "mode_A" ? "" : `, weights = ${m.weights}`;
      return `composite(${q(m.name)}, ${itemsExpr(m.items)}${w})`;
    }
    case "higher_composite":
      return `higher_composite(${q(m.name)}, dimensions = c(${m.dimensions.map(q).join(", ")}), method = ${m.method}, weights = ${m.weights})`;
    case "interaction":
      return m.quadratic
        ? `quadratic_term(iv = ${q(m.iv)}, method = ${m.method}, weights = ${m.weights})`
        : `interaction_term(iv = ${q(m.iv)}, moderator = ${q(m.moderator)}, method = ${m.method}, weights = ${m.weights})`;
  }
}

function pathsLine(p: { from: string[]; to: string[] }): string {
  const vec = (v: string[]) => (v.length === 1 ? q(v[0]) : `c(${v.map(q).join(", ")})`);
  return `paths(from = ${vec(p.from)}, to = ${vec(p.to)})`;
}

export function generateRScript(parsed: ParsedModel, options: AnalysisOptions, dataName = "your_data.csv"): string {
  const est = options.estimation;
  const lines: string[] = [];
  lines.push(
    "# Reproduces the browser analysis in R with seminr.",
    "# install.packages(c(\"seminr\", \"seminrExtras\"))",
    "library(seminr)",
    "",
    `data <- read.csv(${q(dataName.endsWith(".csv") ? dataName : "your_data.csv")})`,
    "",
    "mm <- constructs(",
    ...parsed.measurement.map((m, i, arr) => `  ${measurementLine(m)}${i < arr.length - 1 ? "," : ""}`),
    ")",
    "",
    "sm <- relationships(",
    ...parsed.paths.map((p, i, arr) => `  ${pathsLine(p)}${i < arr.length - 1 ? "," : ""}`),
    ")",
    "",
    "model <- estimate_pls(",
    "  data = data, measurement_model = mm, structural_model = sm,",
    `  inner_weights = ${est.innerWeights},`,
    `  missing = ${est.missing === "na_omit" ? "na.omit" : "mean_replacement"},`,
    `  missing_value = ${est.missingValue === undefined ? "NULL" : q(String(est.missingValue))}`,
    ")",
    "model_summary <- summary(model)",
    "model_summary$paths",
    "model_summary$reliability",
    "model_summary$validity$htmt",
    "model_summary$fSquare",
    "plot(model)",
    "",
    "# Ch. 4.2 unidimensionality (psych + paran), Ch. 5.3.1 redundancy analysis and",
    "# Ch. 8.2 effect sizes follow the chapter demo scripts shipped with seminrExtras:",
    "#   demo(package = \"seminrExtras\")",
  );
  if (options.bootstrap.enabled) {
    lines.push(
      "",
      "# Bootstrap. R draws its resamples on a parallel RNG stream, so intervals",
      "# agree with the browser to Monte Carlo error, not digit for digit.",
      `boot <- bootstrap_model(model, nboot = ${options.bootstrap.nboot}, seed = ${options.bootstrap.seed})`,
      `boot_summary <- summary(boot, alpha = ${options.bootstrap.alpha})`,
      "boot_summary$bootstrapped_paths",
      "boot_summary$bootstrapped_HTMT",
      "boot_summary$bootstrapped_total_paths",
      "plot(boot)",
    );
  }
  if (options.predict.enabled) {
    lines.push(
      "",
      "# PLSpredict (10-fold by default). set.seed() makes the fold shuffle",
      "# identical to the browser run.",
      `set.seed(${options.predict.seed})`,
      `pred <- predict_pls(model, technique = ${options.predict.technique}, noFolds = ${options.predict.noFolds})`,
      "summary(pred)",
    );
    if (options.predict.cvpat) {
      lines.push(
        "",
        "library(seminrExtras)",
        `cvpat <- assess_cvpat(model, nboot = ${options.predict.cvpatNboot}, seed = ${options.predict.seed}, noFolds = ${options.predict.noFolds})`,
        "summary(cvpat)",
      );
    }
  }
  if (options.congruence.enabled) {
    if (!(options.predict.enabled && options.predict.cvpat)) lines.push("", "library(seminrExtras)");
    lines.push(
      `# congruence_test() places rho_C on the matrix diagonal${options.congruence.diagonal === "rhoA" ? "; the browser run used rho_A" : ""}.`,
      `congruence <- congruence_test(model, nboot = ${options.congruence.nboot}, seed = ${options.congruence.seed}, alpha = ${options.congruence.alpha}, threshold = ${options.congruence.threshold})`,
      "summary(congruence)",
    );
  }
  return lines.join("\n") + "\n";
}
