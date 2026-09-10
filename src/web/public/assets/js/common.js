/* openttd-agent dashboard — shared helpers (no build chain, plain ES module-ish global).
 *
 * 职责: 页面间共享的纯函数 + WS 客户端 + 导航/标签页骨架 + 事件分类/摘要。
 * 事实来源: docs/DASHBOARD-API.md §5（categoryOf/briefOf 规则）、§4（WS 协议）。
 * 禁止: 依赖任何框架/构建；禁止在此发业务请求（各页面自己 fetch）。
 */
"use strict";

/* ----------------------------- tiny DOM ----------------------------- */
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "—";
}

function fmtMoney(n) {
  if (n === undefined || n === null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${sign}£${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sign}£${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${sign}£${(a / 1e3).toFixed(1)}k`;
  return `${sign}£${a}`;
}

function fmtTok(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "0";
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

function fmtCost(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(3)}`;
}

function fmtDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v)) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  return `${Math.floor(v / 60000)}m${Math.round((v % 60000) / 1000)}s`;
}

function fmtAgo(ts) {
  const v = Number(ts);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const d = Date.now() - v;
  if (d < 1000) return "just now";
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

function fmtClock(ts) {
  const v = Number(ts);
  if (!Number.isFinite(v)) return "—";
  const d = new Date(v);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/* ------------------------ event classification ------------------------ */
/* Frozen mapping (docs §5): kind -> category, used for tags + grouping. */
const CATEGORY_OF = {
  date: "date",
  company_economy: "economy",
  company_stats: "economy",
  company_new: "company",
  company_info: "company",
  company_remove: "company",
  vehicle_new: "vehicle",
  vehicle_info: "vehicle",
  vehicle_update: "vehicle",
  station_new: "station",
  station_info: "station",
  town_new: "town",
  town_info: "town",
  industry_new: "industry",
  industry_info: "industry",
  gamescript: "script",
  welcome: "protocol",
  protocol: "protocol",
  error: "protocol",
  rcon_end: "protocol",
  console: "protocol",
};

const CATEGORY_LABELS = {
  date: "Date",
  economy: "Economy",
  company: "Company",
  vehicle: "Vehicle",
  station: "Station",
  town: "Town",
  industry: "Industry",
  script: "Bridge GS",
  protocol: "Protocol",
  other: "Other",
};

function categoryOf(kind) {
  return CATEGORY_OF[kind] || "other";
}

/* ---------------------------- event summary ---------------------------- */
/* One human-readable line instead of a truncated JSON blob (docs §5). */
function briefOf(ev) {
  const p = (ev && ev.payload) || {};
  switch (categoryOf(ev && ev.kind)) {
    case "date":
      return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    case "economy": {
      const parts = [];
      if (p.money !== undefined) parts.push(`${fmtMoney(p.money)} cash`);
      if (p.loan !== undefined) parts.push(`loan ${fmtMoney(p.loan)}`);
      if (p.income !== undefined) parts.push(`income ${fmtMoney(p.income)}`);
      if (p.vehicles !== undefined || p.stations !== undefined)
        parts.push(`${p.vehicles ?? "—"} veh · ${p.stations ?? "—"} stn`);
      return parts.join(" · ") || "—";
    }
    case "company": {
      const parts = [];
      if (p.id !== undefined) parts.push(`#${p.id}`);
      if (p.name) parts.push(`"${p.name}"`);
      if (p.isAi !== undefined) parts.push(p.isAi ? "AI" : "human");
      if (p.manager) parts.push(`president ${p.manager}`);
      if (p.inauguratedYear) parts.push(`since ${p.inauguratedYear}`);
      return parts.join(" · ") || "—";
    }
    case "script": {
      const parts = [];
      if (p.kind) parts.push(`kind=${p.kind}`);
      if (p.cmd) parts.push(`cmd=${p.cmd}`);
      if (p.job !== undefined) parts.push(`job=${p.job}`);
      if (p.company !== undefined) parts.push(`company=${p.company}`);
      if (p.company_signs !== undefined) parts.push(`signs=${p.company_signs}`);
      if (p.phase) parts.push(`phase=${p.phase}`);
      if (p.ok !== undefined) parts.push(p.ok ? "ok" : "FAILED");
      return parts.join(" · ") || "—";
    }
    case "vehicle": {
      const parts = [];
      if (p.id !== undefined) parts.push(`#${p.id}`);
      if (p.name) parts.push(p.name);
      if (p.vehicleType !== undefined) parts.push(`type ${p.vehicleType}`);
      if (p.profit !== undefined) parts.push(`profit ${fmtMoney(p.profit)}`);
      return parts.join(" · ") || "—";
    }
    case "station": {
      const parts = [];
      if (p.id !== undefined) parts.push(`#${p.id}`);
      if (p.name) parts.push(p.name);
      if (p.cargoWaiting !== undefined) parts.push(`waiting ${p.cargoWaiting}`);
      return parts.join(" · ") || "—";
    }
    case "protocol":
      return typeof p.message === "string" ? p.message : JSON.stringify(p).slice(0, 120);
    default: {
      // Compact key=value pairs, capped — never a raw JSON wall (docs §5).
      const keys = Object.keys(p).slice(0, 6);
      if (!keys.length) return "—";
      return keys.map((k) => {
        const v = p[k];
        const sv = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
        return `${k}=${sv.length > 32 ? sv.slice(0, 31) + "…" : sv}`;
      }).join(" · ");
    }
  }
}

/** Stable tag color class for a category. */
function categoryClass(cat) {
  return `tag-${cat}`;
}

/* --------------------------- WS client --------------------------- */
/** Connect to the dashboard WS with auto-reconnect; handlers are optional. */
function connectWs(handlers) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws = null;
  let closed = false;
  let attempts = 0;

  const setLink = (text, cls) => {
    if (handlers.onLink) handlers.onLink(text, cls);
  };

  function open() {
    if (closed) return;
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { attempts = 0; setLink("live", "ok"); };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      switch (msg.type) {
        case "snapshot": handlers.onSnapshot && handlers.onSnapshot(msg.data); break;
        case "event": handlers.onEvent && handlers.onEvent(msg.data); break;
        case "telemetry": handlers.onTelemetry && handlers.onTelemetry(msg.data); break;
        case "step": handlers.onStep && handlers.onStep(msg.data); break;
      }
    };
    ws.onclose = () => {
      if (closed) return;
      attempts++;
      setLink(`reconnecting… (${attempts})`, "bad");
      setTimeout(open, Math.min(1000 + attempts * 500, 5000));
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }
  open();
  return { close() { closed = true; try { ws && ws.close(); } catch { /* ignore */ } } };
}

/* --------------------------- chrome / nav --------------------------- */
function renderNav(active) {
  const items = [
    ["/", "Live"],
    ["/llm", "Providers"],
    ["/sessions", "Sessions"],
  ];
  return `<nav class="nav">${items
    .map(([href, label]) =>
      `<a href="${href}" class="${href === active ? "active" : ""}">${esc(label)}</a>`)
    .join("")}</nav>`;
}

/* --------------------- small chart helpers --------------------- */
/** Line chart with optional multi-series; used by cash + token charts. */
function drawLines(canvas, series, opts) {
  const o = opts || {};
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const all = [];
  for (const s of series) for (const v of s.data) if (Number.isFinite(v)) all.push(v);
  if (!all.length) return;

  const max = Math.max(...all, o.nonNegative ? 0 : Math.max(...all, 0));
  const min = Math.min(0, ...all);
  const padL = o.padLeft === undefined ? 42 : o.padLeft;
  const padR = 10, padT = 10, padB = 18;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const yFor = (v) => padT + (1 - (v - min) / Math.max(max - min, 1)) * innerH;
  const xFor = (i, n) => padL + (i / Math.max(n - 1, 1)) * innerW;

  ctx.strokeStyle = "#26323a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * innerH;
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
  }
  ctx.stroke();

  ctx.fillStyle = "#7f929e";
  ctx.font = "10px ui-monospace, monospace";
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * innerH;
    const v = max - (g / 4) * (max - min);
    ctx.fillText(o.compact ? fmtTok(v) : compact(v), 2, y + 3);
  }

  for (const s of series) {
    if (!s.data.length) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.6;
    ctx.beginPath();
    s.data.forEach((v, i) => {
      const x = xFor(i, s.data.length), y = yFor(v);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    if (o.dots !== false) {
      const last = s.data[s.data.length - 1];
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(xFor(s.data.length - 1, s.data.length), yFor(last), 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (v / 1e3).toFixed(0) + "k";
  return String(Math.round(v));
}

const PALETTE = ["#ffb347", "#5fb3ff", "#7bc96f", "#c3a6ff", "#e06c75", "#e5c07b", "#56d4dd", "#f28fad"];
function pickColor(i) {
  return PALETTE[Math.abs(Number(i) || 0) % PALETTE.length];
}

/* Expose to page scripts (no modules => no CORS/build concerns for file://). */
window.UI = {
  $, esc, fmtInt, fmtMoney, fmtTok, fmtCost, fmtDuration, fmtAgo, fmtClock,
  categoryOf, categoryClass, categoryLabel: (c) => CATEGORY_LABELS[c] || c,
  briefOf, connectWs, renderNav, drawLines, compact, pickColor, PALETTE,
};
