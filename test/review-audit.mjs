/**
 * Objective checks on a review transcript, shared by test/model-compare.mjs
 * and test/audit-review.mjs.
 *
 *   - ungrounded numbers: decimals in the review that appear in neither the
 *     digests sent nor the system prompt (crude fabrication signal; derived
 *     figures such as differences also land here, so read the list)
 *   - directive phrasing the prompt forbids
 *   - LaTeX spans (the page renders Markdown only)
 *   - coverage of the assessment areas the prompt asks for
 *   - rubric: facts a correct review of a given demo must state, and errors
 *     it must not make; scored as hits / total
 *
 * Substantive correctness still needs a human read of the transcripts.
 */
import { SYSTEM_PROMPT } from "../src/lib/seminr/evaluator.ts";

const numberSet = (text) => {
  const set = new Set();
  for (const m of text.matchAll(/-?\d+\.\d+|-?\d+/g)) {
    const v = Number(m[0]);
    if (!Number.isFinite(v)) continue;
    for (const dp of [0, 1, 2, 3]) { set.add(Number(v.toFixed(dp)).toString()); set.add(Number(Math.abs(v).toFixed(dp)).toString()); }
    set.add(m[0]);
  }
  return set;
};

export const AREAS = {
  loadings: /loading/i, reliability: /rho_?[AC]|rhoA|rhoC|alpha|reliab/i, ave: /\bAVE\b/, htmt: /HTMT/i, vif: /\bVIF/i,
  redundancy: /redundancy/i, htmtBound: /upper bound|bootstrap(?:ped)? bound|HTMT[^.]{0,40}(?:interval|CI)/i, paths: /path|β|beta|coefficient/i,
  r2: /R²|R\^2|R2|R-squared|r\.squared/i, f2: /f²|f\^2|f2|effect size/i, predict: /PLSpredict|RMSE|predict/i, cvpat: /CVPAT/i,
  mediation: /mediat|indirect/i, congruence: /congruen/i, sampleSize: /sample size|inverse square|cases|\bN\s*=/i,
};

/**
 * Facts a correct review must state (must) and mistakes it must not make
 * (mustNot), per demo. Regexes are deliberately loose on wording and strict
 * on the decisive number.
 */
