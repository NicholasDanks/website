---
title: "Reflective Measurement Model Assessment"
topic: "Reflective measurement"
chapter: 4
order: 1
summary: "Specify, estimate, and evaluate reflective constructs on the four criteria reviewers expect: indicator reliability, internal consistency, convergent validity, and discriminant validity — plus bootstrapped HTMT confidence intervals."
learningOutcomes:
  - "Specify a reflective measurement model in SEMinR using composite() and multi_items()"
  - "Estimate a PLS-SEM model and read the key fields from summary()"
  - "Assess indicator reliability via outer loadings and their squares"
  - "Report Cronbach alpha, rho_A, and composite reliability, and know which to lead with"
  - "Use HTMT and bootstrapped HTMT confidence intervals to test discriminant validity"
  - "Know where to look in Chapter 4 for the theoretical backing"
videoStatus: planned
codeFile: "seminr-primer-v2-chap4.R"
rPractice:
  - "Use RStudio Projects, not setwd()"
  - "Name objects for humans, not computers"
  - "Seed your bootstraps with set.seed() — always"
---

## The four criteria every reviewer checks

When you submit a paper using PLS-SEM with reflective constructs, there are four things every reviewer will evaluate before looking at your hypotheses:

1. **Indicator reliability** — does each item carry enough of its construct's variance?
2. **Internal consistency reliability** — do the items on a construct agree with each other?
3. **Convergent validity** — does the construct explain at least half the indicator variance?
4. **Discriminant validity** — are the constructs distinguishable from each other?

SEMinR gives you all four from a single `summary()` call. Here's the end-to-end workflow using the corporate reputation example from Chapter 4.

## The corporate reputation model

```r
library(seminr)
library(seminrExtras)

corp_rep_data <- corp_rep_data

# Measurement model
corp_rep_mm <- constructs(
  composite("COMP", multi_items("comp_", 1:3)),
  composite("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  composite("CUSL", multi_items("cusl_", 1:3)))

# Structural model
corp_rep_sm <- relationships(
  paths(from = c("COMP", "LIKE"), to = c("CUSA", "CUSL")),
  paths(from = c("CUSA"),         to = c("CUSL")))

# Estimate
corp_rep_pls_model <- estimate_pls(
  data              = corp_rep_data,
  measurement_model = corp_rep_mm,
  structural_model  = corp_rep_sm,
  missing           = mean_replacement,
  missing_value     = "-99")

summary_corp_rep <- summary(corp_rep_pls_model)
```

> **Note on `composite()`**: In SEMinR, `composite()` is the *estimation mode*, not a statement about whether your construct is reflectively or formatively measured. Reflective vs. formative is a question about how you *assess* the construct, which is what this video is about. We'll return to this distinction in the formative measurement video.

## 1. Indicator reliability

```r
summary_corp_rep$loadings
summary_corp_rep$loadings^2
```

Squaring the loading gives indicator reliability — the proportion of an item's variance explained by its construct. The conventional threshold is **0.708** (which squares to 0.50). Items between 0.40 and 0.708 should be deleted only if removing them raises composite reliability or AVE above threshold. Below 0.40: drop them.

## 2. Internal consistency reliability

```r
summary_corp_rep$reliability
plot(summary_corp_rep$reliability)
```

SEMinR reports Cronbach's alpha, rho_A, and composite reliability (rho_C). **Report rho_A as the primary measure** — Dijkstra and Henseler showed it's the consistent reliability estimator for PLS. It sits between alpha (lower bound) and rho_C (upper bound).

## 3. Convergent validity

AVE is in the same `$reliability` table. The floor is **0.50**: more than half of the indicator variance should be accounted for by the construct.

## 4. Discriminant validity with HTMT

```r
summary_corp_rep$validity$htmt
```

Fornell-Larcker is out. HTMT is in. Henseler, Ringle, and Sarstedt (2015) showed HTMT has much better detection rates for discriminant validity problems. Thresholds: **< 0.85** for conceptually distinct constructs, **< 0.90** for conceptually similar ones.

## Bootstrapped HTMT — the inferential test

```r
set.seed(123)
boot_corp_rep     <- bootstrap_model(corp_rep_pls_model, nboot = 1000)
sum_boot_corp_rep <- summary(boot_corp_rep, alpha = 0.10)
sum_boot_corp_rep$bootstrapped_HTMT
```

The stricter test: the upper bound of the 90% bootstrap CI on HTMT should not include 1. This is what reviewers increasingly expect in 2026.

> **R practice #3 — Seed your bootstraps.** `set.seed(123)` immediately before `bootstrap_model()` is a one-line insurance policy. Without it, every run produces slightly different CIs and your Table 3 becomes unreproducible. Do it every time.

## Bonus — the congruence coefficient

```r
congruence_test(corp_rep_pls_model, alpha = 0.10)$results
```

The congruence coefficient (Franke, Sarstedt, Danks, 2021) is a more stringent test of whether two construct scores capture the same underlying latent variable. Chapter 4 covers the theory.

## Going further

Full theoretical treatment is in **Chapter 4** of Hair et al. (2026). The next video in this series covers formative measurement — same workflow, completely different rules.
