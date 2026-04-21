---
title: "seminrExtras 1.0.0 — The Advanced PLS-SEM Toolkit in R"
topic: "seminrExtras"
chapter: 0
order: 7
summary: "seminrExtras is a companion package for seminr that ships the advanced PLS-SEM assessment methods that don't fit the base workflow — COA, NCA, NCA-ESSE, cIPMA, FIMIX-PLS, PLS-POS, CTA-PLS, PCM, CVPAT, and congruence testing. This tutorial links to a fully runnable walkthrough on the MOBI and corporate reputation datasets."
learningOutcomes:
  - "Install seminrExtras from CRAN and load it alongside seminr"
  - "Diagnose out-of-sample overfitting with Composite Overfit Analysis (assess_coa)"
  - "Test necessity with Necessary Condition Analysis and its Effect Size Sensitivity Extension (assess_nca, assess_nca_esse)"
  - "Build Combined Importance-Performance Maps that overlay NCA necessity (assess_cipma)"
  - "Uncover unobserved heterogeneity with FIMIX-PLS and PLS-POS (assess_fimix, assess_pos)"
  - "Confirm reflective measurement with CTA-PLS (assess_cta)"
  - "Evaluate the predictive contribution of mediators with PCM (assess_pcm)"
  - "Compare predictive ability across models with CVPAT (assess_cvpat_compare)"
videoStatus: planned
codeFile: "seminrExtras_1_0_demo.Rmd"
rPractice:
  - "Always seed your bootstraps and cross-validation folds with seed = 123"
  - "Stay in R for the full assessment workflow — one language, reproducible pipeline"
  - "Open issues on GitHub when something surprises you — it helps every future user"
---

## Overview

`seminrExtras` is a companion package for [`seminr`](https://cran.r-project.org/package=seminr) that ships the advanced PLS-SEM assessment methods that don't fit into the base `seminr` workflow — the things you usually end up writing custom scripts for, or reaching for another software package for.

The goal is simple: if you already use SEMinR to estimate your PLS-SEM models, you should be able to stay in R for the full modern toolkit of prediction, necessity, heterogeneity, measurement confirmation, and overfit diagnostics.

**Version 1.0.0 is now on CRAN.**

```r
install.packages("seminrExtras")
library(seminrExtras)
```

Requires `seminr` ≥ 2.4.0.

## Full runnable walkthrough

The runnable demo document walks through every feature end-to-end on the built-in MOBI customer satisfaction and corporate reputation datasets. A knitted version with all code output and plots is hosted here; the source `.Rmd` is also available for you to run locally.

- **[View the knitted walkthrough with output and plots →](/learn/seminrExtras_1_0_demo.html)**
- **[Download the source .Rmd →](/learn/seminrExtras_1_0_demo.Rmd)**
- **Gist mirror:** [gist.github.com/NicholasDanks/1dddab452c4fdbbce061a93d6a83aed1](https://gist.github.com/NicholasDanks/1dddab452c4fdbbce061a93d6a83aed1)
- **Package source and issues:** [github.com/sem-in-r/seminrExtras](https://github.com/sem-in-r/seminrExtras)

To run it yourself:

```r
download.file(
  "https://nicholasdanks.com/learn/seminrExtras_1_0_demo.Rmd",
  "seminrExtras_1_0_demo.Rmd"
)
rmarkdown::render("seminrExtras_1_0_demo.Rmd")
```

## What's in 1.0.0

### Composite Overfit Analysis (COA)

`assess_coa()` diagnoses *why* and *for whom* your PLS model fails to generalise out-of-sample. Predictive deviance, deviance trees, and unstable paths in one call.

```r
assess_coa(model, focal_construct = "CUSL", noFolds = 10, seed = 123)
```

### Necessary Condition Analysis (NCA)

`assess_nca()` runs NCA with fully internal CE-FDH and CR-FDH ceiling lines. No external NCA package dependency.

```r
assess_nca(model, target = "Satisfaction", test.rep = 1000, seed = 123)
```

### NCA-ESSE (Effect Size Sensitivity Extension)

`assess_nca_esse()` implements Becker et al. (2026) — varies the ECDF threshold to test how robust NCA conclusions are to extreme-response observations.

```r
assess_nca_esse(model, target = "Satisfaction",
                thresholds = seq(0, 0.05, by = 0.005), seed = 123)
```

### Combined IPMA (cIPMA)

`assess_cipma()` overlays NCA necessity onto the IPMA map. `assess_ipma()` is the IPMA-only convenience wrapper. Supports higher-order constructs, mediation, and moderation.

```r
assess_cipma(model, target = "Loyalty", scale_min = 1, scale_max = 10,
             nca_test.rep = 1000, seed = 123)
```

### FIMIX-PLS

`assess_fimix()` and `assess_fimix_compare()` implement EM-based latent-class segmentation with multi-start initialisation and information-criteria comparison across K.

```r
assess_fimix_compare(model, K_range = 2:4, nstart = 10, seed = 123)
```

### PLS-POS

`assess_pos()`, `assess_pos_compare()`, and `pos_segments()` implement prediction-oriented segmentation (Becker et al., 2013) that maximises ΣR² across segments — no distributional assumptions.

```r
assess_pos_compare(model, K_range = 2:4, nstart = 10, max_iter = 100, seed = 123)
```

### CTA-PLS

`assess_cta()` runs confirmatory tetrad analysis with automatic indicator-borrowing for constructs with fewer than 4 indicators (Gudergan et al., 2008).

```r
assess_cta(model, nboot = 5000, seed = 123)
```

### PCM (Predictive Contribution of the Mediator)

`assess_pcm()` evaluates whether a mediator actually improves out-of-sample prediction by comparing Direct-Antecedent and Earliest-Antecedent predictions on the isolated mediation sub-model (Danks, 2021). Mediation paths are auto-detected.

```r
assess_pcm(model, target = "Loyalty", noFolds = 10, reps = 10)
```

### CVPAT and congruence testing

`assess_cvpat()`, `assess_cvpat_compare()`, and `congruence_test()` round out the prediction and weight-stability toolkit.

```r
assess_cvpat_compare(established_model, alternative_model,
                     nboot = 2000, noFolds = 10, reps = 10, seed = 123)
```

## Every feature ships with

- `print()`, `summary()`, and `plot()` S3 methods
- A runnable `demo("seminr-pls-<feature>")` inside the package
- A 740+ test suite backing the whole codebase

## Feedback

If you hit something that doesn't work the way you expect, or want a method added, please open an issue: [github.com/sem-in-r/seminrExtras/issues](https://github.com/sem-in-r/seminrExtras/issues). That's the fastest way to get it on the roadmap, and it helps every future user.

## Acknowledgements

Huge thanks to Soumya Ray and the SEMinR team, and to Christian Ringle, José Luis Roldán, and Marko Sarstedt for their support and guidance along the way.
