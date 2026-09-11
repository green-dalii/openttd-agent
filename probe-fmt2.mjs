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
   const c = new Intl.NumberFormat("en-GB",{notation:"compact",maximumFractionDigits:1});
   const m = new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP",notation:"compact",maximumFractionDigits:1});
   const vals = [1500, 15000, 1.5e6, 1.5e9, 1.5e12];
   return JSON.stringify({
     browser_compact: vals.map(v=>c.format(v)),
     browser_money: vals.map(v=>m.format(v)),
     // does the project's existing charts.js formatter agree?
     charts_fmtCompact: vals.map(v=>window.Charts.util.fmtCompact(v)),
   }, null, 1);
 })()`,returnByValue:true});
console.log(out?.result?.value);
ws.close();
