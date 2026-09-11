// A fake api.anthropic.com for an end-to-end check of the evaluator loop.
// Turn 1: asks for run_model (drop qual_4). Turn 2: reads the tool result and answers.
import http from "node:http";
let turn = 0;
const sse = (res, events) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};
const usage = { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" }); return res.end(); }
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    const b = JSON.parse(body);
    const last = b.messages[b.messages.length - 1];
    const text = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    const leak = /"values"\s*:\s*\[\s*\[/.test(text) || /\b5,6,5,7\b/.test(text);
    console.log(`turn ${++turn}: model=${b.model} msgs=${b.messages.length} lastLen=${text.length} hasKeyHeader=${!!req.headers["x-api-key"]} browserHeader=${req.headers["anthropic-dangerous-direct-browser-access"]} leak=${leak}`);
    if (turn === 1) {
      const input = JSON.stringify({ label: "drop qual_4", code: 'mm <- constructs(composite("QUAL", multi_items("qual_", c(1,2,3,5,6,7,8)), weights = mode_B), composite("COMP", multi_items("comp_", 1:3)), composite("CUSA", single_item("cusa")))\nsm <- relationships(paths(from = "QUAL", to = "COMP"), paths(from = "COMP", to = "CUSA"))', bootstrap: true, predict: false });
      sse(res, [
        ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "**Verdict.** Let me test dropping qual_4.\n\n" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "run_model", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: input } }],
        ["content_block_stop", { type: "content_block_stop", index: 1 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 80 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    } else {
      const toolResult = last.content.find((c) => c.type === "tool_result");
      const d = JSON.parse(toolResult.content);
      sse(res, [
        ["message_start", { type: "message_start", message: { id: "m2", type: "message", role: "assistant", model: b.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `## Result\n\nThe alternative run "${d.run.label}" has ${d.paths.length} paths and ${d.constructs.length} constructs; QUAL -> COMP beta = ${d.paths[0].beta}.\n\n- one\n- two` } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 60 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    }
  });
}).listen(9444, () => console.log("mock anthropic on 9444"));
