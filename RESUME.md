# Resume point — nicholasdanks.com

**State (2026-09-11, end of day):** Everything is live at commit `6ae2744`. Next step is yours: run the Claude review once more with the conservative prompt and judge the tone; then design and record the YouTube video (board card exists). Nothing is blocked on anyone else.

## What changed today

- Housekeeping: site data consolidated (`src/data/site.ts`, `timeline.ts`), versions/downloads from the software collection, typography plugin, deps upgraded, README rewritten.
- New app `/seminr/` (replaces `/congruence/`, 301): `src/lib/seminr/` — parser, pipeline (`analyze.ts`), gates-vs-findings assessment (`assess.ts`), report (`report.ts`), page logic (`app.ts`), worker pool bootstrap (`bootstrap.ts`, `bootWorker.ts`, `replicate.ts`), congruence, R script.
- Textbook v2 compliance (checked against `system.file("demo", package="seminrExtras")` chap4–8): unidimensionality, redundancy analysis on `*_global`, HTMT at α = 0.10, one-tailed CVPAT, slope plots, υ, index of moderated mediation. R fixtures in `test/fixtures.R`, `test/fixtures-textbook.R`.
- Claude review assistant (`digest.ts`, `evaluator.ts`): BYOK direct to Anthropic, aggregate-only digest, `run_model` tool executed locally, conservative/suggestion framing, prompt caching, working banner + numbered alternative cards.
- Security: strict CSP (no inline scripts; `public/theme-init.js`; Astro `assetsInlineLimit: 0`), bounded parser, SVG sanitiser (`sanitize.ts`), XSS regression tests, prompt-injection hygiene. `test/csp-server.mjs` + `test/headless-*.mjs` + `test/mock-anthropic.mjs` verify a build under production headers in headless Chrome.

## Blocked / waiting

- Nothing blocked on others.
- On me (Nick): try the assistant with the new prompt; record the video; decide whether the private pls-sem knowledge base should drive the assistant (needs a server-side prompt, which contradicts the no-server story).

## Deliberately left undone

- Astro 7 upgrade (clears the three build-time `npm audit` items; major version, not urgent).
- `compare_models` tool for the assistant (BIC weights + CVPAT compare across specifications, book Ch. 6.4); currently Claude does it by hand with two `run_model` calls.
- Course entries in `src/data/courses/` still say 2024-25 is "current"; not verified.
- Chrome extension was disconnected most of the session; visual checks were via the headless harness, not screenshots.

## How to work here

`npm run dev` · `npm run check` · `npm test` (R-parity suite) · `npm run build`. Push to `main` deploys (Netlify, ~30 s). Any new inline script or external endpoint must be added to the CSP in `netlify.toml`.
