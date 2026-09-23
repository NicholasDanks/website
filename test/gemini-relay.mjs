// Tests netlify/functions/gemini.mts against a local fake Google endpoint.
// Run: npx tsx test/gemini-relay.mjs
import http from "node:http";
import assert from "node:assert/strict";

let seen = null;
const upstream = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen = { url: req.url, key: req.headers["x-goog-api-key"], body };
    if (req.url.includes("gemini-3.8-flash")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP" }] })}\n\n`);
      res.end();
    } else {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" });
      res.end(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }));
    }
  });
});
await new Promise((r) => upstream.listen(0, r));
process.env.GEMINI_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`;
process.env.URL = "https://nicholasdanks.com";
process.env.DEPLOY_PRIME_URL = "https://deploy-preview-7--example-site.netlify.app";
delete process.env.NETLIFY_DEV;

const { default: relay, config } = await import("../netlify/functions/gemini.mts");
const { EVALUATOR_MODELS } = await import("../src/lib/seminr/evaluator.ts");
const good = EVALUATOR_MODELS[0].id;
const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
const call = (model, { origin = "https://nicholasdanks.com", b = body, method = "POST" } = {}) =>
  relay(new Request(`https://nicholasdanks.com/api/gemini/${model}`, { method, headers: { Origin: origin, "Content-Type": "application/json" }, body: method === "POST" ? b : undefined }), { params: { model } });

let pass = 0; const ok = (name, fn) => fn().then(() => { pass++; console.log("ok  ", name); });

process.env.GEMINI_SITE_KEY = "";
await ok("no key configured -> 503", async () => assert.equal((await call(good)).status, 503));
process.env.GEMINI_SITE_KEY = "TEST-KEY-123";

await ok("config: path, POST only, rate limit set", async () => {
  assert.equal(config.path, "/api/gemini/:model");
  assert.deepEqual(config.method, ["POST"]);
  assert.equal(config.rateLimit.windowLimit, 30);
});
await ok("GET -> 405", async () => assert.equal((await call(good, { method: "GET" })).status, 405));
await ok("foreign origin -> 403", async () => assert.equal((await call(good, { origin: "https://evil.example" })).status, 403));
await ok("missing origin -> 403", async () => assert.equal((await call(good, { origin: "" })).status, 403));
await ok("localhost refused outside netlify dev", async () => assert.equal((await call(good, { origin: "http://localhost:8888" })).status, 403));
await ok("deploy-preview origin of this site allowed", async () => assert.equal((await call(good, { origin: "https://deploy-preview-7--example-site.netlify.app" })).status, 200));
await ok("unknown model -> 400, never forwarded", async () => { seen = null; assert.equal((await call("gemini-ultra-9")).status, 400); assert.equal(seen, null); });
await ok("path traversal in model -> 400", async () => assert.equal((await call("..%2F..%2Fx")).status, 400));
await ok("non-JSON -> 400", async () => assert.equal((await call(good, { b: "nope" })).status, 400));
await ok("oversized body -> 413", async () => assert.equal((await call(good, { b: JSON.stringify({ contents: [], pad: "x".repeat(2_100_000) }) })).status, 413));

await ok("good request: key sent as header, not in URL; SSE streamed back", async () => {
  const res = await call(good);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /event-stream/);
  assert.match(await res.text(), /hello/);
  assert.equal(seen.key, "TEST-KEY-123");
  assert.ok(!/key=/.test(seen.url), "key must not be in the URL");
  assert.match(seen.url, /streamGenerateContent\?alt=sse$/);
  assert.equal(seen.body, body);
});
await ok("key never echoed in any response", async () => {
  for (const r of [await call(good), await call("bad"), await call(good, { origin: "https://evil.example" })]) assert.ok(!(await r.text()).includes("TEST-KEY-123"));
});
if (EVALUATOR_MODELS.length > 1) await ok("upstream 429 passes through with Retry-After", async () => {
  const res = await call(EVALUATOR_MODELS[1].id);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7");
});

upstream.close();
console.log(`\n${pass} checks passed`);
