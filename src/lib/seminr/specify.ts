/**
 * Turn a parsed SEMinR model into @seminr/core specifications and estimate it.
 */

import {
  constructs, composite, reflective, higherComposite, interactionTerm, quadraticTerm,
  relationships, paths, estimatePls, meanReplacement, naOmit, pathWeighting, pathFactorial,
  modeA, modeB, unitWeights, twoStage, productIndicator, orthogonal,
  type Dataset, type PlsModel, type MeasurementModel, type SMMatrix, type WeightMarker,
} from "@seminr/core";
import type { ParsedModel, WeightMode, InteractionMethod } from "./parseSeminr";

export type InnerWeightsName = "path_weighting" | "path_factorial";
export type MissingName = "mean_replacement" | "na_omit";

export interface EstimationOptions {
  innerWeights: InnerWeightsName;
  missing: MissingName;
  /** Marker value in the raw data that denotes a missing observation (e.g. -99). */
  missingValue?: number;
  maxIt?: number;
  stopCriterion?: number;
}

const WEIGHTS: Record<WeightMode, WeightMarker> = {
  mode_A: modeA,
  mode_B: modeB,
  unit_weights: unitWeights,
};

const METHODS: Record<InteractionMethod, typeof twoStage> = {
  two_stage: twoStage,
  product_indicator: productIndicator,
  orthogonal: orthogonal,
};

export function buildMeasurementModel(parsed: ParsedModel): MeasurementModel {
  return constructs(
    ...parsed.measurement.map((m) => {
      switch (m.kind) {
        case "construct":
          // reflective() is a common factor estimated via PLSc (type "C"), not a
          // mode A composite — mapping it to composite() would silently change
          // the estimator and the numbers.
          return m.reflective ? reflective(m.name, m.items) : composite(m.name, m.items, WEIGHTS[m.weights]);
        case "higher_composite":
          return higherComposite(m.name, m.dimensions, m.method, WEIGHTS[m.weights]);
        case "interaction":
          return m.quadratic
            ? quadraticTerm(m.iv, METHODS[m.method], WEIGHTS[m.weights])
            : interactionTerm(m.iv, m.moderator, METHODS[m.method], WEIGHTS[m.weights]);
      }
    }),
  );
}

export function buildStructuralModel(parsed: ParsedModel): SMMatrix {
  return relationships(...parsed.paths.map((p) => paths({ from: p.from, to: p.to })));
}

export function estimateParsedModel(parsed: ParsedModel, data: Dataset, options: EstimationOptions): PlsModel {
  return estimatePls({
    data,
    measurementModel: buildMeasurementModel(parsed),
    structuralModel: buildStructuralModel(parsed),
    innerWeights: options.innerWeights === "path_factorial" ? pathFactorial : pathWeighting,
    missing: options.missing === "na_omit" ? naOmit : meanReplacement,
    missingValue: options.missingValue,
    maxIt: options.maxIt,
    stopCriterion: options.stopCriterion,
  });
}
