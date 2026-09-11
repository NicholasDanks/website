/**
 * Serve dist/ with the production security headers from netlify.toml, so the
 * Content-Security-Policy can be exercised in headless Chrome before deploy.
 * CSP_EXTRA_CONNECT adds an origin to connect-src (the mock Anthropic endpoint).
 *
 * Run:  node test/csp-server.mjs   (port 4323)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const toml = fs.readFileSync("netlify.toml", "utf8");
const headers = {};
for (const m of toml.matchAll(/^\s{4}([A-Za-z-]+) = "(.*)"$/gm)) headers[m[1]] = m[2];
// The toml's Cache-Control rules are path-specific (immutable hashed assets); pages must not be cached here.
headers["Cache-Control"] = "no-store";
if (process.env.CSP_EXTRA_CONNECT) headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace("connect-src 'self'", `connect-src 'self' ${process.env.CSP_EXTRA_CONNECT}`);
delete headers["Strict-Transport-Security"];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".csv": "text/csv", ".ico": "image/x-icon", ".txt": "text/plain", ".xml": "application/xml" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  let file = path.join("dist", p);
  if (!fs.existsSync(file) && fs.existsSync(file + "/index.html")) file += "/index.html";
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, headers); return res.end("not found"); }
  res.writeHead(200, { ...headers, "Content-Type": types[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(4323, () => console.log("csp server on 4323", Object.keys(headers).join(", ")));
