/**
 * Live page verification: real browser, real data, assert what is RENDERED.
 * Usage: node verify-page.mjs <port> [label]
 */
import { WebSocket } from "ws";
const port = process.argv[2] ?? "8187";
const label = process.argv[3] ?? "page";
const list = await (await fetch("http://127.0.0.1:9666/json/list")).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = [];
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.on("message", (raw) => { const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push("CONSOLE: " + m.params.args.map((a) => String(a.value)).join(" "));
});
await new Promise((r) => ws.on("open", r));
await send("Runtime.enable"); await send("Page.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
await new Promise((r) => setTimeout(r, 14000));
const out = await send("Runtime.evaluate", { expression: `
 (() => {
   const txt = (id) => (document.getElementById(id)||{}).textContent?.trim() ?? null;
   const kpis = [...document.querySelectorAll('.kpi')].map(k => k.textContent.replace(/\\s+/g,' ').trim());
   // Every formatted number in the KPI strip + header, to eyeball the Intl change.
   const body = document.body.innerText.replace(/\\s+/g,' ');
   return JSON.stringify({
     kpis: kpis.slice(0, 8),
     header: txt('hdr-meta') || txt('header-meta'),
     runState: txt('run-state'),
     // Look for formatter regressions in what the user actually sees.
     suspicious: (body.match(/NaN|undefined|\\[object|Infinity/g) || []).slice(0, 8),
     moneyish: (body.match(/£[\\d.,]+[KMBT]?/g) || []).slice(0, 6),
     tokish: (body.match(/[\\d.,]+[KMB] tokens?/g) || []).slice(0, 4),
     canvases: document.querySelectorAll('canvas').length,
   });
 })()`, returnByValue: true });
console.log(`--- ${label} ---`);
console.log(out?.result?.value);
if (errs.length) console.log("ERRORS:", errs.slice(0, 5)); else console.log("console errors: none");
ws.close();
