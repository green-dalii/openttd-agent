import { WebSocket } from "ws";
const list = await (await fetch("http://127.0.0.1:9666/json/list")).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id=0; const pending=new Map();
const send=(m,p={})=>new Promise(r=>{const i=++id;pending.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:p}))});
ws.on("message",raw=>{const m=JSON.parse(String(raw)); if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id)}});
await new Promise(r=>ws.on("open",r));
await send("Runtime.enable");
const out = await send("Runtime.evaluate",{expression:`JSON.stringify({
  fmtMoney_100000: window.UI.fmtMoney(100000),
  fmtMoney_2500000: window.UI.fmtMoney(2500000),
  fmtInt_1234: window.UI.fmtInt(1234),
  fmtTok_1500: window.UI.fmtTok(1500),
  fmtAgo_5m: window.UI.fmtAgo(Date.now()-300000),
  fmtPct_345: window.UI.fmtPct(0.345),
  rawIntl: new Intl.NumberFormat("en-GB",{style:"currency",currency:"GBP",notation:"compact",maximumFractionDigits:1}).format(100000),
  rawIntl_1_5: new Intl.NumberFormat("en-GB",{notation:"compact",maximumFractionDigits:1}).format(1500),
})`,returnByValue:true});
console.log(out?.result?.value);
ws.close();
