/**
 * Screenshot the SEMinR app in headless Chrome for a UX pass: viewport-sized
 * slices before and after a demo run, at a given width and colour scheme, plus
 * console errors and an optional DOM probe (PROBE env var, a JS expression).
 * Used for the 17 Sep 2026 UX pass when no browser extension was connected.
 *
 * Run:  npm run dev   (or set BASE to any deployment, e.g. https://nicholasdanks.com)
 *       mkdir -p /tmp/ux/desk && node test/ux-shots.mjs /tmp/ux/desk 1440 0 corp-rep
 *       args: <outdir> <width> <dark 0|1> <demo id | none> [cdp port]
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [out, width = "1440", dark = "0", demo = "corp-rep", port = "9334"] = process.argv.slice(2);
const W = +width, H = W < 600 ? 844 : 1000;
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const proc = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/cdp-ux-${port}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2000));
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === "Runtime.exceptionThrown") logs.push("EXC " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 200));
  if (m.method === "Log.entryAdded" && m.params.entry.level !== "verbose") logs.push(m.params.entry.level + " " + m.params.entry.text.slice(0, 200));
  if (m.method === "Runtime.consoleAPICalled" && ["error","warning"].includes(m.params.type)) logs.push(m.params.type + " " + JSON.stringify(m.params.args.map(a=>a.value??a.description)).slice(0,200)); };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: W < 600 });
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark === "1" ? "dark" : "light" }] });
if (dark === "1") await send("Page.addScriptToEvaluateOnNewDocument", { source: "try{localStorage.setItem('theme','dark')}catch(e){}" });
await send("Page.navigate", { url: `${process.env.BASE ?? "http://localhost:4321"}/seminr/` });
await new Promise((r) => setTimeout(r, 4000));
const slices = async (tag) => {
  const h = await ev("document.documentElement.scrollHeight");
  const n = Math.min(Math.ceil(h / H), 14);
  for (let k = 0; k < n; k++) {
    await ev(`window.scrollTo(0, ${k * H}); new Promise(r=>setTimeout(r,300))`);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${out}/${tag}-${String(k).padStart(2, "0")}.png`, Buffer.from(shot.result.data, "base64"));
  }
  return { h, n };
};
const info = { before: await slices("a-before") };
if (demo !== "none") {
  info.run = await ev(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('[data-demo="${demo}"]').click();
    for (let i = 0; i < 40 && !document.getElementById("data").value; i++) await wait(250);
    await wait(500);
    const t0 = performance.now();
    document.getElementById("run").click();
    for (let i = 0; i < 1200; i++) { await wait(250); if (!document.getElementById("results").classList.contains("hidden") || !document.getElementById("error").classList.contains("hidden")) break; }
    await wait(1500);
    return { s: ((performance.now()-t0)/1000).toFixed(1), err: document.getElementById("error").textContent, stages: document.getElementById("stages").innerText, nav: document.getElementById("results-nav").innerText };
  })()`);
  info.after = await slices("b-after");
}
if (process.env.PROBE) info.probe = await ev(process.env.PROBE);
writeFileSync(`${out}/info.json`, JSON.stringify({ info, logs }, null, 1));
console.log(JSON.stringify({ info, logs: logs.slice(0, 15) }, null, 1));
ws.close(); proc.kill();
