---
title: "Mediation Analysis"
topic: "Mediation"
chapter: 8
order: 4
summary: "Testing mediation in PLS-SEM: specific indirect effects, total indirect effects, and the Zhao, Lynch & Chen typology of full, partial, complementary, and competitive mediation."
learningOutcomes:
  - "Specify a mediation model in SEMinR"
  - "Extract specific and total indirect effects"
  - "Apply the Zhao et al. typology to classify mediation types"
  - "Report bootstrap confidence intervals for indirect effects the way reviewers expect"
videoStatus: published
videoUrl: "https://youtu.be/2SpMM6wibHI"
slidesFile: "mediation-slides.pptx"
durationMinutes: 11
codeFile: "seminr-primer-v2-chap8.R"
rPractice:
  - "Save bootstrap artifacts with saveRDS() instead of re-running every session"
companionAnchor: sec-mediation
---

## The 0.006 path that was not dead

The structural lesson ended on a puzzle. Competence has essentially no direct effect on loyalty — 0.006, p = 0.84 — while likeability carries 0.34. The obvious reading is that competence is irrelevant.

That reading is wrong, and mediation analysis is how you prove it. An effect can travel entirely through a middleman.

> **A note on this model.** Chapter 8 runs mediation on the *full extended* model, with the four formative drivers. This lesson keeps the simpler core model (COMP, LIKE, CUSA, CUSL) for teaching clarity, so the magnitudes differ from the book's. The techniques are identical.

## Setting up

A mediator transmits an effect. The **indirect effect** is the *product* of the two legs — COMP → CUSA times CUSA → CUSL. The **total effect** is direct plus indirect. The useful question is never "is there mediation" but *which kind*.

```r
library(seminr)

corp_rep_sm <- relationships(
  paths(from = c("COMP", "LIKE"), to = c("CUSA", "CUSL")),
  paths(from = c("CUSA"),         to = c("CUSL")))

set.seed(123)
corp_rep_boot <- bootstrap_model(corp_rep_pls_model, nboot = 1000)
corp_rep_boot_summary <- summary(corp_rep_boot, alpha = 0.05)
```

> **R practice — save your bootstrap.** Bootstrapping is the expensive step. `saveRDS(corp_rep_boot, "outputs/corp_rep_boot.rds")` means reopening the project tomorrow does not mean waiting on 10,000 resamples again.

## 1. Are the indirect effects significant?

```r
corp_rep_summary$total_indirect_effects

specific_effect_significance(corp_rep_boot,
                             from = "COMP", through = "CUSA", to = "CUSL",
                             alpha = 0.05)
specific_effect_significance(corp_rep_boot,
                             from = "LIKE", through = "CUSA", to = "CUSL",
                             alpha = 0.05)
```

`specific_effect_significance()` bootstraps the **product** of the two legs directly. This is the correct test — no Sobel approximation, no normality assumption about a product of coefficients.

- COMP through CUSA: **0.082**, CI 0.018 to 0.151 — significant
- LIKE through CUSA: **0.214**, CI 0.146 to 0.286 — significant

Both indirect paths are real.

## 2. Are the direct effects significant?

```r
corp_rep_boot_summary$bootstrapped_paths
```

- LIKE → CUSL: **0.342**, significant
- COMP → CUSL: **0.009**, CI spans zero — nothing, exactly as before

## 3. Classify with Zhao, Lynch & Chen (2010)

Forget Baron and Kenny; the field has moved on. The modern typology needs only your two significance tests, plus the sign of the direct × indirect product:

| Indirect | Direct | Signs | Type |
| --- | --- | --- | --- |
| Significant | Significant | Same | **Complementary** mediation |
| Significant | Significant | Opposite | **Competitive** mediation |
| Significant | Not significant | — | **Indirect-only** mediation |
| Not significant | Significant | — | Direct-only, no mediation |
| Not significant | Not significant | — | No effect |

```r
sign(corp_rep_summary$paths["LIKE", "CUSL"] *
     corp_rep_summary$paths["LIKE", "CUSA"] *
     corp_rep_summary$paths["CUSA", "CUSL"])
```

Applying it:

- **COMP** — indirect significant, direct not: **indirect-only mediation.** Competence affects loyalty *entirely* through satisfaction.
- **LIKE** — both significant, same sign: **complementary mediation.** Satisfaction transmits part of likeability's effect; the rest flows direct.

## Why this matters more than the statistics

This is the reason you never delete a predictor because its direct path is flat. Competence drives satisfaction; satisfaction drives loyalty. Skip the mediation analysis and you would have discarded a genuine driver of loyalty on the strength of a 0.006 coefficient.

Managerially the two constructs now have different jobs: competence is a **satisfaction lever**, likeability is *both* a satisfaction lever **and** a direct loyalty lever.

## Going further

Chapter 8 of Hair et al. (2026) has the full treatment, including moderated mediation. Next: **moderation** — when a relationship's *strength* depends on a third variable.
