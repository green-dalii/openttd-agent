/* uPlot adapter — line & stacked-bar charts.
 *
 * 职责: 把**本项目的图表配置**翻译成 uPlot，并负责实例生命周期。
 *   - `line(el, {series, labels, format, area, height})`
 *   - `stackedBars(el, {items, series, format, height, maxBars})`
 *   页面继续用原来的配置形状，迁移到 uPlot 不需要改页面逻辑。
 *
 * 为什么用 uPlot（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.1）:
 *   坐标轴、刻度、DPR、resize、十字光标、图例、触摸都是"任何合格开发者写得差不多"
 *   的商品代码，却是我手搓时出 bug 最多的地方。uPlot 是 MIT、**零依赖**、
 *   22 KB gzip、且发布 IIFE 构建 —— **不需要构建链**，符合本项目的硬约束。
 *
 * 为什么不把全部图表交给 uPlot: 它**不做**环形图/迷你趋势图，也不做本项目的
 *   阶段地图（`stageMap`）。那些留在 `charts.js`（领域可视化，无合适上游）。
 *
 * 禁止:
 *   - 在此直接读业务状态（配置由页面传入）。
 *   - 在 uPlot 缺席时抛异常（离线/脚本被拦时图表区域留白即可，页面不能崩）。
 *   - 让实例泄漏：live.js 每帧都会重画，重复挂载必须销毁旧实例。
 */
