/**
 * A deliberately small parser for the SEMinR model DSL, so users can paste the
 * same code they would run in R.
 *
 * Supported (the documented subset):
 *   constructs( composite(...), reflective(...), ... )
 *   composite("NAME", multi_items("stub_", 1:3))
 *   composite("NAME", multi_items("stub_", c(1,2,5)))
 *   composite("NAME", single_item("item"))
 *   composite("NAME", ..., weights = mode_B)      // or mode_A
 *   reflective("NAME", multi_items(...))          // treated as mode A composite
 *   relationships( paths(from = c("A","B"), to = c("C")), ... )
 *
 * Assignment lines (`mm <- constructs(...)`) are fine; anything outside the
 * recognised calls is ignored. Unsupported constructs (interaction_term,
 * higher_composite) raise a clear error rather than being silently dropped —
 * a congruence test on a model we mis-parsed would be worse than no answer.
 */

export interface ParsedConstruct {
  name: string;
  items: string[];
  modeB: boolean;
}

export interface ParsedPath {
  from: string[];
  to: string[];
}

export interface ParsedModel {
  constructs: ParsedConstruct[];
  paths: ParsedPath[];
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

function parseItems(argExprs: string[], constructName: string): string[] {
  const items: string[] = [];
  for (const a of argExprs) {
    const mi = /^multi_items\s*\(([\s\S]*)\)$/.exec(a.trim());
    if (mi) {
      const parts = splitArgs(mi[1]);
      if (parts.length < 2) throw new Error(`multi_items() in "${constructName}" needs a stub and indices.`);
      const stub = unquote(parts[0]);
      const idx = parseVector(parts[1]);
      idx.forEach((i) => items.push(`${stub}${i}`));
      continue;
    }
    const si = /^single_item\s*\(([\s\S]*)\)$/.exec(a.trim());
    if (si) { items.push(unquote(splitArgs(si[1])[0])); continue; }
  }
  return items;
}

export function parseSeminrModel(source: string): ParsedModel {
  const src = stripComments(source);

  for (const unsupported of ["interaction_term", "higher_composite", "quadratic_term"]) {
    if (new RegExp(`\\b${unsupported}\\s*\\(`).test(src)) {
      throw new Error(
        `${unsupported}() is not supported here — the congruence test is defined over plain constructs. Remove it and re-run.`,
      );
    }
  }

  const cCall = findCall(src, "constructs");
  if (!cCall) throw new Error('Could not find a constructs( ... ) call. Paste your measurement model.');
  const rCall = findCall(src, "relationships");
  if (!rCall) throw new Error('Could not find a relationships( ... ) call. Paste your structural model.');

  // --- constructs -----------------------------------------------------------
  const constructsOut: ParsedConstruct[] = [];
  for (const arg of splitArgs(cCall.inner)) {
    const m = /^(composite|reflective)\s*\(([\s\S]*)\)$/.exec(arg.trim());
    if (!m) continue;
    const parts = splitArgs(m[2]);
    if (parts.length < 2) throw new Error(`${m[1]}() needs a name and its items.`);
    const name = unquote(parts[0]);
    const modeB = parts.some((p) => /weights\s*=\s*mode_B/.test(p) || /^mode_B$/.test(p.trim()));
    const items = parseItems(parts.slice(1), name);
    if (items.length === 0) {
      throw new Error(`Could not read any indicators for "${name}" — use multi_items() or single_item().`);
    }
    constructsOut.push({ name, items, modeB });
  }
  if (constructsOut.length < 2) {
    throw new Error("Need at least two constructs to test congruence.");
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
      const fm = /^from\s*=([\s\S]*)$/.exec(a);
      const tm = /^to\s*=([\s\S]*)$/.exec(a);
      if (fm) from = parseVector(fm[1]);
      else if (tm) to = parseVector(tm[1]);
      else if (i === 0 && !/=/.test(a)) from = parseVector(a);
      else if (i === 1 && !/=/.test(a)) to = parseVector(a);
    });
    if (from.length && to.length) pathsOut.push({ from, to });
  }
  if (pathsOut.length === 0) {
    throw new Error("Could not read any paths() from the structural model.");
  }

  // --- cross-checks ---------------------------------------------------------
  const known = new Set(constructsOut.map((c) => c.name));
  const unknown = new Set<string>();
  pathsOut.forEach((p) => [...p.from, ...p.to].forEach((n) => { if (!known.has(n)) unknown.add(n); }));
  if (unknown.size) {
    throw new Error(
      `These constructs appear in paths() but were never defined: ${[...unknown].join(", ")}`,
    );
  }

  return { constructs: constructsOut, paths: pathsOut };
}

/** Every indicator the parsed model expects, for validating the pasted data. */
export function requiredItems(model: ParsedModel): string[] {
  return model.constructs.flatMap((c) => c.items);
}
