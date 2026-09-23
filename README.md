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

### The evaluation assistant

After a run, the page can ask a Gemini model (3.8 Flash by default; 3.6 Flash and the latest Pro selectable) to review the model and test its own suggestions. Design constraints, enforced in code:

- **The data never leaves the browser.** The model receives only the digest built by `src/lib/seminr/digest.ts`: aggregate statistics, column *names*, and the quality-gate flags. `digestLooksSafe()` refuses anything that looks like a numeric vector, and the page shows the exact system prompt and opening message under "What leaves the browser".
- **The model can run code, not read data.** Its one tool, `run_model`, hands SEMinR code back to the page; the page estimates it locally in a worker and returns another digest (`src/lib/seminr/evaluator.ts`).
- **A site key on Google's free tier, behind a relay.** The Gemini REST API (`streamGenerateContent` with function calling) is called without an SDK. On the site's shared review the browser posts to the same-origin relay `netlify/functions/gemini.mts` (`/api/gemini/<model>`), which adds the key from the server-side Netlify variable `GEMINI_SITE_KEY` and streams Google's SSE response back; the key is in no bundle. The relay checks the Origin (nicholasdanks.com and this site's Netlify deploy URLs), allows only the models in `EVALUATOR_MODELS`, caps the body at 2 MB and is rate-limited per IP by Netlify (30 requests/min). A forged Origin under the rate limit still gets through, so the Google project must never carry billing: the free-tier quota is the backstop. A visitor can paste their own key instead, which goes from the browser straight to Google (kept in `sessionStorage`, or `localStorage` on opt-in). The page discloses that the free tier lets Google use what is sent to improve its products. History: until Sep 2026 the key was compiled into the page as `PUBLIC_GEMINI_API_KEY` and was extractable; Google's AQ.-format auth keys cannot be referrer-restricted and are subject to leaked-key enforcement.

`test/mock-gemini.mjs` + `test/headless-evaluator.mjs` exercise the whole loop in headless Chrome against a fake endpoint that also checks nothing row-shaped is transmitted. `test/model-compare.mjs` runs the same review through several models on a demo digest and scores each transcript with `test/review-audit.mjs` (grounded numbers, forbidden phrasing, coverage, a rubric of facts per demo); `test/anthropic-transport.mjs` keeps Claude models comparable on identical inputs (dev dependency only; needs `ANTHROPIC_API_KEY`, plus `ANTHROPIC_WORKSPACE_ID` for a key not scoped to a workspace). Keys go in the gitignored `.env`.

## Content updates

- Publications: one Markdown file per paper in `src/data/publications/`. Citation counts are per-paper Google Scholar figures; the 2021 workbook's count is deliberately left out because Scholar merges it with the Hair et al. *Primer* family.
- Package versions and download counts on the software page come from `src/data/software/*.md`.
- CV timeline: `src/data/timeline.ts`. Bio and interests: `src/data/site.ts`.
