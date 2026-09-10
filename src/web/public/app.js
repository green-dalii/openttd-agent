/* openttd-agent dashboard client — native JS, WS + Canvas, no build chain. */
"use strict";

const $ = (id) => document.getElementById(id);
const elDate = $("g-date"), elCompanies = $("g-companies"),
      elEvents = $("g-events"), elLink = $("g-link"), elStream = $("events");

let state = { date: null, companies: [], recent: [] };
let lastSentSnapshot = null;

/* ---------- WebSocket (auto-reconnect) ---------- */
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { elLink.textContent = "live"; };
  ws.onmessage = (m) => {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === "snapshot") applySnapshot(msg.data);
    else if (msg.type === "event") appendEvent(msg.data);
  };
  ws.onclose = () => { elLink.textContent = "reconnecting…"; setTimeout(connect, 1200); };
  ws.onerror = () => ws.close();
}

function applySnapshot(snap) {
  state = snap || { date: null, companies: [], recent: [] };
  renderAll();
}

function appendEvent(ev) {
  state.recent = [...(state.recent || []), ev].slice(-500);
  // fold into per-company/economy state for live charting
  fold(ev);
  renderAll();
}

/* ---------- state folding (server may send snapshot+events) ---------- */
function fold(ev) {
  if (!ev) return;
  const p = ev.payload || {};
  if (ev.kind === "date") state.date = p;
  if (ev.kind === "company_economy") {
    const c = (state.companies = state.companies || {});
    c[p.id] = c[p.id] || { economy: null, history: [] };
    c[p.id].economy = p;
    if (p.money !== undefined) {
      c[p.id].history = [...(c[p.id].history || []), { y: p.money, at: state.date ? `${state.date.year}-${state.date.month}` : "?" }].slice(-200);
    }
  }
}

