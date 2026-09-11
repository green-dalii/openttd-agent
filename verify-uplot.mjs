import { WebSocket } from "ws";
import { writeFileSync } from "node:fs";
const list = await (await fetch("http://127.0.0.1:9666/json/list")).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id=0; const pending=new Map(); const errs=[]; const failed=[];
const send=(m,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on("message",raw=>{const m=JSON.parse(String(raw));
  if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);return}
  if(m.method==="Runtime.exceptionThrown")errs.push("EXC: "+(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text));
  if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error")errs.push("CONSOLE: "+m.params.args.map(a=>String(a.value)).join(" "));
  if(m.method==="Network.loadingFailed")failed.push(m.params.errorText);
});
await new Promise(r=>ws.on("open",r));
await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
await send("Network.setCacheDisabled",{cacheDisabled:true});
await send("Emulation.setDeviceMetricsOverride",{width:1600,height:1200,deviceScaleFactor:1,mobile:false});
await send("Page.navigate",{url:"http://127.0.0.1:8187/"});
await new Promise(r=>setTimeout(r,16000));
const out = await send("Runtime.evaluate",{expression:`
 (() => {
   const u = window.uPlot, a = window.UCharts;
   const plotEl = document.getElementById('chart');
   const tokEl = document.getElementById('t-chart');
   // uPlot mounts a .u-wrap div containing canvases.
   const summarize = (el) => {
     if (!el) return 'missing';
     const cvs = [...el.querySelectorAll('canvas')];
     return { canvases: cvs.length,
              size: cvs.map(c=>c.width+'x'+c.height).join(','),
              legend: (el.querySelector('.u-legend')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,110) };
   };
   // count painted pixels on the first canvas of each chart
   const painted = (el) => { const c = el?.querySelector('canvas'); if(!c) return -1;
     const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
     let n=0; for(let i=0;i<d.length;i+=4000){ if(d[i+3]>0 && (d[i]>25||d[i+1]>25||d[i+2]>25)) n++; } return n; };
   return JSON.stringify({
     uPlotLoaded: typeof uPlot === 'function',
     adapterLoaded: typeof a === 'object' && typeof a.line === 'function',
     cash: summarize(plotEl), cashPainted: painted(plotEl),
     tokens: summarize(tokEl), tokensPainted: painted(tokEl),
   }, null, 1);
 })()`,returnByValue:true});
console.log(out?.result?.value);
const shot = await send("Page.captureScreenshot",{});
if (shot?.data) writeFileSync("/tmp/uplot-phase2.png", Buffer.from(shot.data,"base64"));
console.log("failed requests:", failed.length?failed:"none");
console.log("ERRORS:", errs.length?errs.slice(0,4):"none");
ws.close();
