/**
 * A small parser for the SEMinR model DSL, so users can paste the same code
 * they would run in R.
 *
 * Supported (the documented subset of seminr's specification language):
 *   constructs( composite(...), reflective(...), higher_composite(...),
 *               interaction_term(...), quadratic_term(...) )
 *   composite("NAME", multi_items("stub_", 1:3))
 *   composite("NAME", multi_items("stub_", c(1,2,5), prefix = "", mid = "", suffix = ""))
 *   composite("NAME", single_item("item"))
 *   composite("NAME", c("item_a", "item_b"))
 *   composite("NAME", ..., weights = mode_A | mode_B | correlation_weights |
 *                                    regression_weights | unit_weights)
 *   reflective("NAME", multi_items(...))          // common factor, PLSc
 *   higher_composite("NAME", dimensions = c("A","B"), method = two_stage, weights = mode_B)
 *   interaction_term(iv = "A", moderator = "B", method = two_stage | product_indicator | orthogonal, weights = mode_A)
 *   quadratic_term(iv = "A", method = two_stage)
 *   relationships( paths(from = c("A","B"), to = c("C")), paths("A", "C") )
 *
 * Assignment lines (`mm <- constructs(...)`), `library(seminr)`, `read.csv()`
 * and `estimate_pls()` calls are ignored; only the recognised calls are read.
 * Anything the parser cannot interpret raises a specific error rather than
 * being silently dropped — a model we mis-parsed would be worse than no answer.
 */

export type WeightMode = "mode_A" | "mode_B" | "unit_weights";
export type InteractionMethod = "two_stage" | "product_indicator" | "orthogonal";

export interface ParsedConstruct {
  kind: "construct";
  name: string;
  items: string[];
  weights: WeightMode;
  /**
   * True for reflective(): a common-factor construct estimated consistently
   * via PLSc (type "C"), which is a different estimator from composite() —
   * not merely a labelling difference.
   */
  reflective: boolean;
}

export interface ParsedHigherComposite {
  kind: "higher_composite";
  name: string;
  dimensions: string[];
  method: "two_stage";
  weights: WeightMode;
}

export interface ParsedInteraction {
  kind: "interaction";
  /** seminr names the construct `iv*moderator`. */
  name: string;
  iv: string;
  moderator: string;
  method: InteractionMethod;
  weights: WeightMode;
  quadratic: boolean;
}

export type ParsedMeasurement = ParsedConstruct | ParsedHigherComposite | ParsedInteraction;

export interface ParsedPath {
  from: string[];
  to: string[];
}

export interface ParsedModel {
  measurement: ParsedMeasurement[];
  paths: ParsedPath[];
}

/** Legacy accessor: the plain constructs of a parsed model. */
export function plainConstructs(model: ParsedModel): ParsedConstruct[] {
  return model.measurement.filter((m): m is ParsedConstruct => m.kind === "construct");
}

/** Strip R comments (# to end of line) without touching # inside strings. */
function stripComments(src: string): string {
  let out = "";
  let inStr: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === inStr && src[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; out += c; continue; }
    if (c === "#") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; continue; }
    out += c;
  }
  return out;
}

/** Find the argument list of `name(...)`, returning the inner text and end index. */
function findCall(src: string, name: string, from = 0): { inner: string; end: number } | null {
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  re.lastIndex = from;
  const m = re.exec(src);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  let inStr: string | null = null;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i];
    if (inStr) { if (c === inStr && src[i - 1] !== "\\") inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  if (depth !== 0) throw new Error(`Unbalanced parentheses in ${name}(...)`);
  return { inner: src.slice(start, i - 1), end: i };
}

/** Split on commas at depth 0. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === inStr && s[i - 1] !== "\\") inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; cur += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function unquote(s: string): string {
  return s.trim().replace(/^["']/, "").replace(/["']$/, "").trim();
}

/** Split an argument into `{ key, value }`; key is null for positional arguments. */
function keyed(arg: string): { key: string | null; value: string } {
  const m = /^([A-Za-z_.][A-Za-z0-9_.]*)\s*=(?!=)([\s\S]*)$/.exec(arg.trim());
  if (m) return { key: m[1], value: m[2].trim() };
  return { key: null, value: arg.trim() };
}