export const RUBRICS = {
  "corp-rep": {
    must: [
      { name: "n = 344", re: /\b344\b/ },
      { name: "reflective loadings pass (min 0.817)", re: /0\.817|all (?:outer )?loadings[^\n]{0,60}(?:≥|>=|above|exceed)[^\n]{0,20}0\.70?8|loadings[^\n]{0,40}0\.708/i },
      { name: "AVE floor 0.688", re: /0\.688/ },
      { name: "non-significant weights named (qual_4, csor_2)", re: /qual_4[\s\S]{0,400}csor_2|csor_2[\s\S]{0,400}qual_4/ },
      { name: "weak weights retained via loading ≥ 0.50", re: /loading[^\n]{0,80}(?:≥|>=|above|exceed|over)[^\n]{0,10}0\.50?\b|0\.50?\b[^\n]{0,60}loading/i },
      { name: "indicator VIF max 2.269", re: /2\.269/ },
      { name: "redundancy paths 0.805–0.874", re: /0\.805[\s\S]{0,80}0\.874|0\.874[\s\S]{0,80}0\.805/ },
      { name: "HTMT LIKE–COMP 0.780", re: /0\.78\b|0\.780/ },
      { name: "HTMT upper bound 0.843 reported", re: /0\.843/ },
      { name: "0.843 discussed as close to 0.85", re: /0\.843[^\n]{0,120}(?:close|near|approach|border|just|tight|margin|within)|(?:close|near|approach|border|just|tight|margin|within)[^\n]{0,120}0\.843/i },
      { name: "antecedent VIF 3.487 flagged", re: /3\.487/ },
      { name: "COMP → CUSL 0.006 not significant", re: /0\.006/ },
      { name: "CSOR → COMP, ATTR → COMP, PERF → LIKE not detected", re: /CSOR[^\n]{0,40}COMP[\s\S]{0,600}PERF[^\n]{0,40}LIKE|PERF[^\n]{0,40}LIKE[\s\S]{0,600}CSOR[^\n]{0,40}COMP/ },
      { name: "CUSA → CUSL 0.505 / f² 0.403", re: /0\.505[\s\S]{0,200}0\.403|0\.403[\s\S]{0,200}0\.505/ },
      { name: "R² CUSL 0.562", re: /0\.562/ },
      { name: "CUSL predictive power high (3/3 vs LM)", re: /CUSL[^\n]{0,120}(?:high|3\s*(?:\/|of|out of)\s*3)|(?:high|3\s*(?:\/|of|out of)\s*3)[^\n]{0,120}CUSL/i },
      { name: "CUSA has no predictive power vs LM", re: /CUSA[^\n]{0,160}(?:no predictive|none|0\s*(?:\/|of|out of)\s*1|not beat|worse than|below the LM|fails? to beat|LM[^\n]{0,30}(?:beats|outperform))/i },
      { name: "CVPAT beats IA and LM", re: /CVPAT[\s\S]{0,300}(?:LM|linear model)[\s\S]{0,200}(?:IA|indicator average)|CVPAT[\s\S]{0,300}(?:IA|indicator average)[\s\S]{0,200}(?:LM|linear model)/i },
      { name: "LIKE → CUSA → CUSL complementary", re: /LIKE[^\n]{0,60}CUSA[^\n]{0,60}CUSL[^\n]{0,220}complementary|complementary[^\n]{0,220}LIKE[^\n]{0,60}CUSA[^\n]{0,60}CUSL/i },
      { name: "COMP → CUSA → CUSL indirect-only", re: /COMP[^\n]{0,60}CUSA[^\n]{0,60}CUSL[^\n]{0,220}indirect[- ]only|indirect[- ]only[^\n]{0,220}COMP[^\n]{0,60}CUSA[^\n]{0,60}CUSL/i },
      { name: "congruence: all pairs distinguishable", re: /congruen[\s\S]{0,300}(?:all[^\n]{0,40}distinguishable|distinguishable[^\n]{0,40}all|no pair[^\n]{0,60}redundan|none[^\n]{0,40}(?:reach|redundan)|every pair)/i },
      { name: "hypothesised model kept as first option", re: /(?:option (?:1|a|one)|first option|^\s*1\.\s)[^\n]{0,160}(?:retain|keep|maintain|current|hypothesi[sz]ed|original|baseline)/im },
    ],
    mustNot: [
      { name: "claims HTMT discriminant validity fails", re: /HTMT[^\n]{0,80}(?:fails|violat|breach|not (?:establish|support))/i },
      { name: "instructs removal of an indicator or path", re: /\b(?:you must|you should|you need to)\b[^\n]{0,60}(?:drop|remove|delete|prune)/i },
      { name: "reads non-significant added paths as proof of full mediation", re: /(?:confirm|prove|establish)[^\n]{0,80}full(?:y)? mediat/i },
      { name: "requests alpha/rho/AVE for formative constructs", re: /(?:alpha|rho_?[AC]|AVE)[^\n]{0,60}(?:QUAL|PERF|CSOR|ATTR)[^\n]{0,60}(?:not (?:reported|available|provided)|missing|should be reported)/i },
      { name: "invokes epistemic rho", re: /epistemic/i },
    ],
  },
  moderation: {
    must: [
      { name: "n = 344", re: /\b344\b/ },
      { name: "SC–COMP HTMT 0.850 flagged", re: /0\.850?\b/ },
      { name: "SC–COMP upper bound 0.902 (≥ 0.90)", re: /0\.902/ },
      { name: "SC–LIKE upper bound 0.860 mentioned", re: /0\.860?\b/ },
      { name: "interaction β −0.071 significant", re: /-?0\.071/ },
      { name: "moderation read as weakening the CUSA → CUSL effect", re: /(?:weaken|dampen|attenuat|reduce|diminish|smaller|negative(?:ly)? moderat)/i },
      { name: "interaction f² 0.014 reported", re: /0\.014/ },
      { name: "interaction f² judged by Kenny's 0.005/0.01/0.025", re: /Kenny|0\.005|0\.025/ },
      { name: "SC → CUSL 0.069 not detected", re: /0\.069/ },
      { name: "CVPAT does not beat LM (p = 0.489)", re: /0\.489|(?:not|no)[^\n]{0,60}(?:beat|outperform|better than|exceed|advantage over)[^\n]{0,40}(?:LM|linear)|(?:LM|linear model)[^\n]{0,60}(?:not (?:significant|beaten)|no (?:significant )?(?:difference|advantage))|(?:equal|on par|indistinguishable)[^\n]{0,40}(?:LM|linear)/i },
      { name: "CVPAT beats IA (−0.738)", re: /-?0\.738/ },
      { name: "CUSL predictive power high (3/3 vs LM)", re: /CUSL[^\n]{0,120}(?:high|3\s*(?:\/|of|out of)\s*3)|(?:high|3\s*(?:\/|of|out of)\s*3)[^\n]{0,120}CUSL/i },
      { name: "CUSA has no predictive power vs LM", re: /CUSA[^\n]{0,160}(?:no predictive|none|0\s*(?:\/|of|out of)\s*1|not beat|worse than|below the LM|fails? to beat|LM[^\n]{0,30}(?:beats|outperform))/i },
      { name: "index of moderated mediation significant (−0.012, −0.030)", re: /-?0\.012[\s\S]{0,300}-?0\.030?\b|-?0\.030?\b[\s\S]{0,300}-?0\.012/ },
      { name: "COMP → CUSA → CUSL indirect-only", re: /COMP[^\n]{0,60}CUSA[^\n]{0,60}CUSL[^\n]{0,220}indirect[- ]only|indirect[- ]only[^\n]{0,220}COMP[^\n]{0,60}CUSA[^\n]{0,60}CUSL/i },
      { name: "LIKE → CUSA → CUSL complementary", re: /LIKE[^\n]{0,60}CUSA[^\n]{0,60}CUSL[^\n]{0,220}complementary|complementary[^\n]{0,220}LIKE[^\n]{0,60}CUSA[^\n]{0,60}CUSL/i },
      { name: "R² CUSL 0.571", re: /0\.571/ },
      { name: "hypothesised model kept as first option", re: /(?:option (?:1|a|one)|first option|^\s*1\.\s)[^\n]{0,160}(?:retain|keep|maintain|current|hypothesi[sz]ed|original|baseline)/im },
    ],
    mustNot: [
      { name: "claims PLS beats LM in CVPAT", re: /CVPAT[^\n]{0,160}(?:beats|outperforms|superior to|better than)[^\n]{0,30}(?:the )?(?:LM|linear[- ]model)/i },
      { name: "instructs removal of an indicator or path", re: /\b(?:you must|you should|you need to)\b[^\n]{0,60}(?:drop|remove|delete|prune)/i },
      { name: "reads non-significant added paths as proof of full mediation", re: /(?:confirm|prove|establish)[^\n]{0,80}full(?:y)? mediat/i },
      { name: "invokes epistemic rho", re: /epistemic/i },
    ],
  },
};

