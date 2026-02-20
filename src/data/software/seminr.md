---
title: "SEMinR"
tagline: "A Domain-Specific Language for Building and Estimating Structural Equation Models in R"
role: "Co-Creator & Maintainer"
cran: "https://cran.r-project.org/package=seminr"
github: "https://github.com/sem-in-r/seminr"
version: "2.3.3"
downloads: "70,000+"
featured: true
---

SEMinR provides researchers and practitioners with an intuitive, syntax-driven approach to specifying and estimating structural equation models in R. Designed with a domain-specific language (DSL), SEMinR allows users to describe their measurement and structural models using natural, human-readable syntax that closely mirrors how researchers conceptualize their models.

## Key Features

- **Natural Model Syntax**: Specify measurement models and structural relationships using intuitive functions like `constructs()`, `relationships()`, and `paths()` that read like model descriptions rather than matrix operations.
- **PLS-SEM & CB-SEM Support**: Estimate models using both partial least squares (PLS-PM) and covariance-based (CB-SEM via lavaan) approaches within a unified interface.
- **Comprehensive Evaluation**: Built-in functions for assessing reliability (e.g., Cronbach's alpha, composite reliability), validity (e.g., HTMT, discriminant validity), and model fit.
- **Prediction & Cross-Validation**: Integrated out-of-sample prediction capabilities using PLSpredict, allowing researchers to evaluate the predictive power of their models.
- **Bootstrapping**: Efficient bootstrapping procedures for inference, including confidence intervals and significance testing for path coefficients and indirect effects.
- **Visualization**: Generate path diagrams and result plots directly from estimated models.

## Design Philosophy

SEMinR was developed with the belief that statistical software should be accessible to domain researchers, not just statisticians. By providing a clean DSL, SEMinR reduces the cognitive overhead of translating conceptual models into code, lowering the barrier to entry for rigorous SEM analysis while maintaining the flexibility that advanced users require.
