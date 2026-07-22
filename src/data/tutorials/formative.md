---
title: "Formative Measurement Model Assessment"
topic: "Formative measurement"
chapter: 5
order: 2
summary: "Assessing formatively measured constructs: redundancy analysis for convergent validity, indicator collinearity via VIF, and interpreting outer weights and their significance."
learningOutcomes:
  - "Distinguish formative from reflective measurement — conceptually and in SEMinR syntax"
  - "Run a redundancy analysis to establish convergent validity"
  - "Check indicator collinearity with VIF and diagnose problematic indicators"
  - "Interpret outer weights, their bootstrap significance, and outer loadings as a secondary check"
videoStatus: published
videoUrl: "https://youtu.be/LzWLSFcxHtE"
slidesFile: "formative-measurement-slides.pptx"
durationMinutes: 23
codeFile: "seminr-primer-v2-chap5.R"
rPractice:
  - "Comment the *why*, not the *what*"
companionAnchor: sec-formative_mm
---

## Everything you learned last video now does not apply

Reflective assessment asks whether your indicators agree with each other. Formative assessment cannot ask that, because formative indicators have no obligation to correlate at all.

If quality, performance, social responsibility, and attractiveness *make up* a firm's reputation drivers, then dropping one does not lose a redundant symptom — it changes what the construct means. That single fact invalidates Cronbach's alpha, rho_A, rho_C, AVE, and HTMT for these constructs.

Three criteria replace them: **redundancy analysis**, **collinearity**, and **significance and relevance of weights**.

## Specifying formative constructs: `weights = mode_B`

```r
library(seminr)

corp_rep_mm_ext <- constructs(
  composite("QUAL", multi_items("qual_", 1:8), weights = mode_B),
  composite("PERF", multi_items("perf_", 1:5), weights = mode_B),
  composite("CSOR", multi_items("csor_", 1:5), weights = mode_B),
  composite("ATTR", multi_items("attr_", 1:3), weights = mode_B),
  composite("COMP", multi_items("comp_", 1:3)),
  composite("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  composite("CUSL", multi_items("cusl_", 1:3)))
```

> **The distinction that trips everyone up.** In the reflective lesson we said `composite()` is about *estimation*, and reflective-vs-formative is about *assessment*. Here is the estimation half: `mode_B` computes **regression** weights, `mode_A` (the default) computes **correlation** weights. Only the four drivers are mode B — the rest of the model is unchanged. One model, two measurement philosophies, one `constructs()` call.

## 1. Convergent validity — redundancy analysis

Can your formative indicators, taken together, reproduce a direct global measure of the same concept? You test this by regressing each formative construct on a single-item global measure of itself:

```r
ATTR_redundancy_mm <- constructs(
  composite("ATTR_F", multi_items("attr_", 1:3), weights = mode_B),
  composite("ATTR_G", single_item("attr_global")))

ATTR_redundancy_sm <- relationships(paths(from = "ATTR_F", to = "ATTR_G"))

ATTR_redundancy_pls_model <- estimate_pls(
  data = corp_rep_data,
  measurement_model = ATTR_redundancy_mm,
  structural_model  = ATTR_redundancy_sm,
  missing = mean_replacement, missing_value = "-99")

summary(ATTR_redundancy_pls_model)$paths
```

The path should reach **0.708** — the same "half the variance" logic as indicator reliability. In the corporate reputation data all four pass: QUAL 0.805, PERF 0.811, CSOR 0.857, ATTR 0.874.

This requires that you *collected* a global item for each formative construct. If you did not, you cannot run this test — which is why it belongs in your questionnaire design, not your analysis plan.

## 2. Collinearity — VIF

```r
corp_rep_summary_ext$validity$vif_items
```

Formative weights are regression coefficients, so collinear indicators destabilise them and can flip their signs. **Below 3 is comfortable; 5 is the hard ceiling.** Across all 21 formative indicators here the highest is `qual_3` at 2.27 — no action needed.

## 3. Significance and relevance of weights

```r
set.seed(123)
corp_rep_boot_ext <- bootstrap_model(corp_rep_pls_model_ext, nboot = 1000)
corp_rep_boot_ext_summary <- summary(corp_rep_boot_ext, alpha = 0.05)

corp_rep_boot_ext_summary$bootstrapped_weights
corp_rep_boot_ext_summary$bootstrapped_loadings
```

Five weights have confidence intervals covering zero: `qual_2`, `qual_3`, `qual_4`, `csor_2`, `csor_4`. This is not the disaster it looks like.

With eight indicators on QUAL, weights are **mathematically compressed** — the more indicators a formative construct has, the smaller the average weight, regardless of quality. That is exactly why the decision rule falls back on loadings:

| Weight | Loading | Decision |
| --- | --- | --- |
| Significant | — | Retain; interpret relative contribution |
| Not significant | ≥ 0.5 and significant | **Retain** — absolute contribution is real |
| Not significant | < 0.5 and not significant | Strong case for removal |

All five flagged indicators here clear the loading test, so all five stay. **Formative indicator removal is a content decision, not a statistical reflex** — deleting one changes what your construct means.

> **R practice — comment the *why*, never the *what*.** Look at the comment above `estimate_pls()` in the script: it does not say "estimate the model", because the code already says that. It says why `missing_value = "-99"` — that value is a sentinel for a skipped answer, not a real response. Code records what; comments record decisions.

## What never to report

Cronbach's alpha, rho_A, rho_C, AVE, and HTMT for a formative construct. All of them assume interchangeable indicators. Reporting them is the fastest way to signal you have not understood formative measurement — and reviewers do notice.

## Going further

Chapter 5 of Hair et al. (2026) has the full treatment, including questionnaire design for redundancy analysis. Next: the **structural model** — path coefficients, R², effect sizes, and out-of-sample prediction.
