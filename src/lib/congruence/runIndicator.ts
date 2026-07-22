/**
 * End-to-end indicator-data route: pasted seminr code + pasted raw data
 * -> estimated PLS model -> congruence test with a re-estimation bootstrap.
 */

import {
  constructs, composite, multiItems, singleItem,
  relationships, paths, estimatePls, meanReplacement, modeB as MODE_B,
  parseCsv, type Dataset, type PlsModel,
} from "@seminr/core";
import { parseSeminrModel, requiredItems, type ParsedModel } from "./parseSeminr";
import { congruenceFromModel, type Diagonal, type ModelCongruenceResult } from "./model";

export interface IndicatorRunOptions {
  nboot?: number;
  seed?: number;
  alpha?: number;
  threshold?: number;
  diagonal?: Diagonal;
  onProgress?: (fraction: number) => void;
}

/** Turn a parsed model into @seminr/core specs and estimate it. */
export function buildAndEstimate(parsed: ParsedModel, data: Dataset): PlsModel {
  const specs = parsed.constructs.map((c) => {
    const itemsArg =
      c.items.length === 1
        ? singleItem(c.items[0])
        // Items were already expanded by the parser, so pass them verbatim
        // rather than re-deriving a stub + index range.
        : multiItems("", c.items as unknown as number[]);
    return c.modeB ? composite(c.name, itemsArg, MODE_B) : composite(c.name, itemsArg);
  });

  const mm = constructs(...specs);
  const sm = relationships(
    ...parsed.paths.map((p) => paths({ from: p.from, to: p.to })),
  );

  return estimatePls({
    data,
    measurementModel: mm,
    structuralModel: sm,
    missing: meanReplacement,
    missingValue: -99,
  });
}

export interface IndicatorRunInput {
  /** The seminr model code the user pasted. */
  code: string;
  /** Raw indicator data as pasted text (CSV or tab-separated). */
  dataText: string;
  options?: IndicatorRunOptions;
}

export function runIndicatorRoute(input: IndicatorRunInput): ModelCongruenceResult {
  const parsed = parseSeminrModel(input.code);

  // parseCsv wants commas; accept tab-separated paste too.
  const text = input.dataText.replace(/\r/g, "").trim();
  const firstLine = text.split("\n")[0];
  const normalised = firstLine.includes("\t")
    ? text.split("\n").map((l) => l.split("\t").join(",")).join("\n")
    : text;

  const data = parseCsv(normalised) as Dataset;

  // Fail early and specifically if the data does not carry the model's items.
  const cols: string[] =
    (data as any).cols ?? (data as any).columns ?? Object.keys((data as any).values?.[0] ?? {});
  const needed = requiredItems(parsed);
  const missing = needed.filter((i) => !cols.includes(i));
  if (missing.length) {
    throw new Error(
      `The pasted data is missing ${missing.length} indicator${missing.length === 1 ? "" : "s"} the model needs: ` +
        missing.slice(0, 8).join(", ") + (missing.length > 8 ? " …" : ""),
    );
  }

  const model = buildAndEstimate(parsed, data);
  return congruenceFromModel(model, data, input.options ?? {});
}
