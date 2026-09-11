/* charts.js — dashboard chart module (plain browser script, no build chain).
 *
 * 职责: 提供 4 种图表（折线/柱/环/迷你线）+ 纯计算工具，供 Live/Sessions 页使用。
 *   自建而非引库：本项目要求**离线可用、无构建链**，所需图形只有这 4 种，
 *   ~400 行可控代码胜过第三方体积与版本漂移（见 docs/DASHBOARD-UI.md §4）。
 * 事实来源: docs/DASHBOARD-UI.md §4（图表模块契约）。
 * 禁止:
 *   - 加载期**不得**访问 document/window/devicePixelRatio（只能在函数体内），
 *     否则无法在 node:vm 沙箱里单测纯函数（test/unit/charts.test.ts 依赖此约束）。
 *   - 不得使用 import/export（这是 <script> 全局脚本）。
 *   - 不得在空数据时抛异常（清空画布即可）。
 */
"use strict";

(function () {
  /* ------------------------------ state ------------------------------ */
  /* Per-canvas bookkeeping. WeakMap => canvases stay collectable. */
  const STATE = new WeakMap();

  function readDpr() {
    // Read at draw time, never at load time (see file header).
    return typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
  }

  function cssVar(name, fallback) {
    if (typeof document === "undefined" || !document.documentElement) return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function palette() {
    return [
      cssVar("--c1", "#ffb347"), cssVar("--c2", "#5fb3ff"), cssVar("--c3", "#7bc96f"),
      cssVar("--c4", "#c3a6ff"), cssVar("--c5", "#e06c75"), cssVar("--c6", "#e5c07b"),
      cssVar("--c7", "#56d4dd"), cssVar("--c8", "#f28fad"),
    ];
  }

  const INK = function () { return cssVar("--ink", "#dde5ea"); };
  const MUTED = function () { return cssVar("--muted", "#7f929e"); };
  const LINE = function () { return cssVar("--line", "#26323a"); };
  const SUNKEN = function () { return cssVar("--bg-sunken", "#0d1216"); };

  /* ------------------------------ utils ------------------------------ */
  /** Round away float noise introduced by repeated addition of a step. */
  function round12(v) {
    return Math.abs(v) < 1e12 ? Number(v.toPrecision(12)) : v;
  }

  /** "Nice" 1/2/5×10^n number at or above (round=true) or nearest (round=false). */
  function niceNum(range, round) {
    if (!(range > 0)) return 1;
    const exp = Math.floor(Math.log10(range));
    const frac = range / Math.pow(10, exp);
    let nice;
    if (round) nice = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    else nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    return nice * Math.pow(10, exp);
  }

  /**
   * Ascending tick values covering [min,max]. Never returns [] for a finite
   * range, and never emits NaN for the degenerate min===max case.
   */
  function niceTicks(min, max, count) {
    const n = Math.max(2, Math.floor(count || 5));
    if (!isFinite(min) || !isFinite(max)) return [];
    if (min > max) { const t = min; min = max; max = t; }
    if (min === max) { const d = Math.abs(min) || 1; min -= d; max += d; }
    const step = niceNum(niceNum(max - min, false) / (n - 1), true);
    if (!(step > 0)) return [min, max];
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step * 1e-9 && out.length < 200; v += step) out.push(round12(v));
    return out.length ? out : [min, max];
  }

  /** Domain snapped outward to tick boundaries; optionally forced to include 0. */
  function niceDomain(min, max, opts) {
    const o = opts || {};
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    let lo = Math.min(min, max);
    let hi = Math.max(min, max);
    if (o.includeZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (lo === hi) { const d = Math.abs(lo) || 1; lo -= d; hi += d; }
    const pad = (hi - lo) * 0.04;
    const ticks = niceTicks(lo - pad, hi + pad, 5);
    if (!ticks.length) return [lo, hi];
    return [ticks[0], ticks[ticks.length - 1]];
  }

  /** Linear map from domain [d0,d1] to range [r0,r1]; degenerate domain is safe. */
  function scaleLinear(domain, range) {
    const d0 = Number(domain[0]), d1 = Number(domain[1]);
    const r0 = Number(range[0]), r1 = Number(range[1]);
    const dd = d1 - d0 || 1;
    return function (v) {
      const t = (Number(v) - d0) / dd;
      return r0 + (Number.isFinite(t) ? t : 0) * (r1 - r0);
    };
  }

  /** Arbitrary-but-stable fractional parts for donut slices. */
  function fractionsOf(values) {
    const total = values.reduce(function (a, v) { return a + (Number(v) || 0); }, 0);
    if (!(total > 0)) return values.map(function () { return 0; });
    return values.map(function (v) { return (Number(v) || 0) / total; });
  }

  /**
   * Donut arcs from values (clockwise from 12 o'clock). All-zero input yields
   * frac 0 slices collapsed at the start angle — never NaN.
   */
  function donutSlices(values, opts) {
    const o = opts || {};
    const list = Array.isArray(values) ? values.map(Number) : [];
    const colors = o.colors || palette();
    const fr = fractionsOf(list);
    const start = typeof o.startAngle === "number" ? o.startAngle : -Math.PI / 2;
    let acc = start;
    return fr.map(function (f, i) {
      const a0 = acc;
      const a1 = acc + f * Math.PI * 2;
      acc = a1;
      return {
        index: i,
        value: list[i],
        frac: f,
        startAngle: a0,
        endAngle: a1,
        color: (o.slices && o.slices[i] && o.slices[i].color) || colors[i % colors.length],
        label: (o.slices && o.slices[i] && o.slices[i].label) || String(i),
      };
    });
  }

  /**
   * Zero-based upper domain for bar/column charts: [0, niceMax].
   *
   * Bar charts must start at 0 — that is what makes bar length proportional to
   * value. niceDomain() pads ~4% below the minimum, which for a non-negative
   * series pushes the axis below zero and leaves a dead band under the bars.
   */
  function zeroBasedDomain(max, count) {
    const hi = Number(max);
    if (!isFinite(hi) || hi <= 0) return [0, 1];
    const ticks = niceTicks(0, hi, count || 5);
    const top = ticks.length ? ticks[ticks.length - 1] : hi;
    return [0, top > 0 ? top : 1];
  }

  /**
   * Stack series values per item: returns per-item totals, the running total and
   * the max stack height (for the y domain). Pure — safe to unit test.
   */
  function stackTotals(items, seriesCount) {
    const list = Array.isArray(items) ? items : [];
    const n = Math.max(0, Number(seriesCount) || 0);
    const totals = [];
    let running = 0;
    let maxStack = 0;
    for (const it of list) {
      const vals = (it && Array.isArray(it.values) ? it.values : []).slice(0, n);
      let sum = 0;
      for (const v of vals) sum += Number(v) || 0;
      totals.push(sum);
      running += sum;
      if (sum > maxStack) maxStack = sum;
    }
    return { totals: totals, total: running, maxStack: maxStack };
  }

  /** 1.5k / 2M / -3B style compaction; "—" for non-finite. */
  function fmtCompact(v) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    const a = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    const one = function (x) { return x.toFixed(1).replace(/\.0$/, ""); };
    if (a >= 1e12) return sign + one(a / 1e12) + "T";
    if (a >= 1e9) return sign + one(a / 1e9) + "B";
    if (a >= 1e6) return sign + one(a / 1e6) + "M";
    if (a >= 1e3) return sign + one(a / 1e3) + "k";
    return String(Math.round(n));
  }

  /* ------------------------------ canvas ------------------------------ */
  /** Size the backing store for DPR and return a CSS-pixel coordinate system. */
  function fit(canvas, optH) {
    const dpr = readDpr();
    const cssW = Math.max(1, Math.round(canvas.clientWidth || Number(canvas.getAttribute("width")) || 600));
    const cssH = Math.max(1, Math.round(optH || Number(canvas.getAttribute("height")) || 180));
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx: ctx, w: cssW, h: cssH };
  }

  /**
   * Empty state: still size the canvas via fit() so an unpopulated chart occupies
   * the same box as a populated one. Skipping this left the default 300x200
   * backing store, which (with `canvas{width:100%}` and no CSS height) rendered a
   * 3:2 box that jumped in height as soon as data arrived.
   */
  function sizedClear(canvas, optH) {
    fit(canvas, optH);
  }

  /* ------------------------------ tooltip ------------------------------ */
  let tipEl = null;
  let tipHideTimer = null;

  function tipShow(html, x, y) {
    if (typeof document === "undefined" || !document.body) return;
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.id = "chart-tip";
      tipEl.className = "chart-tip";
      tipEl.setAttribute("role", "status");
      document.body.appendChild(tipEl);
    }
    if (tipHideTimer) { clearTimeout(tipHideTimer); tipHideTimer = null; }
    tipEl.innerHTML = html;
    tipEl.style.opacity = "1";
    const r = tipEl.getBoundingClientRect();
    const vw = window.innerWidth || 1024;
    const left = Math.min(Math.max(8, x + 12), vw - r.width - 8);
    tipEl.style.left = left + "px";
    tipEl.style.top = Math.max(8, y - r.height - 12) + "px";
  }

  function tipHide() {
    if (!tipEl) return;
    tipEl.style.opacity = "0";
  }

  /* --------------------------- (re)draw plumbing --------------------------- */
  /**
   * Store the draw closure for a canvas, wire ResizeObserver + hover exactly
   * once, then draw. Repeated calls must not stack listeners.
   */
  function mount(canvas, drawFn) {
    let st = STATE.get(canvas);
    if (!st) {
      st = { draw: null, obs: null, lastW: 0, lastH: 0, hover: null };
      STATE.set(canvas, st);
    }
    st.draw = drawFn;
    if (!st.obs && typeof ResizeObserver !== "undefined") {
      st.obs = new ResizeObserver(function () {
        const w = canvas.clientWidth;
        if (!w || w === st.lastW) return; // ignore our own backing-store writes
        st.lastW = w;
        if (st.draw) st.draw();
      });
      st.obs.observe(canvas);
    }
    drawFn();
  }

  function bindHover(canvas, onMove, onLeave) {
    const st = STATE.get(canvas) || {};
    if (st.bound) {
      st.onMove = onMove;
      st.onLeave = onLeave;
      return;
    }
    st.bound = true;
    st.onMove = onMove;
    st.onLeave = onLeave;
    canvas.addEventListener("mousemove", function (ev) {
      const cur = STATE.get(canvas);
      if (cur && cur.onMove) cur.onMove(ev);
    });
    canvas.addEventListener("mouseleave", function () {
      const cur = STATE.get(canvas);
      if (cur && cur.onLeave) cur.onLeave();
    });
    STATE.set(canvas, st);
  }

  /* ------------------------------ line ------------------------------ */
  /**
   * Multi-series line chart. cfg:
   *   series: { name, color?, data: number[], dashed? }[]
   *   labels?: string[]   format?: (v)=>string   area?: boolean
   *   yZero?: boolean     height?: number
   */
  function line(canvas, cfg) {
    const c = cfg || {};
    const series = (c.series || []).filter(function (s) { return s && Array.isArray(s.data); });
    if (!series.length) { sizedClear(canvas, c.height); return; }
    const labels = c.labels || [];
    const fmt = c.format || fmtCompact;
    const pal = palette();

    let hoverIdx = null;

    function draw() {
      const g = fit(canvas, c.height);
      const ctx = g.ctx, W = g.w, H = g.h;
      const all = [];
      for (const s of series) for (const v of s.data) if (isFinite(v)) all.push(Number(v));
      if (!all.length) return;

      const dom = niceDomain(Math.min.apply(null, all), Math.max.apply(null, all), { includeZero: c.yZero !== false });
      const padL = 46, padR = 12, padT = 12, padB = labels.length ? 20 : 14;
      const innerW = Math.max(1, W - padL - padR);
      const innerH = Math.max(1, H - padT - padB);
      const y = scaleLinear(dom, [padT + innerH, padT]);
      const maxLen = Math.max.apply(null, series.map(function (s) { return s.data.length; }));
      const x = function (i) { return padL + (i / Math.max(maxLen - 1, 1)) * innerW; };

      // plot background
      ctx.fillStyle = SUNKEN();
      ctx.fillRect(padL, padT, innerW, innerH);

      // grid + y labels
      const ticks = niceTicks(dom[0], dom[1], 5);
      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      for (const t of ticks) {
        const yy = y(t);
        if (yy < padT - 1 || yy > padT + innerH + 1) continue;
        ctx.strokeStyle = LINE();
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(yy) + 0.5);
        ctx.lineTo(padL + innerW, Math.round(yy) + 0.5);
        ctx.stroke();
        ctx.fillStyle = MUTED();
        ctx.textAlign = "right";
        ctx.fillText(fmt(t), padL - 6, yy);
      }

      // x labels (first / last only, to stay readable)
      if (labels.length) {
        ctx.fillStyle = MUTED();
        ctx.textAlign = "left";
        ctx.fillText(String(labels[0]), padL, H - 8);
        ctx.textAlign = "right";
        ctx.fillText(String(labels[labels.length - 1]), padL + innerW, H - 8);
      }

      // series
      series.forEach(function (s, si) {
        const color = s.color || pal[si % pal.length];
        const pts = [];
        s.data.forEach(function (v, i) {
          if (!isFinite(v)) return;
          pts.push([x(i), y(Number(v))]);
        });
        if (!pts.length) return;
        if (c.area) {
          const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
          grad.addColorStop(0, hexA(color, 0.28));
          grad.addColorStop(1, hexA(color, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(pts[0][0], padT + innerH);
          for (const p of pts) ctx.lineTo(p[0], p[1]);
          ctx.lineTo(pts[pts.length - 1][0], padT + innerH);
          ctx.closePath();
          ctx.fill();
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.setLineDash(s.dashed ? [4, 3] : []);
        ctx.beginPath();
        pts.forEach(function (p, i) { i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]); });
        ctx.stroke();
        ctx.setLineDash([]);
        // last-point marker
        const last = pts[pts.length - 1];
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(last[0], last[1], 2.6, 0, Math.PI * 2);
        ctx.fill();
      });

      // hover crosshair + tooltip
      if (hoverIdx !== null && hoverIdx < maxLen) {
        const hx = x(hoverIdx);
        ctx.strokeStyle = MUTED();
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hx, padT);
        ctx.lineTo(hx, padT + innerH);
        ctx.stroke();
        ctx.setLineDash([]);
        series.forEach(function (s, si) {
          const v = s.data[hoverIdx];
          if (!isFinite(v)) return;
          ctx.fillStyle = s.color || pal[si % pal.length];
          ctx.beginPath();
          ctx.arc(hx, y(Number(v)), 3.4, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }

    mount(canvas, draw);

    bindHover(canvas, function (ev) {
      const rect = canvas.getBoundingClientRect();
      const padL = 46, padR = 12;
      const innerW = Math.max(1, rect.width - padL - padR);
      const maxLen = Math.max.apply(null, series.map(function (s) { return s.data.length; }));
      const rel = (ev.clientX - rect.left - padL) / innerW;
      const idx = Math.round(rel * Math.max(maxLen - 1, 1));
      const clamped = Math.min(Math.max(idx, 0), Math.max(maxLen - 1, 0));
      if (clamped === hoverIdx) return;
      hoverIdx = clamped;
      draw();
      const head = labels[clamped] !== undefined ? "<b>" + escHtml(String(labels[clamped])) + "</b>" : "<b>#" + (clamped + 1) + "</b>";
      const rows = series.map(function (s, si) {
        const col = s.color || pal[si % pal.length];
        const v = s.data[clamped];
        return '<div class="ct-row"><i style="background:' + col + '"></i>' +
          escHtml(s.name || ("series " + (si + 1))) +
          "<b>" + escHtml(isFinite(v) ? fmt(Number(v)) : "—") + "</b></div>";
      }).join("");
      tipShow(head + rows, ev.clientX, ev.clientY);
    }, function () {
      if (hoverIdx === null) return;
      hoverIdx = null;
      draw();
      tipHide();
    });
  }

  /* ------------------------------ bars ------------------------------ */
  /**
   * Bar chart. cfg:
   *   items: { label, value, color?, sub? }[]
   *   format?: (v)=>string   horizontal?: boolean   height?: number   max?: number
   */
  function bars(canvas, cfg) {
    const c = cfg || {};
    const fmt = c.format || fmtCompact;
    const pal = palette();
    let items = (c.items || []).filter(function (i) { return i && isFinite(i.value); });

    function draw() {
      if (!items.length) { sizedClear(canvas, c.height); return; }
      const g = fit(canvas, c.height);
      const ctx = g.ctx, W = g.w, H = g.h;
      ctx.font = "10px ui-monospace, monospace";

      if (c.horizontal) {
        const sorted = items.slice().sort(function (a, b) { return b.value - a.value; })
          .slice(0, c.max || 12);
        const rowH = Math.min(30, Math.max(18, (H - 6) / sorted.length));
        const labelW = 132;
        const vmax = Math.max.apply(null, sorted.map(function (i) { return Math.abs(i.value); })) || 1;
        sorted.forEach(function (it, i) {
          const yy = i * rowH + 3;
          const barW = Math.max(2, (Math.abs(it.value) / vmax) * (W - labelW - 54));
          ctx.fillStyle = INK();
          ctx.textBaseline = "middle";
          ctx.textAlign = "right";
          ctx.fillText(clip(it.label, 18), labelW - 8, yy + rowH / 2);
          ctx.fillStyle = it.color || pal[i % pal.length];
          roundRect(ctx, labelW, yy + 3, barW, rowH - 8, 3);
          ctx.fill();
          ctx.fillStyle = INK();
          ctx.textAlign = "left";
          ctx.fillText(fmt(it.value), labelW + barW + 6, yy + rowH / 2);
        });
        return;
      }

      const padL = 46, padR = 12, padT = 12, padB = 26;
      const innerW = Math.max(1, W - padL - padR);
      const innerH = Math.max(1, H - padT - padB);
      const vmax = Math.max.apply(null, items.map(function (i) { return Math.max(0, i.value); })) || 1;
      const dom = zeroBasedDomain(vmax);
      const y = scaleLinear(dom, [padT + innerH, padT]);
      const ticks = niceTicks(dom[0], dom[1], 4);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (const t of ticks) {
        const yy = y(t);
        if (yy < padT - 1 || yy > padT + innerH + 1) continue;
        ctx.strokeStyle = LINE();
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(yy) + 0.5);
        ctx.lineTo(padL + innerW, Math.round(yy) + 0.5);
        ctx.stroke();
        ctx.fillStyle = MUTED();
        ctx.fillText(fmt(t), padL - 6, yy);
      }
      const slot = innerW / items.length;
      const barW = Math.max(2, Math.min(38, slot * 0.62));
      items.forEach(function (it, i) {
        const cx = padL + slot * (i + 0.5);
        const top = y(Math.max(0, it.value));
        const h = Math.max(1, padT + innerH - top);
        ctx.fillStyle = it.color || pal[i % pal.length];
        roundRect(ctx, cx - barW / 2, top, barW, h, 3);
        ctx.fill();
        ctx.fillStyle = MUTED();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(clip(String(it.label), Math.max(4, Math.floor(slot / 7))), cx, padT + innerH + 5);
      });
    }

    mount(canvas, draw);
    bindHover(canvas, function (ev) {
      const rect = canvas.getBoundingClientRect();
      const padL = 46, padR = 12;
      const innerW = Math.max(1, rect.width - padL - padR);
      const slot = innerW / Math.max(items.length, 1);
      const i = Math.floor((ev.clientX - rect.left - padL) / slot);
      const it = items[i];
      if (!it) return;
      tipShow("<b>" + escHtml(String(it.label)) + "</b><div class=\"ct-row\"><b>" +
        escHtml(fmt(it.value)) + "</b></div>" + (it.sub ? '<div class="ct-sub">' + escHtml(it.sub) + "</div>" : ""),
        ev.clientX, ev.clientY);
    }, tipHide);
  }

  /* --------------------------- stacked bars --------------------------- */
  /**
   * Stacked columns — the right shape for *composition* over time (e.g. token
   * usage split into input/output/reasoning per turn).
   *
   * Why not a line chart: with input ~20x output, line series collapse onto the
   * same pixels (measured: 3px apart in a 200px canvas) leaving most of the
   * plot empty. Stacking shows both the total (bar height) and the split.
   *
   * cfg: { items: [{ label, values: number[], sub? }], series: [{name,color}],
   *        format?, height?, maxBars? }
   */
  function stackedBars(canvas, cfg) {
    const c = cfg || {};
    const series = c.series || [];
    let items = (c.items || []).filter(Boolean);
    const fmt = c.format || fmtCompact;
    const pal = palette();
    const truncated = items.length > (c.maxBars || 24);
    if (truncated) items = items.slice(-(c.maxBars || 24));

    function draw() {
      if (!items.length) { sizedClear(canvas, c.height); return; }
      const g = fit(canvas, c.height);
      const ctx = g.ctx, W = g.w, H = g.h;
      const padL = 46, padR = 12, padT = 12, padB = 26;
      const innerW = Math.max(1, W - padL - padR);
      const innerH = Math.max(1, H - padT - padB);

      const st = stackTotals(items, series.length);
      // Zero-based: bars must start at 0 or their length lies about the value.
      const dom = zeroBasedDomain(st.maxStack);
      const y = scaleLinear(dom, [padT + innerH, padT]);

      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      for (const t of niceTicks(dom[0], dom[1], 5)) {
        const yy = y(t);
        if (yy < padT - 1 || yy > padT + innerH + 1) continue;
        ctx.strokeStyle = LINE();
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padL, Math.round(yy) + 0.5);
        ctx.lineTo(padL + innerW, Math.round(yy) + 0.5);
        ctx.stroke();
        ctx.fillStyle = MUTED();
        ctx.fillText(fmt(t), padL - 6, yy);
      }

      const slot = innerW / items.length;
      const barW = Math.max(3, Math.min(34, slot * 0.66));
      items.forEach(function (it, i) {
        const cx = padL + slot * (i + 0.5);
        let acc = 0;
        const vals = (it.values || []).slice(0, series.length);
        for (let si = 0; si < vals.length; si++) {
          const v = Number(vals[si]) || 0;
          if (v <= 0) continue;
          const yTop = y(acc + v);
          const yBot = y(acc);
          const h = Math.max(1, yBot - yTop);
          ctx.fillStyle = (series[si] && series[si].color) || pal[si % pal.length];
          roundRect(ctx, cx - barW / 2, yTop, barW, h, Math.min(3, barW / 3));
          ctx.fill();
          acc += v;
        }
        ctx.fillStyle = MUTED();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(clip(String(it.label), Math.max(3, Math.floor(slot / 7))), cx, padT + innerH + 5);
      });

      // Show that older turns were dropped, so the chart never lies silently.
      if (truncated) {
        ctx.fillStyle = MUTED();
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText("…earlier turns hidden", padL + 2, padT + 1);
      }
    }

    mount(canvas, draw);
    bindHover(canvas, function (ev) {
      const rect = canvas.getBoundingClientRect();
      const padL = 46;
      const innerW = Math.max(1, rect.width - padL - 12);
      const slot = innerW / Math.max(items.length, 1);
      const i = Math.floor((ev.clientX - rect.left - padL) / slot);
      const it = items[i];
      if (!it) return;
      const vals = (it.values || []).slice(0, series.length);
      let sum = 0;
      const rows = vals.map(function (v, si) {
        const n = Number(v) || 0;
        sum += n;
        const col = (series[si] && series[si].color) || pal[si % pal.length];
        const pct = st.totals[i] ? ((n / st.totals[i]) * 100).toFixed(0) : "0";
        return '<div class="ct-row"><i style="background:' + col + '"></i>' +
          escHtml((series[si] && series[si].name) || ("s" + (si + 1))) +
          "<b>" + escHtml(fmt(n)) + '</b><span class="dim">' + pct + "%</span></div>";
      }).join("");
      tipShow("<b>" + escHtml(String(it.label)) + "</b>" + rows +
        '<div class="ct-row ct-sub">total<b>' + escHtml(fmt(sum)) + "</b></div>" +
        (it.sub ? '<div class="ct-sub">' + escHtml(it.sub) + "</div>" : ""), ev.clientX, ev.clientY);
    }, tipHide);
  }

  /* ------------------------------ donut ------------------------------ */
  /**
   * Donut chart. cfg:
   *   slices: { label, value, color }[]   center?: { value, label }
   *   format?: (v)=>string   height?: number   thickness?: number
   */
  function donut(canvas, cfg) {
    const c = cfg || {};
    const pal = palette();
    const fmt = c.format || fmtCompact;
    const input = (c.slices || []).filter(function (s) { return s && isFinite(s.value); });

    function draw() {
      const g = fit(canvas, c.height);
      const ctx = g.ctx, W = g.w, H = g.h;
      const size = Math.min(W, H);
      const cx = W / 2, cy = H / 2;
      const outer = Math.max(8, size / 2 - 6);
      const thick = Math.max(6, c.thickness || Math.max(12, outer * 0.34));
      const inner = Math.max(2, outer - thick);
      const slices = donutSlices(input.map(function (s) { return s.value; }), {
        colors: pal,
        slices: input,
      });

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      if (!slices.length || !input.some(function (s) { return s.value > 0; })) {
        ctx.strokeStyle = LINE();
        ctx.lineWidth = thick;
        ctx.beginPath();
        ctx.arc(cx, cy, (outer + inner) / 2, 0, Math.PI * 2);
        ctx.stroke();
        if (c.center) {
          ctx.fillStyle = INK();
          ctx.font = "600 15px ui-monospace, monospace";
          ctx.fillText(String(c.center.value), cx, cy - 6);
          ctx.fillStyle = MUTED();
          ctx.font = "10px ui-monospace, monospace";
          ctx.fillText(String(c.center.label), cx, cy + 10);
        }
        return;
      }

      let hovered = -1;
      slices.forEach(function (s, i) {
        if (!(s.frac > 0)) return;
        const mid = (s.startAngle + s.endAngle) / 2;
        const isHov = hovered === i;
        const ro = isHov ? outer + 3 : outer;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = thick;
        ctx.beginPath();
        ctx.arc(cx, cy, (ro + inner) / 2, s.startAngle, s.endAngle);
        ctx.stroke();
        void mid;
      });

      // legend beside/below: keep the centre for the headline number
      if (c.center) {
        ctx.fillStyle = INK();
        ctx.font = "600 16px ui-monospace, monospace";
        ctx.fillText(String(c.center.value), cx, cy - 7);
        ctx.fillStyle = MUTED();
        ctx.font = "10px ui-monospace, monospace";
        ctx.fillText(String(c.center.label), cx, cy + 10);
      }
      void fmt;
      bindLegend();
      function bindLegend() {
        const st = STATE.get(canvas) || {};
        st.slices = slices;
        st.geom = { cx: cx, cy: cy, inner: inner, outer: outer };
        STATE.set(canvas, st);
      }
    }

    mount(canvas, draw);
    bindHover(canvas, function (ev) {
      const st = STATE.get(canvas);
      if (!st || !st.slices || !st.geom) return;
      const rect = canvas.getBoundingClientRect();
      const dx = ev.clientX - rect.left - st.geom.cx;
      const dy = ev.clientY - rect.top - st.geom.cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < st.geom.inner || d > st.geom.outer + 4) { tipHide(); return; }
      let ang = Math.atan2(dy, dx);
      if (ang < -Math.PI / 2) ang += Math.PI * 2;
      const hit = st.slices.find(function (s) { return s.frac > 0 && ang >= s.startAngle && ang < s.endAngle; });
      if (!hit) { tipHide(); return; }
      const pct = (hit.frac * 100).toFixed(1);
      tipShow("<b>" + escHtml(String(hit.label)) + "</b><div class=\"ct-row\"><i style=\"background:" +
        hit.color + "\"></i><b>" + escHtml(fmt(hit.value)) + "</b><span class=\"dim\">" + pct + "%</span></div>",
        ev.clientX, ev.clientY);
    }, tipHide);
  }

  /* ---------------------------- sparkline ---------------------------- */
  /** Tiny trend line for KPI tiles; no axes. cfg: { color?, area?, height? } */
  function sparkline(canvas, data, cfg) {
    const c = cfg || {};
    const nums = (data || []).map(Number).filter(function (v) { return isFinite(v); });
    mount(canvas, function () {
      const g = fit(canvas, c.height || Number(canvas.getAttribute("height")) || 26);
      const ctx = g.ctx, W = g.w, H = g.h;
      if (nums.length < 2) return;
      const color = c.color || palette()[0];
      const dom = niceDomain(Math.min.apply(null, nums), Math.max.apply(null, nums), {});
      const y = scaleLinear(dom, [H - 2, 2]);
      const x = scaleLinear([0, nums.length - 1], [1, W - 1]);
      ctx.beginPath();
      nums.forEach(function (v, i) {
        const px = x(i), py = y(v);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      if (c.area !== false) {
        const last = nums.length - 1;
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, hexA(color, 0.3));
        grad.addColorStop(1, hexA(color, 0));
        ctx.save();
        ctx.lineTo(x(last), H);
        ctx.lineTo(x(0), H);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();
        // path was consumed by fill; rebuild for the stroke
        ctx.beginPath();
        nums.forEach(function (v, i) {
          const px = x(i), py = y(v);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    });
  }

  /* ---------------------------- stage map ---------------------------- */
  /**
   * Draw a stage snapshot: the map bounds, the built route and its markers.
   *
   * This is a DIAGRAM rendered from world data, not a game screenshot - OpenTTD's
   * dedicated server has no framebuffer (`screenshot` returns "Screenshot failed!").
   * See docs/AGENT-LOOP-AND-CONTROL.md §4.
   */
  function stageMap(canvas, view) {
    const v = view || {};
    mount(canvas, function () {
      const g = fit(canvas, Number(canvas.getAttribute("height")) || 140);
      const ctx = g.ctx, W = g.w, H = g.h;
      const pad = 6;
      const side = Math.min(W, H) - pad * 2;
      const ox = (W - side) / 2, oy = (H - side) / 2;
      const px = function (nx) { return ox + Math.max(0, Math.min(1, nx)) * side; };
      const py = function (ny) { return oy + Math.max(0, Math.min(1, ny)) * side; };

      // map bounds
      ctx.fillStyle = SUNKEN();
      ctx.fillRect(ox, oy, side, side);
      ctx.strokeStyle = LINE();
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(ox) + 0.5, Math.round(oy) + 0.5, side, side);

      // route(s)
      for (const r of v.routes || []) {
        ctx.strokeStyle = cssVar("--accent", "#ffb347");
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        ctx.moveTo(px(r.from.x), py(r.from.y));
        ctx.lineTo(px(r.to.x), py(r.to.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // markers (town size is proportional to population)
      for (const m of v.markers || []) {
        const cx = px(m.x), cy = py(m.y);
        const rad = m.kind === "town" ? 4 + (Number(m.size) || 0) * 5 : 3.5;
        ctx.fillStyle = m.kind === "town"
          ? cssVar("--c6", "#e5c07b")
          : m.kind === "depot" ? cssVar("--c2", "#5fb3ff") : cssVar("--c3", "#7bc96f");
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = hexA("#000000", 0.45);
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      if (!(v.markers || []).length) {
        ctx.fillStyle = MUTED();
        ctx.font = "11px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("no construction yet", ox + side / 2, oy + side / 2);
      }
    });
  }

  /* ------------------------------ helpers ------------------------------ */
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function clip(s, n) {
    const str = String(s === undefined || s === null ? "" : s);
    return str.length > n ? str.slice(0, Math.max(1, n - 1)) + "…" : str;
  }

  function escHtml(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /** #rrggbb -> rgba() with alpha; tolerates non-hex input by returning it. */
  function hexA(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    const num = parseInt(m[1], 16);
    return "rgba(" + ((num >> 16) & 255) + "," + ((num >> 8) & 255) + "," + (num & 255) + "," + a + ")";
  }

  /** Release a canvas: observer, listeners bookkeeping and cached state. */
  function destroy(canvas) {
    const st = STATE.get(canvas);
    if (st && st.obs && typeof st.obs.disconnect === "function") st.obs.disconnect();
    STATE.delete(canvas);
    tipHide();
  }

  window.Charts = {
    line: line,
    bars: bars,
    stackedBars: stackedBars,
    stageMap: stageMap,
    donut: donut,
    sparkline: sparkline,
    destroy: destroy,
    util: {
      stackTotals: stackTotals,
      zeroBasedDomain: zeroBasedDomain,
      niceTicks: niceTicks,
      niceDomain: niceDomain,
      donutSlices: donutSlices,
      fmtCompact: fmtCompact,
      scaleLinear: scaleLinear,
      niceNum: niceNum,
      fractionsOf: fractionsOf,
    },
  };
})();
