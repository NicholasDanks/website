/**
 * Paste parsers, ported from congruence_core.R.
 *
 * People paste from SmartPLS (tab-separated), Excel (tab), or a CSV export
 * (comma, often quoted). Some exports are whitespace-aligned. The delimiter is
 * sniffed from the first non-empty line, exactly as the R version does.
 */

export interface ParsedScores {
  names: string[];
  /** Column-major: one Float64Array per construct. */
  columns: Float64Array[];
  n: number;
}

export interface ParsedMatrix {
  names: string[];
  /** Column-major square matrix; NaN marks an unfilled cell. */
  columns: Float64Array[];
}

function unquote(x: string): string {
  return x
    .trim()
    .replace(/^["']/, "")
    .replace(/["']$/, "")
    .trim();
}

function nonEmptyLines(text: string): string[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

/** Sniff the delimiter from the first non-empty line: tab, then comma, else whitespace runs. */
function detectSplitter(line: string): (l: string) => string[] {
  if (line.includes("\t")) return (l) => l.split("\t").map(unquote);
  if (line.includes(",")) return (l) => l.split(",").map(unquote);
  return (l) => l.trim().split(/\s+/).map(unquote);
}

/** Parse the construct-scores block. First row is the header of construct names. */
export function parseScores(text: string): ParsedScores {
  const lines = nonEmptyLines(text);
  if (lines.length < 2) {
    throw new Error("Paste a header row of construct names plus at least two data rows.");
  }
  const split = detectSplitter(lines[0]);
  const header = split(lines[0]).filter((h) => h.length > 0);
  if (header.length < 2) {
    throw new Error("Need at least two constructs (columns) to test congruence.");
  }

  let rows = lines.slice(1).map((l) => split(l).filter((v) => v.length > 0));

  // A leading case-id column shows up as exactly one extra value on every row.
  if (rows.every((r) => r.length === header.length + 1)) {
    rows = rows.map((r) => r.slice(1));
  }

  const bad = rows.findIndex((r) => r.length !== header.length);
  if (bad >= 0) {
    throw new Error(
      `Row ${bad + 1} has ${rows[bad].length} values but the header has ${header.length} names — check the pasted matrix.`,
    );
  }
  if (rows.length < 3) {
    throw new Error("Need at least three observations (rows) to bootstrap.");
  }

  const n = rows.length;
  const columns = header.map(() => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < header.length; j++) {
      const v = Number(rows[i][j]);
      if (!Number.isFinite(v)) {
        throw new Error(
          `Non-numeric or missing value in row ${i + 1}, column "${header[j]}".`,
        );
      }
      columns[j][i] = v;
    }
  }
  return { names: header, columns, n };
}

/** Parse "NAME<sep>value" lines into a reliability lookup. */
export function parseRhoA(text: string): Record<string, number> {
  const lines = nonEmptyLines(text);
  if (lines.length === 0) throw new Error("Paste one construct and its rho_A per line.");
  const out: Record<string, number> = {};
  for (const line of lines) {
    const parts = line
      .split(/[\t,]|\s+/)
      .map(unquote)
      .filter((p) => p.length > 0);
    if (parts.length < 2) {
      throw new Error(`Could not read a name and a value from: "${line.trim()}"`);
    }
    const value = Number(parts[parts.length - 1]);
    const name = parts.slice(0, -1).join(" ");
    if (!Number.isFinite(value)) {
      throw new Error(`"${name}" does not have a numeric rho_A.`);
    }
    // Skip a header line like "construct  rhoA"
    if (parts.length === 2 && Number.isNaN(Number(parts[1])) ) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Parse a square construct matrix (correlation or HTMT). Tolerates a corner
 * cell, a leading label column, and full / upper- / lower-triangular fills;
 * the matrix is symmetrised from whichever triangle is present. The diagonal
 * is ignored — reliabilities are placed there later.
 */
export function parseMatrix(text: string): ParsedMatrix {
  const lines = nonEmptyLines(text);
  if (lines.length < 2) throw new Error("Paste a header row plus at least two rows.");
  const split = detectSplitter(lines[0]);

  let header = split(lines[0]);
  // Drop a leading corner cell (empty, or a label like "" / "HTMT").
  const body = lines.slice(1).map((l) => split(l));
  const firstCellIsLabel = body.every((r) => r.length > 0 && Number.isNaN(Number(r[0])));
  if (firstCellIsLabel && header.length === body.length + 1) header = header.slice(1);
  header = header.filter((h) => h.length > 0);

  const k = header.length;
  if (k < 2) throw new Error("Need at least two constructs.");

  const columns: Float64Array[] = [];
  for (let j = 0; j < k; j++) columns.push(new Float64Array(k).fill(NaN));

  for (let i = 0; i < body.length && i < k; i++) {
    let cells = body[i];
    if (firstCellIsLabel) cells = cells.slice(1);
    for (let j = 0; j < cells.length && j < k; j++) {
      if (cells[j] === "") continue;
      const v = Number(cells[j]);
      if (!Number.isFinite(v)) continue;
      columns[j][i] = v;
      if (Number.isNaN(columns[i][j])) columns[i][j] = v; // symmetrise
    }
  }
  return { names: header, columns };
}

/** Align a reliability lookup to the construct order, with a clear error if any are missing. */
export function alignRhoA(names: string[], lookup: Record<string, number>): Float64Array {
  const missing = names.filter((n) => !(n in lookup));
  if (missing.length) {
    throw new Error(`Missing rho_A for: ${missing.join(", ")}`);
  }
  const out = new Float64Array(names.length);
  names.forEach((n, i) => {
    const v = lookup[n];
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      throw new Error(`rho_A for "${n}" must be finite and in (0, 1].`);
    }
    out[i] = v;
  });
  return out;
}
