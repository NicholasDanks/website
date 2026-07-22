---
title: "Structural Model Assessment"
topic: "Structural model"
chapter: 6
order: 3
summary: "Once measurement passes, assess the structural model: path coefficients and their significance, R², f² effect sizes, Q²predict, and bootstrap confidence intervals on indirect effects."
learningOutcomes:
  - "Interpret standardized path coefficients and their bootstrap significance"
  - "Report R² and adjusted R² for endogenous constructs"
  - "Compute and interpret f² effect sizes"
  - "Use Q²predict to evaluate out-of-sample predictive relevance"
  - "Read total, direct, and indirect effects from the SEMinR summary"
videoStatus: published
videoUrl: "https://youtu.be/CYsFpshBW7I"
slidesFile: "structural-model-slides.pptx"
durationMinutes: 33
codeFile: "seminr-primer-v2-chap6.R"
rPractice:
  - "Use the native pipe |> for teaching code (R ≥ 4.1)"
  - "End every reproducible script with sessionInfo()"
companionAnchor: sec-structural
---

## Measurement is settled. Now the theory gets tested.

The first two lessons established that the constructs are measured well. That is a precondition, not a finding. This lesson assesses the model's actual claims — which paths carry effect, how much variance is explained, and whether any of it predicts data the model has never seen.

Five steps, in order. The first four are about *explanation*; the fifth is about *prediction*, and reviewers now expect both.

## 1. Collinearity among predictor constructs

```r
corp_rep_summary_ext$vif_antecedents
```

Path coefficients are regression coefficients, so the same logic as formative indicators applies one level up: an endogenous construct's predictors must not be collinear. **Below 3 is comfortable, 5 is the ceiling.**

One value to note here: QUAL sits at **3.49** predicting COMP and LIKE. Above 3, below 5 — acceptable. Mention it in the paper and move on.

## 2. Significance and relevance of paths

```r
set.seed(123)
corp_rep_boot_ext <- bootstrap_model(corp_rep_pls_model_ext, nboot = 1000)
corp_rep_boot_ext_summary <- summary(corp_rep_boot_ext, alpha = 0.05)

corp_rep_boot_ext_summary$bootstrapped_paths |> round(3)
```

Nine of thirteen paths are significant. The four that are not tell the more interesting story: CSOR and ATTR do not move competence, performance barely moves likeability — and **COMP → CUSL is 0.006, p = 0.84**, while LIKE → CUSL carries 0.34.

Read plainly: customers stay because they *like* the firm, not because they think it is competent. Hold that thought — it is wrong, and the mediation lesson shows why.

> **R practice — use the native pipe `|>`.** Base R since 4.1, no package required, survives package churn, and the analysis reads left to right.

## 3. Explanatory power — R²

```r
corp_rep_summary_ext$paths
```

R² sits on top of the paths table: COMP 0.63, LIKE 0.56, CUSL 0.56, CUSA 0.29. Substantial for a behavioural model. CUSA is weaker, but it has only two predictors.

Interpret R² against your field's norms, not against arbitrary cutoffs imported from another discipline.

## 4. Effect sizes — f²

```r
corp_rep_summary_ext$fSquare
```

f² asks how far R² falls if you delete a predictor. Cohen's benchmarks: **0.02 small, 0.15 medium, 0.35 large.** CUSA → CUSL is the heavyweight at 0.40.

Report f² next to every path coefficient. Significance tells you *whether* an effect is there; f² tells you *whether it matters*.

## 5. Predictive power — PLSpredict and CVPAT

R² is explanation *within* your sample. Prediction is performance on data the model never saw.

```r
set.seed(123)
corp_rep_predict <- predict_pls(corp_rep_pls_model_ext,
                                technique = predict_DA,
                                noFolds = 10, reps = 10)
summary(corp_rep_predict)
```

Ten-fold cross-validation, ten repetitions, seeded because the folds are assigned at random. Two checks: **Q²predict above zero** (every indicator passes; loyalty items run about 0.37 to 0.49), and **PLS beating the naive linear-model benchmark** out of sample, which it does on nine of ten indicators and on all three loyalty items. By the Shmueli guideline that is medium predictive power, bordering high.

CVPAT then asks whether that gap is significant or noise:

```r
assess_results <- assess_cvpat(seminr_model = corp_rep_pls_model_ext,
                               testtype = "greater", nboot = 2000, seed = 123,
                               technique = predict_DA, noFolds = 10, reps = 10)

print(assess_results$CVPAT_compare_LM, digits = 3)
print(assess_results$CVPAT_compare_IA, digits = 3)
```

## 6. Comparing competing models

Does adding direct driver-to-outcome paths buy out-of-sample prediction, or only in-sample fit? Estimate the nested alternatives, then compare on BIC and on predictive ability:

```r
itcriteria_vector <- c(sum_model1$it_criteria["BIC", "CUSA"],
                       sum_model2$it_criteria["BIC", "CUSA"],
                       sum_model3$it_criteria["BIC", "CUSA"])
names(itcriteria_vector) <- c("Model1", "Model2", "Model3")
compute_itcriteria_weights(itcriteria_vector)

compare_results <- assess_cvpat_compare(
  established_model = pls_model1, alternative_model = pls_model3,
  testtype = "greater", nboot = 2000, technique = predict_DA,
  seed = 123, noFolds = 10, reps = 10)
```

A more complex model almost always fits better in-sample. Only cross-validated comparison tells you whether the extra paths earn their keep.

> **R practice — end every script with `sessionInfo()`.** One line. It records R and package versions, so when SEMinR updates in 2027 anyone can still reproduce today's output. The difference between "my code worked in 2026" and "my code works".

## Going further

Chapter 6 of Hair et al. (2026) covers all of it, including PLSpredict, CVPAT, and model comparison. Next: **mediation** — why competence matters after all, despite that 0.006.
