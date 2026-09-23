# Resume point — nicholasdanks.com

**State (2026-09-17, end of day):** The UX pass on `/seminr/` is LIVE (commit 4fb5e8d, deployed ~30 s after the push; a corporate reputation demo run on the live site succeeded with 0 console/CSP errors). Nothing blocked. Next steps are Nick's: (1) rotate the Gemini and Anthropic keys that appeared in chat on 14 Sep; (2) decide whether epistemic rho should stay in the page's own report; (3) optional polish, listed below.

## What changed on 17 Sep (UX pass)

- **Two-tier quality gates** (`assess.ts`: `advisory`, `needsAction`, `worthALook`; `tallyGates` counts advisory checks separately). "Worth a look — no action required" = a non-significant formative weight with loading ≥ 0.50, an HTMT upper bound 0.80–0.85, or a VIF 3–5; shown in blue, collapsed. The status stays `warn`, so the Gemini digest is byte-for-byte unchanged and the 14 Sep prompt scores still apply.
- **Summary** (`report.ts`) now covers structural VIF and congruence gates, so it agrees with "All N quality gates"; progress says "134 quality gates, 49 findings".
- **Gemini review moved under the Summary**: `#results-summary` container in `index.astro`, then `#evaluate`, then `#results-body`; "Gemini review" is second in the sticky nav. The run-comparison line uses the three tiers.
- HTMT matrix greys pairs it does not assess (they used to show red). CVPAT tables rebuilt; numeric headers right-aligned; Copy TSV buttons labelled; fixed "p = < 0.001", the uppercased α, "; …." and single-value Q² ranges.
- Diagrams taller than 70% of the window, or shown below 60% of natural size, get a fixed box plus an "Open full size" zoom dialog (`fitDiagram`/`openDiagram` in `app.ts`).
- Phones: gate rows stack as cards; the sticky nav scrolls in one line (113 → 65 px).
- Page (`index.astro`): demo strip above the inputs; privacy panel slimmed to one statement plus a disclosure that names both possible requests (demo data, Gemini review); R-agreement paragraph moved to "What is computed"; Cancel no longer visible when idle (`inline-flex` beat `hidden` → `[&:not(.hidden)]:inline-flex`); stale "your own API key" / "Load demo" copy fixed.
- Tested: `npm run check`, `npm test`, `npm run build`, `test/headless-evaluator.mjs` against the mock (0 CSP violations), and headless-Chrome screenshots at 1440/390 px in light and dark.

## Still open / optional polish

- Not tested: a live Gemini review, keyboard navigation, the downloaded standalone HTML report after these changes.
- Summary lists repeat the criterion ("Outer weight qual_2 → QUAL; Outer weight qual_3 → QUAL …"); could be grouped.
- Dark mode: the path diagram stays a white panel (left deliberately).

## Earlier (14 Sep)

### What changed on 14 Sep

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

## 2026-09-23 — Gemini key moved behind a relay (PR #1, merged 98e16d0)

The site key is no longer in the page. `netlify/functions/gemini.mts` relays `/api/gemini/<model>`
with `GEMINI_SITE_KEY` (Netlify, server-side only); a visitor's own key still goes browser → Google.
Tests: `npx tsx test/gemini-relay.mjs` (16 checks); `test/relay-server.mjs` serves dist/ with the
relay for the headless review (`node test/mock-gemini.mjs &` first). Deploy previews work (same-origin
rule). Local `.env` now holds only `GEMINI_API_KEY` (LOCAL key); `PUBLIC_GEMINI_API_KEY` is gone
everywhere. Unverified: whether Netlify's function rate limit is active on this plan; Gemini Pro
turns against the 60 s function limit.
