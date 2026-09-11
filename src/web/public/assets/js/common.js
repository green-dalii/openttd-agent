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
/*
 * 数字由平台 `Intl` 渲染；**单位阶梯是本项目的显式约定**。
 *
 * 为什么换（2026-09-11，docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.3）: 手写实现要自己维护
 * 小数位与稀有量级回退，而且硬编了 en-US。
 *
 * 为什么不直接用 `notation:"compact"`（同一轮实测踩到的坑）:
 *   **compact 的后缀拼写是 CLDR 版本数据，不是契约**。同一次调用实测：
 *     | 值    | Node 24 | Chrome 149 | 本项目 charts.js |
 *     |-------|---------|------------|------------------|
 *     | 1500  | 1.5K    | 1.5k       | 1.5k             |
 *     | 1.5e6 | 1.5M    | 1.5m       | 1.5M             |
 *     | 1.5e9 | 1.5B    | **1.5bn**  | 1.5B             |
 *   让 ICU 决定单位会导致同一页面 KPI 写 `£1.5bn`、图表轴写 `1.5B` 自相矛盾，
 *   而且换一次运行时就会变。所以: **Intl 只负责数字部分**（千分位/舍入/小数位），
 *   **k/M/B/T 由本文件定义**，与 charts.js 保持一致。
 *
 * 关键约束: 格式化器在模块加载时构造一次并复用。
 * `new Intl.NumberFormat()` 的构造成本远高于 format()，而这些函数在渲染循环里高频调用。
 * `test/unit/format-intl.test.ts` 会数构造次数，并在一个拒绝 compact notation 的
 * 敌对 Intl 下重跑，防止有人改回让 ICU 决定单位。
 */
const LOCALE = "en-GB";

/** Ordinal grouping for counts (1,234,567). */
const FMT_INT = new Intl.NumberFormat(LOCALE);
/** ≤1 decimal: token counts, chart magnitudes. */
const FMT_1DP = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 });
/** ≤2 decimals: money, where the extra digit matters. */
const FMT_2DP = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
/** Rounded whole numbers, for money below the ladder threshold. */
const FMT_0DP = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
/** Provider token costs are quoted in USD and routinely fall below one cent. */
const FMT_COST = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 3,
  maximumFractionDigits: 4,
});
/** Wall-clock, 24h, zero-padded. */
const FMT_CLOCK = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const FMT_AGO = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });
/** Percent formatters are keyed by decimal digits; normally 0-2 variants. */
const FMT_PCT = new Map();
function pctFormatter(digits) {
  let f = FMT_PCT.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, {
      style: "percent",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    FMT_PCT.set(digits, f);
  }
  return f;
}

/**
 * Magnitude ladder - the dashboard's shared vocabulary.
 * Mirrors `charts.js` `util.fmtCompact` so a KPI tile and an axis agree.
 */
const COMPACT_UNITS = [
  { limit: 1e12, div: 1e12, suffix: "T" },
  { limit: 1e9, div: 1e9, suffix: "B" },
  { limit: 1e6, div: 1e6, suffix: "M" },
  { limit: 1e3, div: 1e3, suffix: "k" },
];

/**
 * Compact a magnitude using the shared ladder; Intl renders only the digits.
 * `digits` selects the decimal budget (1 for counts, 2 for money).
 * Beyond the largest unit the scaled value simply keeps grouping (18,446,744T),
 * which stays honest instead of overflowing into a wrong unit.
 */
function compact(v, digits) {
  const fmt = digits === 2 ? FMT_2DP : FMT_1DP;
  const a = Math.abs(v);
  for (const u of COMPACT_UNITS) {
    if (a >= u.limit) return fmt.format(v / u.div) + u.suffix;
  }
  return FMT_0DP.format(v);
}

