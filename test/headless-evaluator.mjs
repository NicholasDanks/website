/**
 * End-to-end check of the evaluation assistant in headless Chrome against
 * test/mock-anthropic.mjs (a fake api.anthropic.com that scripts one tool
 * call and flags any row-shaped payload). Node has no Web Workers, so this is
 * the only place the browser side of the loop runs.
 *
 * Run:  node test/mock-anthropic.mjs &  npx astro preview --port 4322 &
 *       node test/headless-evaluator.mjs
 */
import { spawn } from "node:child_process";
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=9333", "--user-data-dir=/tmp/cdp-profile2", "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
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
await send("Page.navigate", { url: (process.argv[2] ?? "http://localhost:4322") + "/seminr/?demo=corp-rep" });
await new Promise((r) => setTimeout(r, 2500));
const script = `(async () => {
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  localStorage.setItem("seminr-anthropic-base-url", "http://127.0.0.1:9444");
  for (let i = 0; i < 40 && !document.getElementById("data").value; i++) await wait(250);
  document.getElementById("quick").click();
  for (let i = 0; i < 200; i++) { await wait(100); if (!document.getElementById("results").classList.contains("hidden")) break; }
  const evalHidden = document.getElementById("evaluate").classList.contains("hidden");
  document.getElementById("eval-show-digest").click(); await wait(1500);
  const digestPreview = document.getElementById("eval-digest").textContent;
  document.getElementById("api-key").value = "sk-ant-test";
  document.getElementById("eval-start").click();
  for (let i = 0; i < 600; i++) { await wait(200); const st = document.getElementById("eval-status").textContent; const msgs = document.querySelectorAll("#eval-transcript .msg").length; if (msgs >= 4 && !document.getElementById("eval-start").disabled) break; }
  return JSON.stringify({ evalHidden, digestPreviewLen: digestPreview.length, digestHasSystem: digestPreview.startsWith("SYSTEM PROMPT"), status: document.getElementById("eval-status").textContent, usage: document.getElementById("eval-usage").textContent, transcript: [...document.querySelectorAll("#eval-transcript .msg")].map(m => m.className + ": " + m.innerText.replace(/\\s+/g, " ").slice(0, 160)), loadBtn: !!document.querySelector("#eval-transcript .tool-actions button") });
})()`;
const r = await send("Runtime.evaluate", { expression: script, awaitPromise: true, returnByValue: true });
console.log(r.result?.result?.value ?? JSON.stringify(r));
console.log("CSP/console violations:", violations.length, violations.slice(0, 5));
ws.close(); proc.kill();
