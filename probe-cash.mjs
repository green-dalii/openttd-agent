import { WebSocket } from "ws";
const list = await (await fetch("http://127.0.0.1:9666/json/list")).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id=0; const pending=new Map();
const send=(m,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on("message",raw=>{const m=JSON.parse(String(raw)); if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id)}});
await new Promise(r=>ws.on("open",r));
await send("Runtime.enable");
const out = await send("Runtime.evaluate",{expression:`
 (() => {
   // Reach the page's own state through the snapshot the server sends.
   const snap = window.__lastSnapshot;
   const el = document.getElementById('chart');
   const wrap = el.querySelector('.u-wrap');
   const plot = el.__uplot || window.__uplotInst;
   return JSON.stringify({
     companies: Object.keys(window.__state?.companies||{}).length,
     historyLen: Object.values(window.__state?.companies||{}).map(c=>(c.history||[]).length),
     legendText: (el.querySelector('.u-legend')?.textContent||'').replace(/\\s+/g,' '),
     canvasCount: el.querySelectorAll('canvas').length,
   });
 })()`,returnByValue:true});
console.log("state probe:", out?.result?.value);
// Now ask the server for the cash history the page should have.
ws.close();