/** Shared guard: these formatters throw on non-finite input, so filter first. */
function finite(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

/**
 * True for "no data at all". Note `Number(null) === 0`, which is how a missing
 * value used to render as a confident `0` - that is a lie, not a default.
 */
function isBlank(n) {
  return n === null || n === undefined || n === "";
}

function fmtInt(n) {
  if (isBlank(n)) return "—";
  const v = finite(n);
  return v === null ? "—" : FMT_INT.format(v);
}

function fmtMoney(n) {
  if (isBlank(n)) return "—";
  const v = finite(n);
  if (v === null) return "—";
  // Sign goes outside the symbol: "-£2.5M", matching the old output.
  const sign = v < 0 ? "-" : "";
  return `${sign}£${compact(Math.abs(v), 2)}`;
}

function fmtTok(n) {
  const v = finite(n);
  return v === null || v === 0 ? "0" : compact(v, 1);
}

function fmtCost(n) {
  const v = finite(n);
  if (v === null) return "—";
  // A run that has spent nothing reads better as "$0" than "$0.000".
  return v === 0 ? "$0" : FMT_COST.format(v);
}

/**
 * Compact durations: `500ms`, `1.5s`, `1m30s`, `1h10m`.
 *
 * 刻意保留手写: `Intl.DurationFormat` 尚未在目标浏览器普遍可用，
 * 且这里的单位选择（毫秒/秒/分时）是仪表盘的展示约定，不是 locale 问题。
 */
function fmtDuration(ms) {
  const v = finite(ms);
  if (v === null) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
  if (v < 3600000) return `${Math.floor(v / 60000)}m${Math.round((v % 60000) / 1000)}s`;
  return `${Math.floor(v / 3600000)}h${Math.round((v % 3600000) / 60000)}m`;
}

/**
 * "5 minutes ago" via `Intl.RelativeTimeFormat` (plural rules for free).
 * 输入是 epoch 毫秒；`<= 0` 视为无数据。
 */
function fmtAgo(ts) {
  const v = finite(ts);
  if (v === null || v <= 0) return "—";
  const secs = Math.max(0, Math.round((Date.now() - v) / 1000));
  // Under a minute reads as "now"; RTF has no unit coarser than seconds.
  if (secs < 45) return FMT_AGO.format(0, "second");
  if (secs < 3600) return FMT_AGO.format(-Math.round(secs / 60), "minute");
  if (secs < 86400) return FMT_AGO.format(-Math.round(secs / 3600), "hour");
  return FMT_AGO.format(-Math.round(secs / 86400), "day");
}

function fmtClock(ts) {
  const v = finite(ts);
  return v === null ? "—" : FMT_CLOCK.format(new Date(v));
}

function fmtPct(v, digits) {
  const n = finite(v);
  if (n === null) return "—";
  return pctFormatter(digits === undefined ? 1 : digits).format(n);
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
  /** @type {Record<string, number>} */
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

/* --------------------- container-local scrolling --------------------- */
/**
 * Scroll a container to its end **without touching the page**.
 *
 * 为什么不用 `el.scrollIntoView()`（2026-09-11 用户实测报告）:
 *   `scrollIntoView` 会滚动 **所有可滚动祖先，包括文档本身**。
 *   Agent steps 每追加一条就调用它，于是页面不停自己往下跳，
 *   把用户正在读的地方顶走 —— 一个局部列表的更新却抢走了整页焦点。
 *   直接设置 `scrollTop` 只影响这个元素。
 *
 * 禁止: 用 `scrollIntoView` 做"跟随最新"（它表达不了"只滚这个容器"）；
 *   `web-assets.test.ts` 有静态护栏阻止它回来。
 */
function scrollToEnd(el) {
  if (!el) return false;
  const sh = Number(el.scrollHeight);
  const ch = Number(el.clientHeight);
  if (!Number.isFinite(sh) || !Number.isFinite(ch)) return false;
  // Nothing to do when the content already fits (also avoids a pointless reflow).
  if (sh <= ch) return false;
  el.scrollTop = sh;
  return true;
}

/**
 * Scroll `container` just enough to reveal `child`, and nothing else.
 *
 * Same reasoning as `scrollToEnd`: `scrollIntoView` walks up and scrolls every
 * scrollable ancestor, so a dropdown opened low on the page would yank the page.
 * Uses rects, so it does not depend on `offsetParent`.
 */
function keepVisible(container, child) {
  if (!container || !child || !container.getBoundingClientRect) return false;
  const c = container.getBoundingClientRect();
  const b = child.getBoundingClientRect();
  if (b.top < c.top) {
    container.scrollTop -= c.top - b.top;
    return true;
  }
  if (b.bottom > c.bottom) {
    container.scrollTop += b.bottom - c.bottom;
    return true;
  }
  return false;
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
    // The DOM lib types `querySelector` as Element, which has no `onclick`;
    // these are buttons we just created, so narrow explicitly.
    /** @type {HTMLButtonElement | null} */ (dlg.querySelector('[data-act="ok"]')).onclick = () => done(true);
    /** @type {HTMLButtonElement | null} */ (dlg.querySelector('[data-act="cancel"]')).onclick = () => done(false);
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
      keepVisible(list, node);
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
        case "run": handlers.onRun && handlers.onRun(msg.data); break;
        case "stage": handlers.onStage && handlers.onStage(msg.data); break;
        case "stageImage": handlers.onStageImage && handlers.onStageImage(msg.data); break;
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
/** Render the nav into an element by id. Shared by every page. */
function renderNavInto(id, active) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = renderNav(active);
}

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
  toast, confirmDialog, combobox, segmented, kpi, paintSparks, scrollToEnd, keepVisible,
  // prefs
  getPref, setPref,
  // charts helpers
  PALETTE, pickColor,
  /** Sum [{values:number[]}] — for chart legends. */
  utilTotals: (items) => (items || []).reduce(
    (a, it) => a + (it.values || []).reduce((x, v) => x + (Number(v) || 0), 0), 0),
  // infra
  connectWs, renderNav, renderNavInto,
};