/** Parse `c("A","B")`, `"A"`, or `c(1,2)` / `1:3` into string tokens. */
function parseVector(expr: string): string[] {
  const e = expr.trim();
  const cm = /^c\s*\(([\s\S]*)\)$/.exec(e);
  if (cm) return splitArgs(cm[1]).flatMap(parseVector);
  const range = /^(\d+)\s*:\s*(\d+)$/.exec(e);
  if (range) {
    const a = Number(range[1]), b = Number(range[2]);
    const out: string[] = [];
    if (a <= b) for (let i = a; i <= b; i++) out.push(String(i));
    else for (let i = a; i >= b; i--) out.push(String(i));
    return out;
  }
  return [unquote(e)];
}

function parseWeights(value: string, where: string): WeightMode {
  const v = value.trim();
  if (/^(mode_A|correlation_weights)$/.test(v)) return "mode_A";
  if (/^(mode_B|regression_weights)$/.test(v)) return "mode_B";
  if (/^(unit_weights|sum_weights)$/.test(v)) return "unit_weights";
  if (/^mode_plsc$/.test(v)) {
    throw new Error(`${where}: use reflective() instead of weights = mode_plsc.`);
  }
  throw new Error(`${where}: unrecognised weights "${v}" — use mode_A, mode_B, or unit_weights.`);
}

function parseInteractionMethod(value: string, where: string): InteractionMethod {
  const v = value.trim();
  if (v === "two_stage" || v === "product_indicator" || v === "orthogonal") return v;
  throw new Error(`${where}: unrecognised method "${v}" — use two_stage, product_indicator, or orthogonal.`);
}

