import { WebSocket } from "ws";
const list = await (await fetch("http://127.0.0.1:9444/json/list")).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map(); const errs = []; const requests = [];
const send = (m, p = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.on("message", (raw) => { const m = JSON.parse(String(raw));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
  if (m.method === "Runtime.exceptionThrown") errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errs.push(m.params.args.map((a) => String(a.value)).join(" "));
  if (m.method === "Network.requestWillBeSent" && m.params.request.method === "POST") requests.push(m.params.request.url + " body=" + m.params.request.postData);
});
await new Promise((r) => ws.on("open", r));
await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:8187/" });
await new Promise((r) => setTimeout(r, 9000));

const clicked = await send("Runtime.evaluate", { expression: `
  (() => { const b = document.getElementById('run-start-agent');
    if (!b) return 'BUTTON MISSING';
    if (b.hidden) return 'BUTTON HIDDEN';
    b.click(); return 'clicked (server has no LLM -> expect a clear error, not ReferenceError)'; })()`, returnByValue: true });
console.log("button:", clicked?.result?.value);
await new Promise((r) => setTimeout(r, 5000));

const out = await send("Runtime.evaluate", { expression: `
JSON.stringify({
  toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.slice(0, 130)),
  notice: (document.getElementById('notice')||{textContent:''}).textContent.replace(/\\s+/g,' ').trim().slice(0,170)
}, null, 1)`, returnByValue: true });
console.log(out?.result?.value);
console.log("POST requests made:", JSON.stringify(requests));
console.log("CONSOLE ERRORS:", errs.length ? errs : "none");
ws.close();