"use strict";
(function () {
  /** Live uPlot instances, keyed by the mount element. */
  const instances = new WeakMap();

  /**
   * Theme colours, read from CSS custom properties with safe fallbacks.
   *
   * 防御性读取是刻意的: 主题变量缺失（或页面在非常规环境下加载）时必须退回默认色，
   * 而不是让图表构造抛异常把整页带崩。也因此本函数不缓存 —— CSS 变量可能被改。
   */
  function theme() {
    const fallback = {
      line: "#262a33",
      muted: "#9aa4b2",
      palette: ["#5ac8fa", "#34c759", "#ff9f0a", "#ff375f", "#bf5af2", "#64d2ff"],
    };
    let vars = null;
    try {
      vars = getComputedStyle(document.documentElement);
    } catch {
      return fallback;
    }
    if (!vars) return fallback;
    const read = (name, dflt) => {
      let v = "";
      try {
        v = (vars.getPropertyValue(name) || "").trim();
      } catch {
        v = "";
      }
      return v || dflt;
    };
    const raw = read("--chart-palette", "");
    const palette = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : fallback.palette;
    return {
      line: read("--line", fallback.line),
      muted: read("--muted", fallback.muted),
      palette: palette.length ? palette : fallback.palette,
    };
  }

  /** Shared axis look, matching the dashboard's dark theme. */
  function axisStyle(t) {
    return { stroke: t.muted, grid: { stroke: t.line }, ticks: { stroke: t.line } };
  }

  function uplotAvailable() {
    return typeof window.uPlot === "function";
  }

  /** Wrap a caller formatter so a missing one never breaks the axis. */
  function fmtOf(fn, fallback) {
    return typeof fn === "function"
      ? fn
      : typeof fallback === "function"
        ? fallback
        : (v) => String(v);
  }

  /* --------------------------- line charts --------------------------- */

  /**
   * Translate `{series, labels, format}` into uPlot's `[x, ...ys]` column form.
   * Pure: no DOM, no uPlot - unit-tested directly.
   */
  function toLineData(cfg) {
    const c = cfg || {};
    const series = c.series || [];
    const labels = c.labels || [];
    // The x axis is the sample index; the label lookup happens in the axis
    // formatter, so the data stays numeric (uPlot's scales expect numbers).
    const n = Math.max(labels.length, ...series.map((s) => (s.data || []).length), 0);
    const x = [];
    for (let i = 0; i < n; i++) x.push(i);
    const rows = [x];
    for (const s of series) {
      const data = s.data || [];
      const row = [];
      for (let i = 0; i < n; i++) {
        const v = Number(data[i]);
        row.push(Number.isFinite(v) ? v : null);
      }
      rows.push(row);
    }
    return { data: rows, opts: lineOpts(c, series, labels) };
  }

  function lineOpts(c, series, labels) {
    const t = theme();
    const axis = axisStyle(t);
    const fmt = fmtOf(c.format);
    const colours = t.palette;
    const showArea = c.area === true && series.length === 1;
    return {
      width: 0, // filled in by the caller-visible element width
      height: c.height || 220,
      padding: [10, 10, 0, 0],
      cursor: { show: true, points: { show: false } },
      // uPlot's legend IS the readout: it lists each series and its value at the
      // cursor. Enabling it replaces both the custom tooltip this project used to
      // hand-write and the page's separate colour key.
      legend: { show: true, live: true },
      scales: { x: { time: false } },
      axes: [
        {
          ...axis,
          // x ticks read as the caller's labels (game dates), not indices.
          values: (_u, vals) => vals.map((v) => labels[v] === undefined ? "" : String(labels[v])),
        },
        { ...axis, size: 52, values: (_u, vals) => vals.map((v) => fmt(v)) },
      ],
      series: [
        { label: "x" },
        ...series.map((s, i) => ({
          label: s.name || `s${i + 1}`,
          stroke: s.color || colours[i % colours.length],
          width: 2,
          points: { show: false },
          ...(showArea
            ? { fill: hexA(s.color || colours[i % colours.length], 0.12) }
            : {}),
        })),
      ],
    };
  }

  /* ------------------------- stacked bars ------------------------- */

  /**
   * Translate `{items, series, maxBars}` into cumulated columns.
   *
   * uPlot has no stacked-column path: `paths.bars` draws each series from zero,
   * so series would overlap. Stacking is therefore done by **cumulating** each
   * series' values - bar N of series K starts where series K-1 ended. Pure and
   * unit-tested (including the NaN and truncation cases).
   */
  function toStackedData(cfg) {
    const c = cfg || {};
    const series = c.series || [];
    let items = (c.items || []).filter(Boolean);
    const maxBars = c.maxBars || 24;
    if (items.length > maxBars) items = items.slice(-maxBars); // keep the newest

    const x = [];
    for (let i = 0; i < items.length; i++) x.push(i);

    const rows = [x];
    const running = new Array(items.length).fill(0);
    for (let si = 0; si < series.length; si++) {
      const row = [];
      for (let i = 0; i < items.length; i++) {
        const vals = items[i].values || [];
        const v = Number(vals[si]);
        running[i] += Number.isFinite(v) ? v : 0;
        row.push(running[i]);
      }
      rows.push(row);
    }
    return { data: rows, opts: stackedOpts(c, series, items) };
  }

  function stackedOpts(c, series, items) {
    const t = theme();
    const axis = axisStyle(t);
    const fmt = fmtOf(c.format);
    const colours = t.palette;
    // Bar width: 0.7 of the slot, capped at 30px so a single turn is not a slab.
    const bar = [0.7, 30];
    return {
      height: c.height || 220,
      padding: [10, 10, 0, 0],
      cursor: { show: true, points: { show: false } },
      legend: { show: true, live: true }, // cursor readout; see lineOpts()
      scales: { x: { time: false } },
      axes: [
        {
          ...axis,
          values: (_u, vals) => vals.map((v) => (items[v] && items[v].label !== undefined ? String(items[v].label) : "")),
        },
        { ...axis, size: 52, values: (_u, vals) => vals.map((v) => fmt(v)) },
      ],
      series: [
        { label: "x" },
        ...series.map((s, i) => {
          const colour = s.color || colours[i % colours.length];
          return {
            label: s.name || `s${i + 1}`,
            stroke: colour,
            fill: colour,
            paths: window.uPlot && window.uPlot.paths && window.uPlot.paths.bars
              ? window.uPlot.paths.bars({ size: bar })
              : undefined,
            points: { show: false },
          };
        }),
      ],
    };
  }

  /* ------------------------- lifecycle ------------------------- */

  /** Mount `build()`'s uPlot instance, destroying whatever was there before. */
  function mount(el, build) {
    if (!el || !uplotAvailable()) return null;
    destroy(el); // live pages re-render per frame; never leak instances
    try {
      const built = build();
      const instance = new window.uPlot(built.opts, built.data, el);
      // Give uPlot the real CSS width; it cannot measure a fresh element itself.
      if (el.clientWidth) instance.setSize({ width: el.clientWidth, height: built.opts.height });
      instances.set(el, instance);
      return instance;
    } catch (e) {
      // A chart must never take the page down with it.
      if (typeof console !== "undefined" && console.warn) console.warn("chart render failed:", e);
      return null;
    }
  }

  function destroy(el) {
    const prev = el && instances.get(el);
    if (!prev) return;
    try {
      prev.destroy();
    } catch {
      /* already gone */
    }
    instances.delete(el);
    // uPlot leaves its canvas behind; clear so a redraw cannot stack them.
    if (el && el.replaceChildren) el.replaceChildren();
  }

  /** `#rrggbb` -> `rgba(...)`, for translucent area fills. */
  function hexA(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  window.UCharts = {
    available: uplotAvailable,
    line: (el, cfg) => mount(el, () => toLineData(cfg)),
    stackedBars: (el, cfg) => mount(el, () => toStackedData(cfg)),
    destroy: destroy,
    // Exposed for tests: pure translations with no DOM/uPlot involvement.
    toLineData: toLineData,
    toStackedData: toStackedData,
  };
})();
