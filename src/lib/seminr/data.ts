/**
 * Turn pasted or uploaded indicator data into a numeric Dataset.
 *
 * Accepts comma-, semicolon-, or tab-separated text with a header row (what
 * Excel, SmartPLS, SPSS and R's write.csv produce). Handles quoted headers,
 * a UTF-8 BOM, Windows line endings, decimal commas in semicolon files, and
 * the usual missing-value spellings ("", NA, NaN, ".", NULL). Non-numeric
 * cells become NaN, which the estimator treats as missing.
 */

import type { Dataset } from "@seminr/core";

export interface ParsedData {
  data: Dataset;
  delimiter: "," | ";" | "\t";
  /** Columns that contained at least one non-numeric, non-missing cell. */
  nonNumeric: string[];
}

const MISSING = new Set(["", "NA", "N/A", "NaN", "nan", ".", "NULL", "null", "-"]);

function detectDelimiter(header: string): "," | ";" | "\t" {
  if (header.includes("\t")) return "\t";
  const commas = (header.match(/,/g) ?? []).length;
  const semis = (header.match(/;/g) ?? []).length;
  return semis > commas ? ";" : ",";
}

function splitLine(line: string, d: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === d) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseDataText(text: string): ParsedData {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (!clean) throw new Error("No data was pasted.");
  const lines = clean.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 3) throw new Error("The data needs a header row and at least two rows of cases.");
  const delimiter = detectDelimiter(lines[0]);
  const columns = splitLine(lines[0], delimiter).map((c) => c.replace(/^["']|["']$/g, ""));
  if (columns.some((c) => c === "")) {
    // R's write.csv(row.names = TRUE) leaves the first header cell empty.
    columns.forEach((c, i) => { if (c === "") columns[i] = i === 0 ? "row" : `column_${i + 1}`; });
  }
  const dup = columns.find((c, i) => columns.indexOf(c) !== i);
  if (dup) throw new Error(`The header has a duplicated column name: "${dup}".`);

  const decimalComma = delimiter === ";";
  const nonNumeric = new Set<string>();
  const values: number[][] = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = splitLine(lines[r], delimiter);
    if (cells.length !== columns.length) {
      throw new Error(
        `Row ${r} has ${cells.length} cells but the header has ${columns.length}. Check for stray delimiters.`,
      );
    }
    const row = new Array<number>(columns.length);
    for (let j = 0; j < cells.length; j++) {
      const raw = cells[j];
      if (MISSING.has(raw)) { row[j] = NaN; continue; }
      const s = decimalComma ? raw.replace(",", ".") : raw;
      const v = Number(s);
      if (Number.isFinite(v)) row[j] = v;
      else { row[j] = NaN; nonNumeric.add(columns[j]); }
    }
    values.push(row);
  }
  return { data: { columns, values }, delimiter, nonNumeric: [...nonNumeric] };
}

/** Keep only the named columns, in the given order. */
export function selectColumns(data: Dataset, names: readonly string[]): Dataset {
  const idx = names.map((n) => data.columns.indexOf(n));
  return {
    columns: [...names],
    values: data.values.map((row) => idx.map((i) => row[i])),
  };
}

/** Per-column count of cells that are NaN or equal to the missing marker. */
export function missingCounts(data: Dataset, missingValue: number | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  data.columns.forEach((c, j) => {
    let n = 0;
    for (const row of data.values) {
      const v = row[j];
      if (Number.isNaN(v) || (missingValue !== undefined && v === missingValue)) n++;
    }
    out[c] = n;
  });
  return out;
}
