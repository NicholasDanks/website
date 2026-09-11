/**
 * Drive headless Chrome over the DevTools protocol: load the app, run a demo
 * with the given number of bootstrap resamples, and print the wall-clock
 * time, stage details and the verdict strip. A smoke test for the worker
 * pool, which Node cannot exercise (no Web Workers).
 *
 * Run:  npx astro preview --port 4322 &
 *       node test/headless-run.mjs "http://localhost:4322/seminr/?demo=corp-rep" 2000
 */
import { spawn } from "node:child_process";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] ?? "http://localhost:4322/seminr/?demo=corp-rep";
const nboot = process.argv[3] ?? "2000";
const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=9333", "--user-data-dir=/tmp/cdp-profile", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
const violations = [];
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Log.entryAdded" && /Content Security Policy|Refused to/i.test(m.params.entry.text)) violations.push(m.params.entry.text.slice(0, 160)); if (m.method === "Runtime.exceptionThrown") violations.push("EXCEPTION " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 160)); });
await send("Page.navigate", { url });
await new Promise((r) => setTimeout(r, 2500));
const script = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40 && !document.getElementById("data").value; i++) await wait(250);
  document.getElementById("nboot").value = "${nboot}";
  document.getElementById("congruence-nboot").value = "1000";
  document.getElementById("cvpat-nboot").value = "1000";
  const t0 = performance.now();
  document.getElementById("run").click();
  for (let i = 0; i < 1200; i++) { await wait(250); if (!document.getElementById("results").classList.contains("hidden") || !document.getElementById("error").classList.contains("hidden")) break; }
  return JSON.stringify({ seconds: ((performance.now() - t0)/1000).toFixed(1), cores: navigator.hardwareConcurrency, error: document.getElementById("error").textContent, stages: document.getElementById("stages").innerText.replace(/\\n/g, " | "), verdict: (document.querySelector(".verdict")?.innerText ?? "").replace(/\\n/g, " ").slice(0, 200) });
})()`;
const r = await send("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r));
console.log("CSP/console violations:", violations.length, violations.slice(0, 5));
ws.close(); proc.kill();
