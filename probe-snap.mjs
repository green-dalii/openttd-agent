import { WebSocket } from "ws";
const ws = new WebSocket("ws://127.0.0.1:8187/ws");
await new Promise((r) => ws.on("open", r));
const seen = {};
ws.on("message", (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === "snapshot") {
    const comps = m.data?.companies || {};
    for (const [id, c] of Object.entries(comps)) {
      seen[id] = { history: (c.history || []).length, money: c.economy?.money ?? c.info?.money };
    }
    console.log("snapshot companies:", JSON.stringify(seen));
    console.log("history[0..2]:", JSON.stringify(Object.values(comps)[0]?.history?.slice(0, 3)));
    ws.close();
    process.exit(0);
  }
});
setTimeout(() => { console.log("no snapshot frame arrived"); ws.close(); process.exit(1); }, 8000);
