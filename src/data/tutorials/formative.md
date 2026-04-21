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
videoStatus: planned
codeFile: "seminr-primer-v2-chap5.R"
rPractice:
  - "Comment the *why*, not the *what*"
---

## Coming soon

This tutorial pairs with Video 2 in the series. Full write-up will land when the video is published. In the meantime, Chapter 5 of Hair et al. (2026) has the complete theoretical treatment, and the code file `seminr-primer-v2-chap5.R` in the companion repo has the runnable example.

## What this tutorial will cover

- Why the `composite()` / `reflective()` choice in SEMinR is *separate* from the formative/reflective assessment decision
- Redundancy analysis — the cleanest test for convergent validity in formatively measured constructs
- VIF thresholds and what to do when collinearity is too high
- Reading outer weights vs outer loadings and which one matters for which argument
