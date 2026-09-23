// Serves dist/ and routes POST /api/gemini/:model to netlify/functions/gemini.mts,
// so the browser can be tested against the real relay path. Upstream = mock-gemini.
// Run: node test/mock-gemini.mjs &  npx tsx test/relay-server.mjs  (port 4323)
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
process.env.GEMINI_UPSTREAM ??= "http://127.0.0.1:9445";
process.env.GEMINI_SITE_KEY ??= "LOCAL-TEST-KEY";
process.env.NETLIFY_DEV = "true";
const { default: relay } = await import("../netlify/functions/gemini.mts");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json", ".csv": "text/csv", ".txt": "text/plain", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost:4323");
  const m = url.pathname.match(/^\/api\/gemini\/([^/]+)$/);
  if (m) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await relay(new Request(url, { method: req.method, headers: req.headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined }), { params: { model: m[1] } });
    console.log(`relay ${req.method} ${m[1]} origin=${req.headers.origin} -> ${r.status}`);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body) res.write(c);
    return res.end();
  }
  let p = path.join("dist", decodeURIComponent(url.pathname));
  if (p.endsWith("/")) p += "index.html";
  try { const b = await readFile(p); res.writeHead(200, { "Content-Type": types[path.extname(p)] ?? "application/octet-stream" }); res.end(b); }
  catch { try { const b = await readFile(path.join(p, "index.html")); res.writeHead(200, { "Content-Type": "text/html" }); res.end(b); } catch { res.writeHead(404); res.end(); } }
}).listen(4323, () => console.log("relay test server on 4323"));
