import { WebSocket } from "ws";
import { writeFileSync } from "node:fs";
const list = await (await fetch("http://127.0.0.1:9666/json/list")).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id=0; const pending=new Map(); const errs=[];
const send=(m,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on("message",raw=>{const m=JSON.parse(String(raw));
  if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id);return}
  if(m.method==="Runtime.exceptionThrown")errs.push("EXC: "+(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text));
  if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error")errs.push("CONSOLE: "+m.params.args.map(a=>String(a.value)).join(" "));});
await new Promise(r=>ws.on("open",r));
await send("Runtime.enable"); await send("Page.enable");
await send("Network.setCacheDisabled",{cacheDisabled:true});
await send("Emulation.setDeviceMetricsOverride",{width:1600,height:1200,deviceScaleFactor:1,mobile:false});
await send("Page.navigate",{url:"http://127.0.0.1:8187/"});
await new Promise(r=>setTimeout(r,15000));
const out = await send("Runtime.evaluate",{expression:`
 (() => {
   const info = (elId) => { const el=document.getElementById(elId); if(!el) return 'missing';
     const cvs=[...el.querySelectorAll('canvas')];
     const painted = cvs.map(c=>{ const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
       let n=0; for(let i=0;i<d.length;i+=4000){ if(d[i+3]>0 && (d[i]>25||d[i+1]>25||d[i+2]>25)) n++; } return n; });
     return { canvases: cvs.length, painted,
              legend: (el.querySelector('.u-legend')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90) }; };
   return JSON.stringify({ cash: info('chart'), tokens: info('t-chart') }, null, 1);
 })()`,returnByValue:true});
console.log(out?.result?.value);
const shot = await send("Page.captureScreenshot",{});
if (shot?.data) writeFileSync("/tmp/phase2-final.png", Buffer.from(shot.data,"base64"));
console.log("ERRORS:", errs.length?errs.slice(0,4):"none");
ws.close();