/** Expand multi_items()/single_item()/c(...) item expressions into item names. */
function parseItems(argExprs: string[], constructName: string): string[] {
  const items: string[] = [];
  for (const a of argExprs) {
    const mi = /^multi_items\s*\(([\s\S]*)\)$/.exec(a.trim());
    if (mi) {
      const parts = splitArgs(mi[1]).map(keyed);
      const positional = parts.filter((p) => p.key === null).map((p) => p.value);
      const named = new Map(parts.filter((p) => p.key !== null).map((p) => [p.key as string, p.value]));
      const stubExpr = named.get("item_name") ?? positional[0];
      const numExpr = named.get("item_numbers") ?? positional[1];
      if (!stubExpr || !numExpr) {
        throw new Error(`multi_items() in "${constructName}" needs a stub and item numbers.`);
      }
      const stub = unquote(stubExpr);
      const prefix = named.has("prefix") ? unquote(named.get("prefix")!) : "";
      const mid = named.has("mid") ? unquote(named.get("mid")!) : "";
      const suffix = named.has("suffix") ? unquote(named.get("suffix")!) : "";
      parseVector(numExpr).forEach((i) => items.push(`${prefix}${stub}${mid}${i}${suffix}`));
      continue;
    }
    const si = /^single_item\s*\(([\s\S]*)\)$/.exec(a.trim());
    if (si) { items.push(unquote(splitArgs(si[1])[0])); continue; }
    if (/^c\s*\(/.test(a.trim()) || /^["']/.test(a.trim())) {
      items.push(...parseVector(a));
      continue;
    }
    throw new Error(
      `Could not read the items of "${constructName}" from \`${a.trim().slice(0, 40)}\` — use multi_items(), single_item(), or c("a", "b").`,
    );
  }
  return items;
}

function parseCompositeLike(fn: string, inner: string): ParsedConstruct {
  const parts = splitArgs(inner).map(keyed);
  if (parts.length < 2) throw new Error(`${fn}() needs a name and its items.`);
  const positional = parts.filter((p) => p.key === null);
  const named = parts.filter((p) => p.key !== null);
  const nameArg = named.find((p) => p.key === "construct_name") ?? positional[0];
  if (!nameArg) throw new Error(`${fn}() needs a construct name.`);
  const name = unquote(nameArg.value);
  const where = `${fn}("${name}")`;

  const itemArgs = named.filter((p) => p.key === "item_names").map((p) => p.value);
  const rest = positional.slice(nameArg === positional[0] ? 1 : 0).map((p) => p.value);

  let weights: WeightMode = "mode_A";
  const weightArg = named.find((p) => p.key === "weights");
  const itemExprs: string[] = [...itemArgs];
  for (const r of rest) {
    if (/^(mode_A|mode_B|correlation_weights|regression_weights|unit_weights|sum_weights|mode_plsc)$/.test(r)) {
      weights = parseWeights(r, where);
    } else {
      itemExprs.push(r);
    }
  }
  if (weightArg) weights = parseWeights(weightArg.value, where);

  const reflective = fn === "reflective";
  if (reflective && (weightArg || weights !== "mode_A")) {
    throw new Error(
      `"${name}" is declared reflective() but also asks for ${weightArg?.value ?? weights} weights — those are different estimators. Pick one.`,
    );
  }
  const items = parseItems(itemExprs, name);
  if (items.length === 0) {
    throw new Error(`Could not read any indicators for "${name}" — use multi_items() or single_item().`);
  }
  if (weights === "mode_B" && items.length === 1) {
    throw new Error(`"${name}" is a single-item construct and cannot use mode_B weights.`);
  }
  return { kind: "construct", name, items, weights, reflective };
}

function parseHigherComposite(inner: string): ParsedHigherComposite {
  const parts = splitArgs(inner).map(keyed);
  const positional = parts.filter((p) => p.key === null).map((p) => p.value);
  const named = new Map(parts.filter((p) => p.key !== null).map((p) => [p.key as string, p.value]));
  const nameExpr = named.get("construct_name") ?? positional[0];
  const dimExpr = named.get("dimensions") ?? positional[1];
  if (!nameExpr || !dimExpr) throw new Error("higher_composite() needs a name and its dimensions.");
  const name = unquote(nameExpr);
  const where = `higher_composite("${name}")`;
  const methodExpr = named.get("method") ?? positional[2] ?? "two_stage";
  if (methodExpr.trim() !== "two_stage") {
    throw new Error(`${where}: only method = two_stage is supported.`);
  }
  const weightsExpr = named.get("weights") ?? positional[3];
  const weights = weightsExpr ? parseWeights(weightsExpr, where) : "mode_A";
  const dimensions = parseVector(dimExpr);
  if (dimensions.length < 2) throw new Error(`${where}: needs at least two dimensions.`);
  return { kind: "higher_composite", name, dimensions, method: "two_stage", weights };
}

function parseInteraction(fn: "interaction_term" | "quadratic_term", inner: string): ParsedInteraction {
  const parts = splitArgs(inner).map(keyed);
  const positional = parts.filter((p) => p.key === null).map((p) => p.value);
  const named = new Map(parts.filter((p) => p.key !== null).map((p) => [p.key as string, p.value]));
  const quadratic = fn === "quadratic_term";
  const ivExpr = named.get("iv") ?? positional[0];
  if (!ivExpr) throw new Error(`${fn}() needs an iv.`);
  const iv = unquote(ivExpr);
  const modExpr = quadratic ? ivExpr : (named.get("moderator") ?? positional[1]);
  if (!modExpr) throw new Error(`interaction_term(iv = "${iv}") needs a moderator.`);
  const moderator = unquote(modExpr);
  const where = quadratic ? `quadratic_term("${iv}")` : `interaction_term("${iv}", "${moderator}")`;
  const methodPos = quadratic ? positional[1] : positional[2];
  const weightsPos = quadratic ? positional[2] : positional[3];
  const methodExpr = named.get("method") ?? methodPos ?? (quadratic ? "two_stage" : "product_indicator");
  const method = parseInteractionMethod(methodExpr, where);
  const weightsExpr = named.get("weights") ?? weightsPos;
  const weights = weightsExpr ? parseWeights(weightsExpr, where) : "mode_A";
  return { kind: "interaction", name: `${iv}*${moderator}`, iv, moderator, method, weights, quadratic };
}

export function parseSeminrModel(source: string): ParsedModel {
  const src = stripComments(source);

  const cCall = findCall(src, "constructs");
  if (!cCall) throw new Error("Could not find a constructs( ... ) call. Paste your measurement model.");
  const rCall = findCall(src, "relationships");
  if (!rCall) throw new Error("Could not find a relationships( ... ) call. Paste your structural model.");

  // --- measurement model ----------------------------------------------------
  const measurement: ParsedMeasurement[] = [];
  for (const arg of splitArgs(cCall.inner)) {
    const m = /^([A-Za-z_]+)\s*\(([\s\S]*)\)$/.exec(arg.trim());
    if (!m) {
      if (arg.trim() === "") continue;
      throw new Error(`Could not read \`${arg.trim().slice(0, 40)}\` inside constructs().`);
    }
    const fn = m[1];
    switch (fn) {
      case "composite":
      case "reflective":
        measurement.push(parseCompositeLike(fn, m[2]));
        break;
      case "higher_composite":
        measurement.push(parseHigherComposite(m[2]));
        break;
      case "higher_reflective":
        throw new Error("higher_reflective() is a CB-SEM specification; this app estimates PLS models.");
      case "interaction_term":
      case "quadratic_term":
        measurement.push(parseInteraction(fn, m[2]));
        break;
      default:
        throw new Error(`${fn}() is not supported inside constructs().`);
    }
  }
  const constructsOut = measurement.filter((m) => m.kind !== "interaction");
  if (constructsOut.length < 2) {
    throw new Error("A model needs at least two constructs.");
  }
  const seen = new Set<string>();
  for (const m of measurement) {
    if (seen.has(m.name)) throw new Error(`"${m.name}" is defined twice in constructs().`);
    seen.add(m.name);
  }

  // --- paths ----------------------------------------------------------------
  const pathsOut: ParsedPath[] = [];
  let cursor = 0;
  for (;;) {
    const p = findCall(rCall.inner, "paths", cursor);
    if (!p) break;
    cursor = p.end;
    const args = splitArgs(p.inner);
    let from: string[] = [], to: string[] = [];
    args.forEach((a, i) => {
      const { key, value } = keyed(a);
      if (key === "from") from = parseVector(value);
      else if (key === "to") to = parseVector(value);
      else if (key === null && i === 0) from = parseVector(value);
      else if (key === null && i === 1) to = parseVector(value);
      else throw new Error(`Could not read \`${a.trim().slice(0, 40)}\` inside paths().`);
    });
    if (from.length && to.length) pathsOut.push({ from, to });
  }
  if (pathsOut.length === 0) {
    throw new Error("Could not read any paths() from the structural model.");
  }

  // --- cross-checks ---------------------------------------------------------
  const known = new Set(measurement.map((c) => c.name));
  const unknown = new Set<string>();
  pathsOut.forEach((p) => [...p.from, ...p.to].forEach((n) => { if (!known.has(n)) unknown.add(n); }));
  if (unknown.size) {
    throw new Error(
      `These constructs appear in paths() but were never defined: ${[...unknown].join(", ")}`,
    );
  }
  for (const m of measurement) {
    if (m.kind === "interaction") {
      for (const n of [m.iv, m.moderator]) {
        if (!known.has(n) || measurement.find((x) => x.name === n)?.kind === "interaction") {
          throw new Error(`${m.quadratic ? "quadratic_term" : "interaction_term"}: "${n}" is not a defined construct.`);
        }
      }
    }
    if (m.kind === "higher_composite") {
      for (const d of m.dimensions) {
        const dim = measurement.find((x) => x.name === d);
        if (!dim || dim.kind !== "construct") {
          throw new Error(`higher_composite("${m.name}"): dimension "${d}" is not a first-order construct.`);
        }
      }
    }
  }
  for (const p of pathsOut) {
    for (const f of p.from) for (const t of p.to) {
      if (f === t) throw new Error(`paths(): "${f}" cannot predict itself.`);
    }
  }

  return { measurement, paths: pathsOut };
}

/** Every raw indicator the parsed model expects, for validating the pasted data. */
export function requiredItems(model: ParsedModel): string[] {
  const out: string[] = [];
  for (const m of model.measurement) if (m.kind === "construct") out.push(...m.items);
  return [...new Set(out)];
}

/** Every construct name that can appear in the structural model. */
export function constructNamesOf(model: ParsedModel): string[] {
  return model.measurement.map((m) => m.name);
}
