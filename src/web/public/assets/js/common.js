/* openttd-agent dashboard — shared helpers.
 *
 * 职责: 页面间共享的**展示层原语**：格式化、事件分类/摘要、组合框、Toast、
 *   确认框、视图偏好持久化、WS 客户端、导航。
 * 事实来源: docs/DASHBOARD-UI.md §2/§3/§6（组件与组合框契约）、
 *   docs/DASHBOARD-API.md §5（categoryOf/briefOf 规则）、§4（WS 协议）。
 * 禁止:
 *   - 依赖任何框架/构建链（本项目要求离线可用、无 CDN）。
 *   - 在此发业务请求（各页面自己 fetch；本文件只做展示与交互）。
 *   - 在此写业务状态（服务端是真源）。
 */
"use strict";

/* ----------------------------- tiny DOM ----------------------------- */
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------- formatting ---------------------------- */
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
  return `${sign}£${Math.round(a)}`;
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
  if (v < 3600000) return `${Math.floor(v / 60000)}m${Math.round((v % 60000) / 1000)}s`;
  return `${Math.floor(v / 3600000)}h${Math.round((v % 3600000) / 60000)}m`;
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

function fmtPct(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits === undefined ? 1 : digits)}%`;
}

/** "1950-02-01" from a date payload (never "undefined-NaN"). */
function fmtGameDate(d) {
  if (!d || d.year === undefined) return "—";
  const mm = d.month === undefined ? 1 : d.month;
  const dd = d.day === undefined ? 1 : d.day;
  return `${d.year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Class name for a signed delta (up = good by default). */
function deltaClass(v, positiveIsGood) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "flat";
  const good = positiveIsGood === false ? n < 0 : n > 0;
  return good ? "up" : "down";
}

/** Render a delta chip, or "" when there is nothing to compare. */
function deltaChip(v, fmt, positiveIsGood) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  const fn = fmt || ((x) => fmtTok(Math.abs(x)));
  return `<span class="delta ${deltaClass(n, positiveIsGood)}">${sign}${fn(Math.abs(n))}</span>`;
}

/* ------------------------ event classification ------------------------ */
/* Frozen mapping (docs/DASHBOARD-API.md §5): kind -> category. */
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

/** Category display order (stable chips; not alphabetical jitter). */
const CATEGORY_ORDER = [
  "date", "economy", "company", "vehicle", "station", "town", "industry", "script", "protocol", "other",
];

function categoryOf(kind) {
  return CATEGORY_OF[kind] || "other";
}

function categoryLabel(cat) {
  return CATEGORY_LABELS[cat] || cat;
}

/** Stable tag color class for a category. */
function categoryClass(cat) {
  return `tag-${cat}`;
}

/** Counts per category, plus a total — the numbers shown on the filter chips. */
function categoryCounts(events) {
  const counts = {};
  let total = 0;
  for (const ev of events || []) {
    const c = categoryOf(ev && ev.kind);
    counts[c] = (counts[c] || 0) + 1;
    total++;
  }
  const order = Object.keys(counts).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return { counts, total, order };
}

/** Case-insensitive search across kind, category, brief and payload keys. */
function eventMatches(ev, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  if (String(ev && ev.kind).toLowerCase().includes(needle)) return true;
  const cat = categoryOf(ev && ev.kind);
  if (categoryLabel(cat).toLowerCase().includes(needle)) return true;
  if (briefOf(ev).toLowerCase().includes(needle)) return true;
  try {
    return JSON.stringify(ev && ev.payload).toLowerCase().includes(needle);
  } catch {
    return false;
  }
}

