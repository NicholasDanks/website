import fs from 'node:fs';
import { runIndicatorRoute } from './src/lib/congruence/runIndicator.ts';
const code = `mm <- constructs(
  reflective("COMP", multi_items("comp_", 1:3)),
  reflective("LIKE", multi_items("like_", 1:3)),
  composite("CUSA", single_item("cusa")),
  reflective("CUSL", multi_items("cusl_", 1:3)))
sm <- relationships(
  paths(from = c("COMP","LIKE"), to = c("CUSA","CUSL")),
  paths(from = "CUSA", to = "CUSL"))`;
const dataText = fs.readFileSync('public/congruence-demo/corp_rep_data.csv','utf8');
const res = runIndicatorRoute({code, dataText, options:{nboot:100, seed:123, alpha:0.10, diagonal:"rhoC"}});
const truth = fs.readFileSync('/tmp/r_reflective.txt','utf8').trim().split('\n').map(l=>l.split('|'));
let worst=0;
res.rows.forEach((r,i)=>{
  [[r.estimate,1],[r.bootSD,2]].forEach(([g,k])=>{
    worst=Math.max(worst, Math.abs(g-Number(truth[i][k]))/Math.abs(Number(truth[i][k])));});
  console.log(`${r.pair.padEnd(15)} ${r.estimate.toFixed(8)}  (R ${Number(truth[i][1]).toFixed(8)})`);
});
console.log("\nworst rel diff:", worst.toExponential(3), worst<1e-12?"EXACT PARITY (PLSc handled)":"MISMATCH");
