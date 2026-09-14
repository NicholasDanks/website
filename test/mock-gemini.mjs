// A fake Gemini streamGenerateContent endpoint (SSE) for the headless browser
// test and for a dry run of test/model-compare.mjs. Turn 1 returns a run_model
// function call; turn 2 reads the function response and answers. Logs a
// warning if anything row-shaped reaches it.
import http from "node:http";
let turn = 0;
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body);
    const last = b.contents[b.contents.length - 1];
    const text = JSON.stringify(last);
    const leak = /"values"\s*:\s*\[\s*\[/.test(text) || /\b5,6,5,7\b/.test(text);
    console.log(`turn ${++turn}: url=${req.url.split("?")[0]} sse=${/alt=sse/.test(req.url)} keyInUrl=${/key=/.test(req.url)} contents=${b.contents.length} lastLen=${text.length} hasSystem=${!!b.systemInstruction} tools=${b.tools?.[0]?.functionDeclarations?.length} leak=${leak}`);
    const usageMetadata = { promptTokenCount: 12000, candidatesTokenCount: 80, thoughtsTokenCount: 200 };
    const chunks = [];
    if (turn === 1) {
      chunks.push([{ text: "**Verdict.** Let me test " }], [{ text: "dropping qual_4.\n\n", thoughtSignature: "sig1" }]);
      chunks.push([{ functionCall: { name: "run_model", args: { label: "drop qual_4", code: 'mm <- constructs(composite("QUAL", multi_items("qual_", c(1,2,3,5,6,7,8)), weights = mode_B), composite("COMP", multi_items("comp_", 1:3)), composite("CUSA", single_item("cusa")))\nsm <- relationships(paths(from = "QUAL", to = "COMP"), paths(from = "COMP", to = "CUSA"))', bootstrap: true, predict: false } }, thoughtSignature: "sig2" }]);
    } else {
      const d = last.parts[0].functionResponse.response.digest;
      chunks.push([{ text: `## Result\n\nRun "${d.run.label}": ` }], [{ text: `${d.paths.length} paths, QUAL -> COMP beta = ${d.paths[0].beta}.\n\n- one\n- two` }]);
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", ...cors });
    chunks.forEach((parts, i) => {
      const last = i === chunks.length - 1;
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, ...(last ? { finishReason: "STOP" } : {}) }], ...(last ? { usageMetadata } : {}) })}\n\n`);
    });
    res.end();
  });
}).listen(9445, () => console.log("mock gemini on 9445"));
