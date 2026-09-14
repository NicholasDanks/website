# Resume point — nicholasdanks.com

**State (2026-09-14, end of day):** Working tree has an uncommitted, fully verified change set (astro check, build, headless browser test, R-parity suite all pass). Nick has not asked to commit or deploy yet. Next step is his: read the summary below, try the assistant on the live page once it is pushed, and decide whether epistemic rho should also leave the page's own report.

## What changed today

- **Review assistant moved from Anthropic to Gemini** (`src/lib/seminr/evaluator.ts` rewritten): browser calls `generativelanguage.googleapis.com` directly over REST with SSE streaming and function calling, no SDK bundled (`@anthropic-ai/sdk` is now a dev dependency only). Model dropdown on the page: gemini-3.8-flash (default), gemini-3.6-flash, gemini-pro-latest. Page copy discloses that a free-tier key lets Google use the aggregate digest to improve products. CSP `connect-src` in `netlify.toml` now names the Gemini host. Old Anthropic storage keys are cleared on load.
- **Epistemic rho removed from the review** (unpublished): stripped from the digest and its gate lines, gone from the prompt. Still shown on the page's own report.
- **Digest bugs fixed:** the HTMT bootstrap upper bound was looked up under the paths matrix's column name and was always null; a passing HTMT gate never reached the model, so a bound near 0.85 now warns.
- **Compact digest** (`buildDigest(..., { compact: true })`, the page default): gates only, per-item summary, congruence summary, mediation CIs added. Halves input tokens with no measured accuracy loss.
- **Prompt engineered to v4** with a scored harness: `test/model-compare.mjs` (runs a review through Gemini or Claude on a demo digest), `test/review-audit.mjs` (ungrounded numbers, directive phrasing, LaTeX, coverage, per-demo rubric of 22 / 18 facts), `test/run-model-cli.mjs` + `test/audit-review.mjs` (for a subagent reviewer), `test/anthropic-transport.mjs` (Claude comparison arm; needs `ANTHROPIC_API_KEY` and, for an unscoped key, `ANTHROPIC_WORKSPACE_ID`). Results: v4 + compact on Gemini 3.8 Flash = 20 and 22 of 22 (corp-rep), 18 of 18 twice (moderation), ~US$0.037 paid-tier equivalent, free on the free tier; baseline v1 + verbose digest = 22 and 18, 17, ~US$0.056. Sonnet 5 as a Claude Code subagent on the same prompt and digest: 21 of 22 twice, deeper robustness reasoning, ~1.5× longer. Low thinking level: cheapest and least accurate, rejected.
- Keys live in the gitignored `.env`; the Anthropic key there is valid but unscoped (needs a workspace id or a workspace-scoped key); the first key Nick pasted was rejected and both keys appeared in chat, so rotate when convenient.

## Blocked / waiting

- Nothing blocked on others. Deploy = commit + push to `main` (Netlify).

## Deliberately left undone

- Epistemic rho still shows on the page's report table (only the review was asked to drop it).
- No Claude API arm was run (workspace id missing); Sonnet comparison came from a subagent with a CLI stand-in for run_model, so its token counts were not measured.
- Astro 7 upgrade; `compare_models` tool; course entries "current" year not verified; YouTube video.

## How to work here

`npm run dev` · `npm run check` · `npm test` (R-parity suite) · `npm run build`. Prompt or digest changes: run `set -a; source .env; set +a; npx tsx test/model-compare.mjs --repeat 2` and `--demo moderation`, compare `summary.md` rubric columns before shipping. Any new external endpoint must be added to the CSP in `netlify.toml`.