/* ---------------------------- event summary ---------------------------- */
/* One human-readable line instead of a truncated JSON blob (§5). */
function briefOf(ev) {
  const p = (ev && ev.payload) || {};
  switch (categoryOf(ev && ev.kind)) {
    case "date":
      return fmtGameDate(p);
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
      // Compact key=value pairs, capped — never a raw JSON wall (§5).
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

/* ------------------------------ toasts ------------------------------ */
/* Feedback used to live in one dim line under a form, which is easy to miss.
   Contract: docs/DASHBOARD-UI.md §2. */
function toast(message, kind, ms) {
  let box = $("toasts");
  if (!box) {
    box = document.createElement("div");
    box.id = "toasts";
    box.className = "toasts";
    box.setAttribute("aria-live", "polite");
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind || "info"}`;
  el.innerHTML = `<span class="toast-msg">${esc(message)}</span>`;
  box.appendChild(el);
  const kill = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 250);
  };
  el.onclick = kill;
  setTimeout(kill, ms || 3800);
  return el;
}

/* ---------------------------- confirm dialog ---------------------------- */
/** Promise<boolean>; falls back to window.confirm when <dialog> is absent. */
function confirmDialog(opts) {
  const o = opts || {};
  if (typeof document.createElement("dialog").showModal !== "function") {
    return Promise.resolve(window.confirm(`${o.title || "Are you sure?"}\n\n${o.body || ""}`));
  }
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal";
    dlg.innerHTML = `
      <h3>${esc(o.title || "Are you sure?")}</h3>
      <p>${esc(o.body || "")}</p>
      <div class="modal-actions">
        <button type="button" class="ghost" data-act="cancel">${esc(o.cancel || "Cancel")}</button>
        <button type="button" class="danger" data-act="ok">${esc(o.confirm || "Confirm")}</button>
      </div>`;
    document.body.appendChild(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('[data-act="ok"]').onclick = () => done(true);
    dlg.querySelector('[data-act="cancel"]').onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
  });
}

/* --------------------------- view preferences --------------------------- */
/* Keeps the user's view settings across reloads (docs §6). Never throws:
   private mode / disabled storage must degrade silently. */
function getPref(key, fallback) {
  try {
    const raw = localStorage.getItem(`dash.${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function setPref(key, value) {
  try {
    localStorage.setItem(`dash.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable — view prefs are a nice-to-have */
  }
}

/* --------------------- combobox (searchable select) --------------------- */
/* First-principles fix for the Provider/Model pickers: choosing one item out
   of ~1900 is a *search* task, not a *scroll* task. Keyboard-complete and
   ARIA-correct; see docs/DASHBOARD-UI.md §3 for the full behaviour contract. */
let cbxSeq = 0;

function defaultCbxSearch(o, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return String(o.id).toLowerCase().includes(needle) ||
    String(o.label || "").toLowerCase().includes(needle) ||
    String(o.search || "").toLowerCase().includes(needle);
}

function cbxOptionHtml(o) {
  const label = o.html !== undefined
    ? o.html
    : `<span class="cbx-name">${esc(o.label === undefined ? o.id : o.label)}</span>`;
  const sub = o.sub ? `<div class="cbx-sub">${o.sub}</div>` : "";
  return `${label}${sub}`;
}

/**
 * Turns `root` into a combobox. Returns { refresh, close, value }.
 * opts: { options, value, onChange, placeholder, search, groups, empty,
 *         render, allowEmpty, className }
 */
function combobox(root, opts) {
  const o = opts || {};
  const search = o.search || defaultCbxSearch;
  const groups = o.groups || null;
  // Optional ordering. Grouping only reads as grouping when members are
  // contiguous, so callers that group should also sort (stable sort keeps the
  // natural order inside each group).
  const sort = o.sort || null;
  const emptyText = o.empty || "No matches";

  root.classList.add("cbx");
  if (o.className) root.classList.add(o.className);
  root.innerHTML = "";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cbx-btn";
  btn.setAttribute("role", "combobox");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-haspopup", "listbox");
  const labelEl = document.createElement("span");
  labelEl.className = "cbx-label";
  const caret = document.createElement("span");
  caret.className = "cbx-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = "▾";
  btn.append(labelEl, caret);

  const pop = document.createElement("div");
  pop.className = "cbx-pop";
  pop.hidden = true;

  const input = document.createElement("input");
  input.type = "search";
  input.className = "cbx-input";
  input.placeholder = o.placeholder || "Search…";
  input.setAttribute("aria-label", o.placeholder || "Search");

  const list = document.createElement("div");
  list.className = "cbx-list";
  list.setAttribute("role", "listbox");
  list.id = `cbx-list-${++cbxSeq}`;
  input.setAttribute("aria-controls", list.id);

  const noMatch = document.createElement("div");
  noMatch.className = "cbx-empty";
  noMatch.hidden = true;

  pop.append(input, list, noMatch);
  root.append(btn, pop);

  /** Currently displayed options (flat, i.e. without group headers). */
  let flat = [];
  let active = -1;

  function currentLabel() {
    const id = o.value();
    const all = o.options() || [];
    const hit = all.find((x) => x.id === id);
    if (hit) {
      const text = hit.label === undefined ? hit.id : hit.label;
      return { text, ready: hit.ready === true };
    }
    // No selection yet: show a short prompt, not the long search placeholder.
    return { text: id || o.emptyLabel || "Select…", ready: false };
  }

  function paintTrigger() {
    const cur = currentLabel();
    labelEl.innerHTML = `${esc(cur.text)}${cur.ready ? ' <span class="badge ok">ready</span>' : ""}`;
    labelEl.classList.toggle("placeholder", !o.value());
  }

  function paintList() {
    const q = input.value;
    const filtered = (o.options() || []).filter((x) => search(x, q));
    const opts2 = sort ? filtered.slice().sort(sort) : filtered;
    flat = opts2;
    active = -1;
    noMatch.hidden = opts2.length > 0;
    noMatch.textContent = emptyText;

    const html = [];
    let lastGroup = null;
    opts2.forEach((item, i) => {
      const g = groups ? groups(item) : null;
      if (g && g !== lastGroup) {
        html.push(`<div class="cbx-group">${esc(g)}</div>`);
        lastGroup = g;
      } else if (!g) {
        lastGroup = null;
      }
      const selected = item.id === o.value();
      html.push(
        `<div class="cbx-opt${selected ? " sel" : ""}" role="option" id="${list.id}-${i}" ` +
        `aria-selected="${selected ? "true" : "false"}" data-i="${i}">${cbxOptionHtml(item)}</div>`,
      );
    });
    list.innerHTML = html.join("");
    for (const el of list.querySelectorAll(".cbx-opt")) {
      el.addEventListener("mousedown", (ev) => {
        // mousedown (not click) so the choice wins over the input's blur.
        ev.preventDefault();
        pick(Number(el.getAttribute("data-i")));
      });
    }
  }

  function setActive(i) {
    const nodes = list.querySelectorAll(".cbx-opt");
    if (!nodes.length) return;
    active = Math.max(0, Math.min(i, nodes.length - 1));
    nodes.forEach((n, idx) => n.classList.toggle("active", idx === active));
    const node = nodes[active];
    if (node) {
      // Mirror on both: the button carries role=combobox, but focus is inside
      // the search input while open, and AT reads the focused element.
      input.setAttribute("aria-activedescendant", node.id);
      btn.setAttribute("aria-activedescendant", node.id);
      if (node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
    }
  }

  function pick(i) {
    const item = flat[i];
    if (!item) return;
    const changed = item.id !== o.value();
    o.onChange && o.onChange(item.id, item);
    paintTrigger();
    close();
    if (changed) refresh();
  }

  function onDocDown(ev) {
    if (!root.contains(ev.target)) close();
  }

  function open() {
    if (!pop.hidden) return;
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    root.classList.add("open");
    input.value = "";
    paintList();
    input.focus();
    const sel = flat.findIndex((x) => x.id === o.value());
    setActive(sel >= 0 ? sel : 0);
    document.addEventListener("mousedown", onDocDown, true);
  }

  function close() {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    root.classList.remove("open");
    document.removeEventListener("mousedown", onDocDown, true);
  }

  btn.onclick = () => (pop.hidden ? open() : close());
  input.oninput = () => {
    paintList();
    setActive(0);
  };
  input.onkeydown = (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); setActive(active + 1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setActive(active - 1); }
    else if (ev.key === "Home") { ev.preventDefault(); setActive(0); }
    else if (ev.key === "End") { ev.preventDefault(); setActive(flat.length - 1); }
    else if (ev.key === "Enter") { ev.preventDefault(); if (active >= 0) pick(active); }
    else if (ev.key === "Escape") { ev.preventDefault(); close(); btn.focus(); }
    else if (ev.key === "Tab") { close(); }
  };
  btn.onkeydown = (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      open();
    }
  };

  function refresh() {
    paintTrigger();
    if (!pop.hidden) paintList();
  }

  paintTrigger();
  return { refresh, close, open, el: root };
}

/* -------------------------- segmented control -------------------------- */
/** Radio-style group; opts: { options:[{id,label,hint}], value:()=>id, onChange } */
function segmented(root, opts) {
  const o = opts || {};
  root.classList.add("seg");
  root.setAttribute("role", "radiogroup");
  function paint() {
    const cur = o.value();
    root.innerHTML = (o.options || []).map((it) => `
      <button type="button" role="radio" aria-checked="${it.id === cur ? "true" : "false"}"
        class="seg-item${it.id === cur ? " active" : ""}" data-id="${esc(it.id)}"
        title="${esc(it.hint || "")}">${esc(it.label)}</button>`).join("");
    for (const b of root.querySelectorAll(".seg-item")) {
      b.onclick = () => { o.onChange && o.onChange(b.getAttribute("data-id")); paint(); };
    }
  }
  paint();
  return { refresh: paint };
}

/* --------------------------- WS client --------------------------- */
/** Connect to the dashboard WS with auto-reconnect; handlers are optional. */
function connectWs(handlers) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let ws = null;
  let closed = false;
  let attempts = 0;
  let everOpen = false;

  const setLink = (text, cls) => {
    if (handlers.onLink) handlers.onLink(text, cls);
  };

  function open() {
    if (closed) return;
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      attempts = 0;
      everOpen = true;
      setLink("live", "ok");
    };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      switch (msg.type) {
        case "snapshot": handlers.onSnapshot && handlers.onSnapshot(msg.data); break;
        case "event": handlers.onEvent && handlers.onEvent(msg.data); break;
        case "telemetry": handlers.onTelemetry && handlers.onTelemetry(msg.data); break;
        case "step": handlers.onStep && handlers.onStep(msg.data); break;
        case "checkpoint": handlers.onCheckpoint && handlers.onCheckpoint(msg.data); break;
      }
    };
    ws.onclose = () => {
      if (closed) return;
      attempts++;
      setLink(everOpen ? `reconnecting… (${attempts})` : "waiting for server…", "bad");
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
    ["/providers", "Providers"],
    ["/sessions", "Sessions"],
  ];
  return `<nav class="nav">${items
    .map(([href, label]) =>
      `<a href="${href}" class="${href === active ? "active" : ""}">${esc(label)}</a>`)
    .join("")}</nav>`;
}

/* --------------------------- KPI tile --------------------------- */
/**
 * One headline number with optional delta chip and sparkline.
 * kpi({label, value, delta, deltaFmt, positiveIsGood, spark, color, hint, href})
 */
function kpi(k) {
  const sparkId = k.spark && k.spark.length > 1 ? `sp-${Math.random().toString(36).slice(2, 9)}` : null;
  const chip = k.delta !== undefined && Number.isFinite(Number(k.delta))
    ? deltaChip(k.delta, k.deltaFmt, k.positiveIsGood) : "";
  return `<div class="kpi${k.href ? " clickable" : ""}"${k.href ? ` data-href="${esc(k.href)}"` : ""}>
    <div class="kpi-k">${esc(k.label)}</div>
    <div class="kpi-v">${k.value}</div>
    ${chip || k.hint ? `<div class="kpi-hint">${chip}${k.hint ? esc(k.hint) : ""}</div>` : ""}
    ${sparkId ? `<canvas class="kpi-spark" id="${sparkId}" height="26"></canvas>` : ""}
  </div>`;
}

/**
 * Draw the sparkline of each `.kpi` tile that carries one.
 * `perTile` is aligned to the tile order; entries may be null (no spark).
 */
function paintSparks(root, perTile) {
  const tiles = root.querySelectorAll(".kpi");
  tiles.forEach((tile, i) => {
    const spec = (perTile || [])[i];
    const cv = tile.querySelector(".kpi-spark");
    if (!cv || !spec || !spec.data || spec.data.length < 2) return;
    window.Charts.sparkline(cv, spec.data, { color: spec.color || PALETTE[0] });
  });
}

/* --------------------------- chart palette --------------------------- */
/* Mirrors --c1..--c8 in style.css so legends/tables match the chart series. */
const PALETTE = ["#ffb347", "#5fb3ff", "#7bc96f", "#c3a6ff", "#e06c75", "#e5c07b", "#56d4dd", "#f28fad"];

/** Stable per-index series color (negative/NaN-safe). */
function pickColor(i) {
  return PALETTE[Math.abs(Number(i) || 0) % PALETTE.length];
}

/* Expose to page scripts (no modules => no build concerns). */
window.UI = {
  // dom
  $, esc,
  // format
  fmtInt, fmtMoney, fmtTok, fmtCost, fmtDuration, fmtAgo, fmtClock, fmtPct, fmtGameDate,
  deltaClass, deltaChip,
  // events
  categoryOf, categoryClass, categoryLabel, categoryCounts, eventMatches, briefOf,
  // widgets
  toast, confirmDialog, combobox, segmented, kpi, paintSparks,
  // prefs
  getPref, setPref,
  // charts helpers
  PALETTE, pickColor,
  // infra
  connectWs, renderNav,
};
