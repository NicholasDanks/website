# nicholasdanks.com

Personal academic website of Nicholas P. Danks: an [Astro 5](https://astro.build) static site styled with Tailwind CSS 4, deployed by Netlify from the `main` branch.

## Structure

| Path | What it is |
| --- | --- |
| `src/pages/` | Routes (`/`, `/research`, `/teaching`, `/software`, `/learn`, `/cv`, `/contact`, `/seminr`) |
| `src/data/` | Content collections (publications, courses, software, tutorials) and site-wide data (`site.ts`, `timeline.ts`) |
| `src/content.config.ts` | Collection schemas |
| `src/components/`, `src/layouts/` | Astro components and page layouts |
| `src/lib/seminr/` | The in-browser PLS-SEM app: SEMinR DSL parser, estimation pipeline on `@seminr/core` / `@seminr/extras`, R RNG port, congruence test, threshold assessment, report renderer, Web Worker |
| `public/learn/` | Knitted R companion documents and slides (static, multi-MB) |
| `public/seminr-demo/` | Demo dataset for the SEMinR app |
| `test/` | Parity tests against R (`fixtures*.txt` are R-generated ground truth; `fixtures.R` regenerates them) |

`Quarto/` (the book-companion source, its own git repo) and `congruence shiny app/` (the retired R Shiny version of the congruence test) live in the working tree but are not tracked here.

## Commands

```sh
npm install
npm run dev        # http://localhost:4321
npm run build      # -> dist/
npm run preview
npm run check      # astro check (TypeScript + Astro diagnostics)
npm test           # R-parity test suite (RNG, congruence test, full seminr pipeline)
```

## The SEMinR app (`/seminr/`)

Estimates a PLS-SEM model from pasted SEMinR code and indicator data entirely in the browser (a Web Worker; nothing is uploaded), then bootstraps it, runs PLSpredict, CVPAT and the bootstrapped congruence test, assesses every result against the *PLS-SEM Using R* thresholds, draws the path diagram with wasm Graphviz, and offers a standalone HTML report, a JSON bundle of all results, and an R script that reproduces the run.

The bootstrap and the congruence test share one replication pass over an R-RNG index stream, split across a pool of nested Web Workers (`src/lib/seminr/bootstrap.ts`, `bootWorker.ts`); a full default run of the textbook model takes about five seconds on a 12-core laptop. `test/headless-run.mjs` times a run in headless Chrome over the DevTools protocol.

Parity with R is tested, not assumed: `test/seminr-parity.mjs` compares the summary tables and PLSpredict with seminr 2.6.0 output, and `test/congruence-parity.mjs` reproduces `seminrExtras::congruence_test()` bit-for-bit (the bootstrap draws come from a port of R's Mersenne-Twister and sampling routines in `src/lib/seminr/rrng.ts`). Bootstrap intervals cannot match R digit for digit because `bootstrap_model()` draws on a parallel RNG stream; the page says so.

The JSON bundle (`AnalysisResult` in `src/lib/seminr/analyze.ts`, `schemaVersion: 1`) is the hand-off point for the planned model-evaluation assistant: model spec, options, every table, and the assessment flags in one self-describing object.

## Content updates

- Publications: one Markdown file per paper in `src/data/publications/`. Citation counts are per-paper Google Scholar figures; the 2021 workbook's count is deliberately left out because Scholar merges it with the Hair et al. *Primer* family.
- Package versions and download counts on the software page come from `src/data/software/*.md`.
- CV timeline: `src/data/timeline.ts`. Bio and interests: `src/data/site.ts`.