/* ---------- rendering ---------- */
function fmtMoney(n) {
  if (n === undefined || n === null || n === "") return "—";
  const v = typeof n === "string" ? Number(n) : Number(n);
  if (!Number.isFinite(v)) return n;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign}£${(a/1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}£${(a/1e3).toFixed(1)}k`;
  return `${sign}£${a}`;
}

function renderAll() {
  renderHeader();
  renderCompanies();
  renderChart();
  renderEvents();
}

function renderHeader() {
  const d = state.date;
  elDate.textContent = d ? `${d.year}-${String(d.month).padStart(2,"0")}-${String(d.day).padStart(2,"0")}` : "—";
  const cs = state.companies;
  const ids = Object.keys(cs || {});
  elCompanies.textContent = ids.length ? ids.length : "—";
  elEvents.textContent = state.totalEvents ?? state.recent?.length ?? 0;
}

function renderCompanies() {
  const box = $("companies");
  const cs = state.companies;
  const ids = Object.keys(cs || {});
  if (!ids.length) { box.innerHTML = '<div class="empty">No companies yet — the observer starts an AI and watches its economy.<br/>Open the URL above in your browser while a <code>--watch</code> run is active.</div>'; return; }

  box.innerHTML = ids.map((id) => {
    const c = cs[id];
    const i = c.info || { name: `Company ${id}`, isAi: false };
    const e = c.economy || {};
    const s = c.stats || {};
    const money = fmtMoney(e.money);
    const moneyCls = (Number(e.money)||0) < 0 ? "neg" : "pos";
    return `<div class="ccard">
      <h3><span>${esc(i.name || `Company ${id}`)} <small class="dim">#${id}</small></span>
        <span class="tag">${i.isAi ? "AI" : "human"}</span></h3>
      <table>
        <tr><td>Cash</td><td class="money ${moneyCls}">${money}</td></tr>
        <tr><td>Loan</td><td class="money">${fmtMoney(e.loan)}</td></tr>
        <tr><td>Income (yr)</td><td class="money">${fmtMoney(e.income)}</td></tr>
        <tr><td>Value</td><td class="money">${fmtMoney(e.companyValue)}</td></tr>
        <tr><td>Vehicles / Stns</td><td class="money">${s.vehicles ?? "—"} / ${s.stations ?? "—"}</td></tr>
        <tr><td>President</td><td class="money" style="font-weight:400">${esc(i.manager || "—")}</td></tr>
      </table></div>`;
  }).join("");
}

function renderChart() {
  const canvas = $("chart");
  const ctx = canvas.getContext("2d");
  const cs = state.companies || {};
  const ids = Object.keys(cs);
  if (!ids.length) { ctx.clearRect(0,0,canvas.width,canvas.height); return; }

  // collect all histories
  const series = ids.map((id) => {
    const h = (cs[id].history || []).map((pt) => Number(pt.y));
    return { id, color: pickColor(Number(id)), data: h };
  });
  const all = series.flatMap((s) => s.data);
  if (!all.length) { ctx.clearRect(0,0,canvas.width,canvas.height); return; }

  const W = canvas.width, H = canvas.height;
  const max = Math.max(...all, 1), min = Math.min(0, ...all);
  const pad = 30, top = 8;
  const xFor = (i, n) => pad + (i / Math.max(n - 1, 1)) * (W - pad * 2);
  const yFor = (v) => top + (1 - (v - min) / Math.max(max - min, 1)) * (H - top - 22);

  ctx.clearRect(0,0,W,H);
  ctx.strokeStyle = "#26323a"; ctx.beginPath();
  for (let g = 0; g <= 4; g++) {
    const y = top + (g/4)*(H-top-22);
    ctx.moveTo(pad,y); ctx.lineTo(W-pad,y);
  }
  ctx.stroke();
  // y labels
  ctx.fillStyle = "#7f929e"; ctx.font = "10px monospace";
  for (let g = 0; g <= 4; g++) {
    const y = top + (g/4)*(H-top-22);
    const v = max - (g/4)*(max-min);
    ctx.fillText(compact(v), 2, y+3);
  }
  for (const s of series) {
    if (s.data.length < 1) continue;
    ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.beginPath();
    s.data.forEach((v, i) => {
      const x = xFor(i, s.data.length), y = yFor(v);
      i === 0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    });
    ctx.stroke();
    const last = s.data[s.data.length-1];
    ctx.fillStyle = s.color;
    ctx.beginPath(); ctx.arc(xFor(s.data.length-1, s.data.length), yFor(last), 2.5, 0, Math.PI*2); ctx.fill();
  }
}

function renderEvents() {
  const list = state.recent || [];
  const maxShow = 200;
  const shown = list.slice(-maxShow);
  const frag = document.createDocumentFragment();
  shown.forEach((ev) => {
    const li = document.createElement("li");
    const payload = ev.payload || {};
    let brief = JSON.stringify(payload);
    if (brief.length > 140) brief = brief.slice(0,137) + "…";
    li.innerHTML = `<span class="seq">${ev.seq}</span>
      <span class="tag ${ev.kind}">${ev.kind}</span>
      <span class="payload">${esc(brief)}</span>`;
    frag.appendChild(li);
  });
  elStream.replaceChildren(frag);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}
function pickColor(id) {
  const pal = ["#ffb347","#5fb3ff","#7bc96f","#c3a6ff","#e06c75","#e5c07b","#56d4dd"];
  return pal[id % pal.length];
}
function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v/1e6).toFixed(1)+"M";
  if (a >= 1e3) return (v/1e3).toFixed(0)+"k";
  return String(Math.round(v));
}

connect();

/* ---- LLM provider settings (SPEC §4) -------------------------------- */
const llmBase = $("llm-base"), llmModel = $("llm-model"), llmKey = $("llm-key"),
      llmApi = $("llm-api"), llmProvider = $("llm-provider"),
      llmForm = $("llm-form"), llmMsg = $("llm-msg"), llmStatus = $("llm-status");

function renderLlm(v) {
  if (!v) { llmStatus.textContent = "(api disabled)"; return; }
  llmBase.value = v.baseUrl || "";
  llmModel.value = v.model || "";
  llmApi.value = v.api || "openai-completions";
  llmProvider.value = v.providerId || "";
  llmKey.value = "";
  llmKey.placeholder = v.hasApiKey ? "(stored — leave blank to keep)" : "(no key set)";
  llmStatus.textContent = v.configured ? "configured ✅" : "not configured";
  llmStatus.className = v.configured ? "ok" : "bad";
}

async function loadLlm() {
  try {
    const r = await fetch("/api/llm");
    if (!r.ok) { renderLlm(null); return; }
    renderLlm(await r.json());
  } catch { renderLlm(null); }
}

if (llmForm) {
  llmForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    llmMsg.textContent = "saving…";
    const body = {
      baseUrl: llmBase.value.trim(),
      model: llmModel.value.trim(),
      api: llmApi.value,
      providerId: llmProvider.value.trim() || "openttd-llm",
    };
    if (llmKey.value.trim()) body.apiKey = llmKey.value.trim();
    try {
      const r = await fetch("/api/llm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await r.json();
      if (!r.ok) { llmMsg.textContent = "error: " + (out.error || r.status); return; }
      renderLlm(out);
      llmMsg.textContent = "saved ✅ (applies on next agent run)";
    } catch (e) { llmMsg.textContent = "error: " + e; }
  });
  loadLlm();
}
