---
title: "Moderation Analysis"
topic: "Moderation"
chapter: 7
order: 5
summary: "Testing moderation with interaction terms in SEMinR: two-stage vs product-indicator approaches, interpreting the interaction coefficient, and visualizing simple slopes."
learningOutcomes:
  - "Specify an interaction term in SEMinR using interaction_term()"
  - "Choose between two-stage and product-indicator estimation, and know why it matters"
  - "Interpret the interaction coefficient correctly — sign, magnitude, and significance"
  - "Produce simple-slopes plots for presentation"
videoStatus: published
videoUrl: "https://youtu.be/yzoONNsk5ho"
slidesFile: "moderation-slides.pptx"
durationMinutes: 22
codeFile: "seminr-primer-v2-chap7.R"
rPractice:
  - "Use version control — even a solo analysis deserves a Git history"
companionAnchor: sec-moderation
---

## When the coefficient is not a constant

Satisfaction drives loyalty — about 0.50 in the structural lesson. But does it drive loyalty *equally* for a customer who can walk away tomorrow and one who is locked into a contract?

That is moderation. A mediator *transmits* an effect; a moderator *changes its strength*. Formally, the CUSA → CUSL coefficient stops being a constant and becomes a line: a base effect plus an interaction weight times the moderator.

## Building the interaction term

```r
library(seminr)

corp_rep_mm_mod <- constructs(
  composite("COMP", multi_items("comp_", 1:3)),
  composite("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  composite("SC",   multi_items("switch_", 1:4)),
  composite("CUSL", multi_items("cusl_", 1:3)),
  interaction_term(iv = "CUSA", moderator = "SC", method = two_stage))

corp_rep_sm_mod <- relationships(
  paths(from = c("COMP", "LIKE"),          to = c("CUSA", "CUSL")),
  paths(from = c("CUSA", "SC", "CUSA*SC"), to = c("CUSL")))
```

There are three ways to build the term. **Product-indicator** multiplies all indicator pairs — only defensible with reflective measures. **Orthogonalization** fixes multicollinearity but complicates interpretation. **Two-stage** uses construct scores from a first-stage model: it works with *any* measurement mode — including our single-item CUSA — and has the best statistical power. Default to two-stage.

Note that SC enters the structural model **twice**: as a direct predictor of loyalty and inside the interaction term. You must always include the moderator's main effect. R² for loyalty ticks up from 0.56 to 0.57.

## Is the interaction significant?

```r
set.seed(123)
corp_rep_boot_mod <- bootstrap_model(corp_rep_pls_model_mod, nboot = 1000)
summary(corp_rep_boot_mod, alpha = 0.05)$bootstrapped_paths |> round(3)
```

The interaction is **−0.071**, CI −0.136 to −0.009 — excludes zero, significant. The negative sign says: the higher the switching costs, the *weaker* the satisfaction-to-loyalty link.

SC's own direct effect is not significant. That is fine, and it stays in the model regardless.

## Effect size — use the right benchmark

```r
corp_rep_summary_mod$fSquare
```

Interaction f² is **0.014**. Against Cohen's usual 0.02 / 0.15 / 0.35 that looks negligible — but interaction effects are *systematically* small, and judging them by Cohen's benchmarks understates every moderation ever published.

Use **Kenny's (2018) benchmarks for moderation: 0.005 small, 0.01 medium, 0.025 large.** By those, 0.014 is a solid medium effect. Cite the right benchmark, or a reviewer will do it for you.

## Simple slopes — the figure for your paper

```r
slope_analysis(moderated_model = corp_rep_pls_model_mod,
               dv = "CUSL", moderator = "SC", iv = "CUSA",
               leg_place = "bottomright")
```

Note this takes the estimated **model**, not the bootstrap object.

Three lines: satisfaction → loyalty at low, mean, and high switching costs. At low SC the slope is steepest, around 0.54; at high SC it flattens to roughly 0.40. All three remain positive — satisfaction always helps, it simply buys less loyalty when customers are already captive.

Managerially: in high-switching-cost segments (contracts, ecosystems) satisfaction investments return less loyalty, because loyalty is partly involuntary. In low-switching-cost segments satisfaction is your main defence.

## Categorical moderation is multigroup analysis

Here is why the textbook puts MGA in the moderation chapter. We just moderated with a *continuous* variable. A moderator can equally be **categorical** — a group. Same question, group instead of scale.

```r
table(corp_rep_data$servicetype)   # 125 vs 219

set.seed(123)
corp_rep_mga <- estimate_pls_mga(corp_rep_pls_model,
                                 corp_rep_data$servicetype == 1,
                                 nboot = 1000)
corp_rep_mga
```

**Henseler's MGA p-value is one-sided.** A path differs at the 5% level when p < .05 (group 1's path is larger) *or* p > .95 (group 2's is larger). Reading it as a conventional two-sided p is a common and consequential error.

Three of five paths differ across service types. Competence buys loyalty only in group 1; likeability matters roughly twice as much in group 2; satisfaction converts to loyalty more in group 1. The pooled model averaged all three differences away.

> **One caveat before you trust any of this: measurement invariance.** Run MICOM (Henseler, Ringle & Sarstedt, 2016) before comparing groups, or apparent path differences may just be measurement differences. MICOM is beyond the workbook's scope, but the obligation is not optional.

> **R practice — use version control.** Even a solo analysis deserves a Git history. "Which version produced Table 3?" should never be a guess.

## Going further

Chapter 7 of Hair et al. (2026) covers both moderation and multigroup analysis. That completes the core series — the **seminrExtras** lesson introduces the advanced toolkit beyond the textbook.
