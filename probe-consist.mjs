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
   const vals = [1500, 15000, 1.5e6, 1.5e9, 1.5e12];
   const rows = vals.map(v => ({
     v,
     kpi: window.UI.fmtTok(v),
     chart: window.Charts.util.fmtCompact(v),
     money: window.UI.fmtMoney(v),
   }));
   return JSON.stringify({
     rows,
     kpi_chart_agree: rows.every(r => r.kpi === r.chart),
     // no ICU "bn"/"tn" (CLDR spelling) may leak through
     cldr_leak: rows.filter(r => /bn|tn|[BKM]$/.test(r.kpi)).map(r => r.kpi),
   }, null, 1);
 })()`,returnByValue:true});
console.log(out?.result?.value);
ws.close();