export function audit(text, grounding, demo) {
  const known = numberSet(grounding + "\n" + SYSTEM_PROMPT);
  const cited = [...text.matchAll(/(?<![\w.])-?\d+\.\d{2,}(?![\w.])/g)].map((m) => m[0]);
  // Unicode minus and en dash are treated as signs by readers, not by Number(); compare magnitudes.
  const ungrounded = [...new Set(cited.filter((c) => !known.has(Number(c).toString()) && !known.has(c)))];
  const directive = [...text.matchAll(/\b(you must|you should|you need to|do not report|must not|drop (?:the|this|it|indicator|item|path)|remove (?:the|this|it|indicator|item|path)|delete (?:the|this|it))\b/gi)].map((m) => m[0]);
  const latex = (text.match(/\$[^$\n]+\$/g) ?? []).length;
  const coverage = Object.fromEntries(Object.entries(AREAS).map(([k, re]) => [k, re.test(text)]));
  const rubric = RUBRICS[demo];
  let score = null;
  if (rubric) {
    const hits = rubric.must.filter((r) => r.re.test(text)).map((r) => r.name);
    const misses = rubric.must.filter((r) => !r.re.test(text)).map((r) => r.name);
    const errors = rubric.mustNot.filter((r) => r.re.test(text)).map((r) => r.name);
    score = { hits, misses, errors, value: (hits.length - errors.length) / rubric.must.length };
  }
  return { citedNumbers: cited.length, ungrounded, directive, latex, coverage, score, words: text.split(/\s+/).filter(Boolean).length };
}

export function auditLines(a) {
  const areaKeys = Object.keys(AREAS);
  const lines = [
    `- words: ${a.words}; numbers cited: ${a.citedNumbers}; ungrounded: ${a.ungrounded.length}${a.ungrounded.length ? ` (${a.ungrounded.join(", ")})` : ""}`,
    `- directive phrasing: ${a.directive.length}${a.directive.length ? ` (${a.directive.join("; ")})` : ""}; LaTeX spans: ${a.latex}`,
    `- coverage: ${areaKeys.map((k) => `${a.coverage[k] ? "✓" : "✗"} ${k}`).join("  ")}`,
  ];
  if (a.score) {
    lines.push(`- rubric: ${a.score.hits.length}/${a.score.hits.length + a.score.misses.length} facts, ${a.score.errors.length} errors, score ${a.score.value.toFixed(2)}`);
    if (a.score.misses.length) lines.push(`  - missed: ${a.score.misses.join("; ")}`);
    if (a.score.errors.length) lines.push(`  - errors: ${a.score.errors.join("; ")}`);
  }
  return lines;
}
