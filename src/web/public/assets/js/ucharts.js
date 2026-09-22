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
  /**
   * uPlot 的图例占的那一行（像素）。
   *
   * 为什么是**常量预留**而不是“让它自己撑”：legend 是图表宿主内部的 `<table>`，
   * 高度随内容变化（系列多/容器窄时会换行）→ 宿主高度变 → 文档高度变 →
   * 滚动条出现/消失 → 宿主宽度变 → 图例再换行……**闭环**。
   * 预留固定高度后，宿主高度与图例内容无关。
   *
   * ⚠️ 这个常量曾经被“写了但没真的插进去”（一次没断言的批量替换），于是每次 mount 抛
   * `ReferenceError: LEGEND_RESERVE_PX is not defined` —— 真机 74 次报错，
   * 图表表现为“闪烁 → 载入失败 → 成功但很长”反复循环。
   * 教训：**批量替换后必须断言锚点存在**，否则“没报错”只是“没改动”。
   */
  const LEGEND_RESERVE_PX = 34;
  /** Live uPlot instances, keyed by the mount element. */
  const instances = new WeakMap();
  /** One observer for every chart: re-fits width when the layout changes. */
  let ro = null;

  function ensureResizeObserver() {
    if (ro || typeof ResizeObserver !== "function") return ro;
    ro = new ResizeObserver(function (entries) {
      for (const entry of entries) {
        const el = entry.target;
        const inst = instances.get(el);
        if (!inst) continue;
        const w = Math.round(entry.contentRect.width);
        // Guard against 0 (hidden panel): uPlot would draw nothing and never recover.
        if (w > 20 && w !== inst.__lastWidth) {
          inst.__lastWidth = w;
          try {
            inst.setSize({ width: w, height: inst.height });
          } catch {
            /* chart already gone */
          }
        }
      }
    });
    return ro;
  }

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
    return { kind: "line", data: rows, opts: lineOpts(c, series, labels) };
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
          // 相邻重复的标签留空白：服务端每几秒推一个点，而游戏日期只按**月**变，
          // 于是同一根月标签会连着出现两三次（真机截图：`1950-07, 1950-07, 1950-08, …`）。
          // 重复的刻度不提供任何信息，只是噪声。
          values: (_u, vals) => {
            let prev = null;
            return vals.map((v) => {
              const s = labels[v] === undefined ? "" : String(labels[v]);
              if (s === prev) return "";
              prev = s;
              return s;
            });
          },
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
    return { kind: "stackedBars", data: rows, opts: stackedOpts(c, series, items) };
  }

  /**
   * Lower bound (in scale units) of segment `si` at data index `i`.
   *
   * 为什么需要它 —— uPlot 的 `paths.bars` **永远从零基线画**。把数据累积起来并不够:
   * 后画的系列会整块盖住先画的,最后只剩**一个颜色**可见。
   * 实测(600x220,3 系列):正常顺序只有最后一个系列有像素
   *   { Input: 0, Output: 0, Reasoning: 6272 }
   * 把系列**反过来**也没用,只是换成另一个系列全遮 —— 遮挡顺序变了,叠加没有发生。
   *
   * 正解是 uPlot 官方的 `disp.y0` facet:让每根柱子从"前面所有系列之和"画起,
   * 于是每段露出的是它自己的高度。本函数就是那个下界。
   */
  function stackedLowerBound(items, si, i) {
    const vals = (items && items[i] && items[i].values) || [];
    let lower = 0;
    for (let k = 0; k < si; k++) {
      const v = Number(vals[k]);
      if (Number.isFinite(v)) lower += v;
    }
    return lower;
  }

  /** Lower bounds for indices [i0, i1] inclusive — the shape uPlot facets expect. */
  function stackedLowerBounds(items, si, i0, i1) {
    const out = [];
    for (let i = i0; i <= i1; i++) out.push(stackedLowerBound(items, si, i));
    return out;
  }

  /** Upper bound of segment `si` at index `i` — its own value added to the lower one. */
  function stackedUpperBound(items, si, i) {
    const v = Number(((items && items[i] && items[i].values) || [])[si]);
    return stackedLowerBound(items, si, i) + (Number.isFinite(v) ? v : 0);
  }

  /** Upper bounds for indices [i0, i1] inclusive. */
  function stackedUpperBounds(items, si, i0, i1) {
    const out = [];
    for (let i = i0; i <= i1; i++) out.push(stackedUpperBound(items, si, i));
    return out;
  }

  /**
   * Cumulative rows for a STACKED AREA: each series' value is the running total of
   * itself and everything below it, so the top of the last series is the column total.
   * Same shape as the bars, but the opts use `bands` rather than bar paths.
   */
  function toStackedAreaData(cfg) {
    const c = cfg || {};
    const series = c.series || [];
    let items = (c.items || []).filter(Boolean);
    const maxBars = c.maxBars || 24;
    if (items.length > maxBars) items = items.slice(-maxBars);

    const x = [];
    for (let i = 0; i < items.length; i++) x.push(i);

    // Cumulative from the bottom up: cum[k][i] = sum of values 0..k at column i.
    const cum = [];
    const running = new Array(items.length).fill(0);
    for (let si = 0; si < series.length; si++) {
      const row = [];
      for (let i = 0; i < items.length; i++) {
        const vals = items[i].values || [];
        const v = Number(vals[si]);
        running[i] += Number.isFinite(v) ? v : 0;
        row.push(running[i]);
      }
      cum.push(row);
    }

    // Draw LARGEST first, each filled opaquely down to the axis. The next (smaller)
    // area paints over the lower part, so what remains visible of each series is
    // exactly its own band - a stacked area with no transparency blending.
    //
    // uPlot's `bands` API was tried first and does not work here: `series` must be a
    // [from, to] tuple (a bare number is silently ignored), and even with the correct
    // tuple shape the fills did not appear. Verified by pixel scan, not by reading
    // the config: only the first series' `fill` ever produced pixels.
    const rows = [x];
    const seriesOpts = [{ label: "x" }];
    for (let si = series.length - 1; si >= 0; si--) {
      rows.push(cum[si]);
      const colour = series[si].color || "#5fb3ff";
      seriesOpts.push({
        label: series[si].name || `s${si + 1}`,
        stroke: colour,
        width: 1.2,
        fill: colour,
        points: { show: false },
      });
    }
    return { kind: "stackedArea", data: rows, opts: stackedAreaOpts(c, seriesOpts, items) };
  }

  function stackedAreaOpts(c, seriesOpts, items) {
    const t = theme();
    const axis = axisStyle(t);
    const fmt = fmtOf(c.format);
    return {
      height: c.height || 220,
      padding: [10, 10, 0, 0],
      cursor: { show: true, points: { show: false } },
      legend: { show: true, live: true },
      scales: { x: { time: false } },
      axes: [
        {
          ...axis,
          values: (_u, vals) => vals.map((v) => (items[v] && items[v].label !== undefined ? String(items[v].label) : "")),
        },
        { ...axis, size: 52, values: (_u, vals) => vals.map((v) => fmt(v)) },
      ],
      series: seriesOpts,
    };
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
              ? window.uPlot.paths.bars({
                  size: bar,
                  // Each bar starts where the previous series ended, so the stack
                  // shows every segment instead of only the topmost colour.
                  // BOTH y0 and y1 are required. uPlot 1.6.32's bars builder does
                  // `let {y0, y1} = disp; if (y0 != null && y1 != null) {...}` and
                  // otherwise IGNORES the facet silently - supplying y0 alone
                  // changes nothing at all (measured: still one visible colour).
                  disp: {
                    y0: {
                      // BarsPathBuilderFacetUnit.ScaleValue
                      unit: 1,
                      values: (u, sidx, i0, i1) => stackedLowerBounds(items, sidx - 1, i0, i1),
                    },
                    y1: {
                      unit: 1,
                      values: (u, sidx, i0, i1) => stackedUpperBounds(items, sidx - 1, i0, i1),
                    },
                  },
                })
              : undefined,
            points: { show: false },
          };
        }),
      ],
    };
  }

  /* ------------------------- lifecycle ------------------------- */

  /**
   * True when the host cannot display injected DOM.
   *
   * uPlot builds its chart out of `<div>`/`<canvas>` children, so mounting it on
   * a `<canvas>` puts that DOM into the canvas's *fallback* content - the browser
   * never paints it, the box also gets stretched by the canvas's intrinsic
   * 300:260 ratio, and the user sees an empty box with no error anywhere.
   * That is exactly what shipped in Phase 2, so it is checked, not assumed.
   * See docs/DASHBOARD-UI.md §4.
   */
  function hostCannotRenderChildren(el) {
    const tag = el && el.tagName ? String(el.tagName).toUpperCase() : "";
    // <canvas>/<img>/<input> are replaced elements: children are never rendered.
    return tag === "CANVAS" || tag === "IMG" || tag === "INPUT" || tag === "SVG";
  }

  /**
   * 图表的"形状签名"——只有它变了才需要重建实例。
   *
   * 为什么需要（2026-09-22 用户实测：页面自己在滚、图表高度忽长忽短）：
   * 调用侧是 `x-effect="drawCash()"`，**每次遥测帧**都会重跑，而每一跑都
   * `destroy` + `new uPlot`。真机量到 40 秒内 **58 个 uPlot DOM 节点**、
   * **30 万次 DOM 变更**（≈7500 次/秒）——图表每帧被拆掉重建，
   * 宿主盒子随之塔陷再撑开，页面高度持续抖动，
   * **浏览器的滚动锚定（scroll anchoring）就把用户的滚动位置扯来扯去**。
   *
   * 数据变了只需 `setData`（uPlot 的正常用法），形状变了才重建。
   */
  function shapeSignature(kind, opts) {
    const o = opts || {};
    // **结构性**字段：系列数量、高度、堆叠/填充、以及调用方给的 `key`
    //（"这张图画的是什么"——例如 cashMetric / tokenMetric）。
    //
    // 刻意**不含系列显示名**：真机实测里 series 的 name 是**公司名**，而执行器把相位
    // 写进公司名（`EX rd s4 r27 d24 p0 j101`），于是"名字"每帧都在变，
    // 签名每帧都不同 → 图表每帧重建（40 秒 23 个实例、34 万次 DOM 变更）。
    // 显示名是数据（可以随帧变），不是形状（形状变了才需要重建）。
    //
    // `key` 取代了 `typeof format === "function" ? "fn"` 那个写法：
    // 切换指标时 format 都是函数，靠类型判断根本分不出来（会把 cost 画成 money）。
    return JSON.stringify([
      kind,
      o.height || 0,
      o.maxBars || 0,
      (o.series || []).length,
      String(o.key === undefined ? "" : o.key),
      o.area ? 1 : 0,
    ]);
  }

  /** 数据签名：数据没变就不重画（遥测帧远比数据变化频繁）。 */
  function dataSignature(data) {
    try {
      const d = data || [];
      let acc = "";
      for (const col of d) {
        if (!col || !col.length) {
          acc += "e;";
          continue;
        }
        acc += col.length + ":" + String(col[col.length - 1]) + ";";
      }
      return acc;
    } catch {
      return String(Math.random()); // 形状意外时宁可重画，不静默不画
    }
  }

  /** Mount `build()`'s uPlot instance, destroying whatever was there before. */
  function mount(el, build) {
    if (!el || !uplotAvailable()) return null;
    if (hostCannotRenderChildren(el)) {
      // Loud, because the failure mode is otherwise completely silent.
      if (typeof console !== "undefined" && console.error) {
        console.error(
          "[ucharts] chart host must be a <div>, not <" +
            String(el.tagName).toLowerCase() +
            ">: injected DOM would never be rendered. Fix the page markup.",
        );
      }
      return null;
    }
    // 先构一次：复用与重建两条路都它。
    let built;
    try {
      built = build();
    } catch (e) {
      if (typeof console !== "undefined" && console.warn) console.warn("chart build failed:", e);
      return null;
    }
    // **复用路径**：形状没变就不重建，只 `setData`（数据也没变则完全不动）。
    //
    // `shapeSignature` 是**纯函数**（只读几个原始字段），不会抛——所以这里不需要
    // try/catch 包着它（曾经包过，而空 catch 块又瞒下了真正的错误）。
    // 表面越小越不容易坏：这是本文件被反复修的原因之一。
    const prev = instances.get(el);
    if (prev) {
      const sig = shapeSignature(built.kind || "line", built.opts);
      if (prev.__shape === sig) {
        const data = dataSignature(built.data);
        if (prev.__data !== data) {
          prev.__data = data;
          prev.setData(built.data);
        }
        prev.__lastWidth = el.clientWidth || prev.__lastWidth;
        return prev;
      }
    }
    destroy(el); // 形状变了 → 重建（而不是每帧重建）
    try {
      // **必须在构造时就给宽度**（2026-09-22 用户实测"闪烁/载入失败/成功但很长"的真因）：
      // uPlot 的样式是 `.uplot { width: min-content }`，`opts.width = 0` 时它按最小内容宽
      // 布局 —— 于是**图例被挤成一列**，宿主先从 120px 暴涨到 622px，等 `setSize` 之后
      // 才收回 271px。用户看到的就是"闪一下 → 很长 → 变回来"，而且每次重建都来一遍。
      const mountW =
        Math.max(el.clientWidth || 0, (el.parentElement && el.parentElement.clientWidth) || 0) || 600;
      const mountOpts = Object.assign({}, built.opts, {
        width: mountW,
        height: built.opts.height,
      });
      const instance = new window.uPlot(mountOpts, built.data, el);
      // 形状/数据签名存下来，供下一次复用判断
      try {
        instance.__shape = shapeSignature(built.kind || "line", built.opts);
        instance.__data = dataSignature(built.data);
      } catch {
        instance.__shape = null;
        instance.__data = null;
      }
      // uPlot cannot measure a fresh element, so size it from the container.
      // Fall back to the parent (the panel) when this element is still 0-wide,
      // which happens on the first paint before layout settles.
      const w = Math.max(el.clientWidth || 0, (el.parentElement && el.parentElement.clientWidth) || 0);
      instance.__lastWidth = w;
      if (w > 0) instance.setSize({ width: w, height: built.opts.height });
      // 按调用方给的高度**预留宿主盒子**：图表被销毁/重建（形状变化）时，
      // 盒子不会先塌陷再撑开——否则页面高度抖动，而滚动锚定会把它转嫁给用户的滚动位置。
      // 这里写 min-height 而不是写死在 CSS：高度只有一个来源（调用方的 height）。
      if (built.opts && built.opts.height && el.style) {
        // 预留图例那一行（uPlot 的 legend 是 `<table>`，在宿主内部，其高度随内容变化）。
        // 固定预留后，宿主高度**与图例内容无关** → 文档高度不会因图例换行而变化
        // → 不会再出现"文档高度变 → 滚动条 → 宽度变"的闭环。
        el.style.minHeight = built.opts.height + LEGEND_RESERVE_PX + "px";
      }
      instances.set(el, instance);
      const obs = ensureResizeObserver();
      if (obs) obs.observe(el);
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
    if (ro && el) {
      try {
        ro.unobserve(el);
      } catch {
        /* not observed */
      }
    }
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
    stackedArea: (el, cfg) => mount(el, () => toStackedAreaData(cfg)),
    destroy: destroy,
    // Exposed for tests: pure translations with no DOM/uPlot involvement.
    toLineData: toLineData,
    toStackedData: toStackedData,
    stackedLowerBounds: stackedLowerBounds,
    stackedUpperBounds: stackedUpperBounds,
    toStackedAreaData: toStackedAreaData,
  };
})();
