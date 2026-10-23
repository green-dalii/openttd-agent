/* uPlot adapter — line & stacked-bar charts.
 *
 * 职责: 把**本项目的图表配置**翻译成 uPlot，并负责实例生命周期。
 *   - `line(el, {series, labels, format, area, height})`
 *   - `stackedBars(el, {items, series, format, height, maxBars})`
 *   页面继续用原来的配置形状，迁移到 uPlot 不需要改页面逻辑。
 *
 * 为什么用 uPlot（docs/FRONTEND.md §3.1）:
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
  /** 复位按钮（按宿主记录）：未缩放时置灰，有意义的禁用胜过点了没反应。 */
  const ctrlReset = new Map();
  /**
   * 每张图的区间读数配置（单位 + 取哪个标签）。
   *
   * 为什么由调用方给：现金图的 x 是**采样序号**、标签是游戏日期；用量图的 x 是
   * **轮次**。图自己知道"数据是什么"，但只有页面知道"这串数字该怎么念"（日期 vs 轮次），
   * 所以单位/标签由页面传进来，图只负责把当前视野念出来。
   */
  const chartCfg = new Map();
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
  /**
   * 量一段文本在图表字体下的像素宽度（**测量，不猜**）。
   *
   * 为什么需要（2026-09-22 真机截图）：Y 轴宽度写死 52px，而格式化后的标签是
   * `£300.00k`（≈65px）→ **标签被裁成 `00000`**：既读不出数值，又让人以为比例错乱。
   * 轴宽必须由**实际标签文本**决定，而不是一个魔数。
   *
   * 用离屏 canvas 的 `measureText`（不碰 DOM 布局）；拿不到 canvas 时退回按字符数估算。
   */
  let measureCtx = null;
  function textWidth(text, font) {
    const t = String(text == null ? "" : text);
    if (!t) return 0;
    try {
      if (measureCtx === null && typeof document !== "undefined" && document.createElement) {
        measureCtx = document.createElement("canvas").getContext("2d");
        if (measureCtx) measureCtx.font = font;
      }
      if (measureCtx) return measureCtx.measureText(t).width;
    } catch {
      measureCtx = null;
    }
    // 保守估算：14px 字体下平均每字符约 7.5px
    return t.length * 7.5;
  }

  /**
   * 用来量轴宽的样本标签。
   *
   * 不能只看当前数据：数值会随运行增长（`£9k` → `£300k`），轴宽必须按**可能的最宽**
   * 预留，否则图表跑一会儿又开始裁标签。用"最长可能"的样本 + 当前最大值一起量。
   */
  function sampleAxisLabels(fmt) {
    const probes = [0, 999, -999, 999999, -999999, 12345678, -12345678, 999999999];
    const out = probes.map((v) => {
      try {
        return fmt(v);
      } catch {
        return String(v);
      }
    });
    return out.filter((x) => typeof x === "string" && x.length);
  }

  /** Y 轴宽度：由标签里最宽的那个决定（加内边距与下限/上限）。 */
  function axisSizeFor(labels, font) {
    let max = 0;
    for (const l of labels || []) max = Math.max(max, textWidth(l, font));
    return Math.max(40, Math.min(120, Math.ceil(max) + 12));
  }

  /**
   * 图例/游标读数：**带单位、宽度稳定**。
   *
   * 为什么（用户："图例…看不清"）：uPlot 的 live legend 每帧重排，数值宽度随数字增长
   * 而变（`1k` → `12.5k`），整行会左右抖动。加上单位后缀后字符串形态固定，
   * 配合 CSS 的 `tabular-nums` 就不会再抖。
   */
  function legendValue(fmt) {
    return function (_u, v) {
      const n = Number(v);
      if (v === null || v === undefined || !Number.isFinite(n)) return "—";
      return fmt(n);
    };
  }

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
    const hasAny = series.some((s) => (s && s.data ? s.data.length : 0) > 0);
    if (!hasAny) return { kind: "line", empty: true, emptyText: "no history yet — points appear as the run progresses" };
    return {
      kind: "line",
      data: rows,
      opts: lineOpts(c, series, labels),
      range: { unit: c.rangeUnit || "points", label: c.rangeLabel || labels },
    };
  }

  /**
   * 指针交互：**只在 x 轴上**拖拽缩放。
   *
   * 为什么只有 x（2026-09-23 用户："图表为什么没有交互控制，比如缩放、移动"）：
   * 这里的 x 是**采样序号/游戏日期**（时间轴，可以放大看细节），而 y 是货币/计数。
   * 允许 y 缩放会让"零基线"被推离视野，读者就再也判断不出"这条线是不是从 0 开始的"——
   * 对收益曲线那是**误导**，不是交互。所以 x 可缩放、y 固定。
   *
   * `setScale: true` 是 uPlot 的按需缩放：拖动后它会自己 `setScale('x')`。
   * **缩放状态由 uPlot 持有**，我们只在"重建图表"时才会丢掉它（形状变化），
   * **注意**：`setData` 默认会重置 scales —— 用户缩放后必须显式传 `false` 才保得住视野
   *（2026-09-23 实测：不传就等于"每次数据帧把缩放擦掉"）。
   */
  /**
   * 指针交互：**x 轴**上裸拖拽 = 框选缩放，Shift+拖拽 = 平移，滚轮 = 以指针为锚缩放。
   *
   * 为什么这样分（2026-09-25 用户实测："缩放逻辑不正确"）：上一版把裸拖拽接成**平移**，
   * 而页面提示写的是 "drag to zoom" —— 提示承诺的动作不存在，未缩放时拖拽还是个静默
   * no-op。第一性原理：框一段放大是时间轴最常用的手势；平移只在**已经放大**之后才有
   * 意义，所以它是修饰键动作。同时 uPlot 的原生框选被关掉（`setSelect: false`），
   * 由我们在 pointer 层做——这样"框选 + 读数 + 复位"是同一套代码，行为可测。
   */
  function cursorOpts() {
    return {
      show: true,
      points: { show: false },
      // `setSelect: false` 关掉 uPlot 自己的框选缩放，改由下面的 pointer 层做：
      // 我们要的不只是"缩放"，还要**选区反馈**与**区间读数**（uPlot 都不给）。
      // y 轴固定为货币/计数刻度：允许 y 缩放会把零基线推出视野，读者就再也判断不出
      // "这条线是不是从 0 开始的"——对收益曲线那是误导，不是交互。
      drag: { x: true, y: false, setScale: false, setSelect: false, uni: 1 },
    };
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
      cursor: cursorOpts(),
      // uPlot's legend IS the readout: it lists each series and its value at the
      // cursor. Enabling it replaces both the custom tooltip this project used to
      // hand-write and the page's separate colour key.
      legend: { show: true, live: true },
      scales: { x: { time: false } },
      axes: [
        {
          ...axis,
          // 竖直网格线在**放大后**变成噪声（2026-09-25 真机截图：107/400 个点的视野里
          // 挤了 ~20 根线、只留下 2 个标签，读者既定位不到时间、也被线挡住曲线）。
          // 而且它们的职责已经被**区间读数**接管了：“我现在看的是哪一段”写在图下方，
          // 不需要靠一堆竖线去猜。横向网格线留着——读 y 值靠它。
          //
          // 键名是 `grid`（已对 vendored uPlot 1.6.32 核过：`grid:` 出现在轴默认值里；
          // `splits` 是**刻度概念**（`scale.splits`），写在轴上会让 uPlot 的配置合并
          // 走偏——实测症状是 x 轴 `values` 回调收到非数组，图表直接抛异常）。
          grid: { show: false },
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
        {
          ...axis,
          // 轴宽按**实际标签文本**算（原来写死 52px → `£300.00k` 被裁成 `00000`）。
          size: axisSizeFor(sampleAxisLabels(fmt), axis.font),
          values: (_u, vals) => vals.map((v) => fmt(v)),
        },
      ],
      series: [
        { label: "x" },
        ...series.map((s, i) => ({
          label: s.name || `s${i + 1}`,
          stroke: s.color || colours[i % colours.length],
          width: 2,
          points: { show: false },
          // 图例读数带单位且宽度稳定（见 legendValue）。
          value: legendValue(fmt),
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
        value: legendValue(fmtOf(c.format)),
      });
    }
    if (!items || items.length === 0) {
      return { kind: "stackedArea", empty: true, emptyText: "no turns recorded yet" };
    }
    return {
      kind: "stackedArea",
      data: rows,
      opts: stackedAreaOpts(c, seriesOpts, items),
      range: { unit: c.rangeUnit || "turns", label: c.rangeLabel || null },
    };
  }

  function stackedAreaOpts(c, seriesOpts, items) {
    const t = theme();
    const axis = axisStyle(t);
    const fmt = fmtOf(c.format);
    return {
      height: c.height || 220,
      padding: [10, 10, 0, 0],
      cursor: cursorOpts(),
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
      cursor: cursorOpts(),
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
            value: legendValue(fmt),
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
      // 轴宽也算"形状"：数值长大到需要更宽的轴时必须重建，否则标签继续被裁。
      (o.axes && o.axes[1] && o.axes[1].size) || 0,
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

  /**
   * 空状态：**说清楚"还没有数据"**，而不是留一个没有轴的空盒子。
   *
   * 为什么（2026-09-22 真机排查）：一局没跑起来时 Cash 图是**完全空白**（uPlot 没有数据
   * 就不画轴），看起来像图表坏了——我自己就先误判了一轮。空白不等于"没有数据"这个事实。
   */
  /** 移除空状态占位（`clickEmpty`/`showEmpty` 的逆操作）。 */
  function clearEmpty(el) {
    if (!el || typeof el.querySelectorAll !== "function") return;
    for (const p of el.querySelectorAll(".chart-empty")) {
      if (p && typeof p.remove === "function") p.remove();
      else if (p && p.parentNode && p.parentNode.removeChild) p.parentNode.removeChild(p);
    }
  }

  function showEmpty(el, text) {
    destroy(el);
    if (!el || typeof el.replaceChildren !== "function") return;
    const existing = el.querySelector && el.querySelector(".chart-empty");
    if (existing) {
      if (existing.textContent !== text) existing.textContent = text;
      return; // 幂等：每帧都调也不会反复重建 DOM
    }
    const p = (typeof document !== "undefined" && document.createElement
      ? document.createElement("p")
      : null);
    if (!p) return;
    p.className = "chart-empty";
    p.textContent = text;
    el.replaceChildren(p);
  }

  /* ------------------------------ zoom UI ------------------------------ */

  /**
   * 缩放有没有"退路"？
   *
   * 为什么必须自己做（2026-09-23 用户："图表为什么没有交互控制，比如缩放"）：
   * uPlot 原生拖拽缩放**没有复位手段**——框选放大之后，用户除了刷新页面回不到全量视图。
   * **一个看不见退路的交互比没有交互更糟**，所以缩放与复位必须一起给。
   */
  function isZoomed(u) {
    try {
      const xs = (u && u.data && u.data[0]) || [];
      if (xs.length < 2) return false;
      const min = u.scales && u.scales.x ? u.scales.x.min : null;
      const max = u.scales && u.scales.x ? u.scales.x.max : null;
      if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
      return min > xs[0] + 1e-9 || max < xs[xs.length - 1] - 1e-9;
    } catch {
      return false;
    }
  }

  function setZoomed(el, on) {
    const host = el && el.parentElement;
    if (host && host.classList && host.classList.toggle) host.classList.toggle("chart-zoomed", Boolean(on));
  }

  /**
   * 把 x 轴缩放一个系数（围绕某个"数据坐标"锚点，默认视野中心）。
   *
   * 为什么锚点重要：滚轮缩放若总以中心为锚，指针底下的那个点会跑掉，用户就会觉得
   * "缩放不听话"。以指针所在的数据位置为锚，才是所有主流图表的做法。
   */
  /**
   * 缩放后的视野（**纯函数**，无 DOM/uPlot）。返回 null 表示"不可缩放"。
   *
   * 锚点为什么要参数化：滚轮缩放若总以视野中心为锚，指针底下的那个点会跑掉，
   * 用户就会觉得"缩放不听话"。以指针所在的数据位置为锚才是主流做法。
   */
  function zoomRange(xs, lo, hi, factor, anchorValue) {
    if (!xs || xs.length < 2) return null;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    const span = hi - lo;
    const dataSpan = xs[xs.length - 1] - xs[0];
    const next = Math.min(Math.max(span * factor, 4), dataSpan * 4);
    const anchor = Number.isFinite(anchorValue) ? Math.min(Math.max(anchorValue, lo), hi) : (lo + hi) / 2;
    const ratio = span > 0 ? (anchor - lo) / span : 0.5;
    const min = anchor - next * ratio;
    return { min, max: min + next };
  }

  /** 平移后的视野（纯函数）：跨度不变，且不把视野拖出数据范围（否则像数据丢了）。 */
  function panRange(xs, lo, hi, dxPixels, width) {
    if (!xs || xs.length < 2) return null;
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (!Number.isFinite(width) || width <= 0) return null;
    const span = hi - lo;
    const shift = (-dxPixels / width) * span;
    const min = Math.max(xs[0], Math.min(lo + shift, xs[xs.length - 1] - span));
    return { min, max: min + span };
  }

  /**
   * 拖拽选区 → 样本区间（**纯函数**：无 DOM/uPlot，可直接单测）。
   *
   * 为什么裸拖拽是"选区缩放"而不是"平移"（2026-09-25 用户实测："折线图、Token 用量等，
   * 鼠标缩放逻辑不正确"）：页面自己的提示写着 "drag to zoom"，而实现里裸拖拽接的是
   * **平移**——未缩放时平移是个**静默 no-op**，于是用户看到的是"提示承诺的动作根本
   * 不存在"。第一性原理：时间轴上最常用的手势是"框一段放大"，平移只在放大之后才有意义，
   * 所以裸拖拽给缩放，**平移退到 Shift+拖拽**。
   *
   * 返回样本下标区间（含端点，闭区间）；`null` = 这不是一次有效的框选：
   *  - 位移太短（< minPx）当作误触，不改变视野；
   *  - 竖直位移为主（|dy| > |dx|）当作别的意图（uPlot 的 y 轴是固定的货币刻度，
   *    框选它没有意义）。
   */
  function dragToRange(x0, x1, y0, y1, opts) {
    const o = opts || {};
    const width = Number(o.width);
    if (!Number.isFinite(width) || width <= 0) return null;
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(y0) || !Number.isFinite(y1)) return null;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const minPx = Number.isFinite(o.minPx) ? o.minPx : 8;
    if (Math.abs(dx) < minPx) return null;
    if (Math.abs(dy) > Math.abs(dx)) return null;
    const total = Number.isFinite(o.total) ? o.total : 0;
    // 像素 → 数据坐标：与 uPlot 的默认线性 x 轴一致（左边界 = 0，右边界 = total-1）。
    const perPx = (total - 1) / width;
    const a = Math.min(x0, x1) * perPx;
    const b = Math.max(x0, x1) * perPx;
    // 吸附到整点，避免拖出 3.37 这种没意义的刻度；同时防止把单点框成一个
    // "看不见任何东西"的视野。
    let from = Math.round(a);
    let to = Math.round(b);
    if (to - from < 1) {
      const grow = to - from >= 0 ? 1 : -1;
      to += grow;
    }
    const lo = Math.max(0, Math.min(from, to));
    const hi = Math.min(total - 1, Math.max(from, to));
    if (!(hi > lo)) return null;
    return { from: lo, to: hi };
  }

  /**
   * 视野区间的**人话**（纯函数）。
   *
   * 用户要的不是"scales.x 变了"，而是"我现在看的是哪一段"（2026-09-25 用户原话：
   * "没有对应坐标轴范围显示缩放及区间范围"）。所以缩放后必须有一行明说区间。
   *
   * 单位要诚实：现金图/用量图的 x 是**采样序号**（标签是日期，但两点可以同一天），
   * 所以写 "points" 而不是 "days" —— 把采样点说成"天"是编造一个不存在的单位。
   */
  function formatRangeCaption(range, opts) {
    const o = opts || {};
    const from = Number(range && range.from);
    const to = Number(range && range.to);
    const total = Number(range && range.total);
    const unit = String(o.unit || "points");
    const label = typeof o.label === "function" ? o.label : null;
    const fmt = (v) => (label ? String(label(v)) : String(Math.round(v)));
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(total) || total < 2) return "";
    if (from <= 0 && to >= total - 1) {
      return "full range · " + total + " " + unit;
    }
    const span = to - from + 1;
    const pct = Math.round((span / total) * 100);
    return (
      fmt(from) + " → " + fmt(to) + " · " + span + " of " + total + " " + unit + " (" + pct + "%)"
    );
  }

  /**
   * 写区间读数 + 广播事件。
   *
   * 为什么由 `applyXRange` 统一做：它是**视野的唯一写者**（见那里的说明），
   * 读数若在别处同步，就会出现"画面缩放了、读数还是全量"这种半真半假的状态。
   * 事件（`uplot:range`）让页面其它部分与探针都能观测当前视野，而不必去摸 uPlot 内部。
   */
  function setRangeCaption(el, inst, min, max) {
    const host = el && el.parentElement;
    // 防御：宿主不能渲染子节点时**只跳过读数**，绝不让缩放本身失败。
    // `mount()` 对这种宿主会大声报错（图表直接不渲染）；而缩放是已有的交互，
    // 不能因为读数无处可写就跟着坏掉。
    if (!host || typeof host.appendChild !== "function" || typeof document === "undefined") return;
    const xs = (inst && inst.data && inst.data[0]) || [];
    if (xs.length < 2) return;
    const cfg = chartCfg.get(el) || {};
    const from = Math.max(0, Math.round(min));
    const to = Math.min(xs.length - 1, Math.round(max));
    let node = host.__chartRange;
    if (!node) {
      node = document.createElement("div");
      node.className = "chart-range";
      host.appendChild(node);
      host.__chartRange = node;
    }
    node.textContent = formatRangeCaption({ from, to, total: xs.length }, cfg);
    if (typeof host.dispatchEvent === "function" && typeof CustomEvent === "function") {
      host.dispatchEvent(new CustomEvent("uplot:range", { detail: { from, to, total: xs.length }, bubbles: true }));
    }
  }

  /**
   * 应用 x 轴视野 —— **所有缩放/平移/复位的唯一入口**。
   *
   * 为什么不能走 uPlot 的 `setScale()`（2026-09-23 实测，代价一轮调试）：
   * `setScale(key, limits)` 只把极值塞进 `pendScales` 并 `commit()` 到微任务；
   * 微任务里 `setScales()` 应用后即清空 `pendScales`，随后的重画又把 x 轴按数据回贴。
   * 真机表现是**点 `＋` 画面像素完全不变**（复位按钮却变可用，因为钩子确实接到了
   * 一次 setScale）。同一函数由滚轮路径调用能改变画面、由按钮路径调用不能，
   * 说明"能不能生效"取决于 uPlot 内部时序 —— 这种依赖必须消掉。
   *
   * 现在改为**直接写极值 + `redraw()`**：先写入的值就是 `redraw()` 内部
   * `_setScale(x, scales.x.min, scales.x.max)` 会用到的那一份，所以"写进去的
   * 视野 = 画出来的视野"。注意**不能**用 `redraw(false)`：那条路只 `commit()`，
   * 在没有 setScales 标志时是 no-op —— 状态改了、画面没变（实测像素哈希不变）。
   *
   * 同时同步派生状态（"已缩放"标记 + 复位按钮可用性），否则会出现"缩放了但
   * 按钮还是灰的"这种假按钮。
   */
  function applyXRange(el, inst, min, max) {
    const xs = inst && inst.data && inst.data[0];
    if (!inst || !inst.scales || !inst.scales.x || !xs || xs.length < 2) return false;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return false;
    const zoomed = min > xs[0] + 1e-9 || max < xs[xs.length - 1] - 1e-9;
    try {
      inst.scales.x.min = min;
      inst.scales.x.max = max;
      // `__zoomedByUser` 让数据帧知道"用户在缩放里"，从而不重置 scales
      // （`setData` 的第二个参数默认 true = 重置，会把用户视野擦掉）。
      inst.__zoomedByUser = zoomed;
      if (typeof inst.redraw === "function") inst.redraw();
    } catch (e) {
      // 不静默：空 catch 会瞒下"缩放根本没生效"这类缺陷（2026-09-23 实测遇到）。
      if (typeof console !== "undefined") console.warn("chart zoom failed:", String(e && e.message ? e.message : e));
      return false;
    }
    setZoomed(el, zoomed);
    const btn = ctrlReset.get(el);
    if (btn) btn.disabled = !zoomed;
    // 区间读数与"已缩放"标记同源：视野是唯一事实，它的两个投影也必须一起变。
    setRangeCaption(el, inst, min, max);
    return true;
  }

  /**
   * 当前视野起点：优先用已提交的极值，**取不到就退回数据边界**。
   *
   * 为什么需要回退（2026-09-23 实测）：图表刚挂载、uPlot 还没 commit 时
   * `scales.x.min/max` 仍是 null —— 此时点 `＋` 会"没有任何反应"（静默 no-op）。
   * 旧实现里有这个回退，被抽成纯函数时弄丢了一次，所以现在有测试盯着。
   */
  function viewBounds(inst, xs) {
    const sc = inst.scales && inst.scales.x ? inst.scales.x : {};
    const lo = Number.isFinite(sc.min) ? sc.min : xs[0];
    const hi = Number.isFinite(sc.max) ? sc.max : xs[xs.length - 1];
    return { lo, hi };
  }

  /** 缩放一个系数（围绕数据坐标锚点，默认视野中心）。 */
  function zoomBy(el, factor, anchorValue) {
    const inst = instances.get(el);
    if (!inst) return false;
    const xs = (inst.data && inst.data[0]) || [];
    const { lo, hi } = viewBounds(inst, xs);
    const r = zoomRange(xs, lo, hi, factor, anchorValue);
    return r ? applyXRange(el, inst, r.min, r.max) : false;
  }

  /** 拖拽平移：按像素位移换算成数据位移（不改缩放级别）。 */
  function panBy(el, dxPixels) {
    const inst = instances.get(el);
    if (!inst) return false;
    const xs = (inst.data && inst.data[0]) || [];
    const { lo, hi } = viewBounds(inst, xs);
    const width = (inst.over && inst.over.clientWidth) || 0;
    const r = panRange(xs, lo, hi, dxPixels, width);
    return r ? applyXRange(el, inst, r.min, r.max) : false;
  }

  /** 复位到全量视野（显式传数据边界，不依赖 uPlot 的 `null` 语义）。 */
  function resetZoom(el) {
    const inst = instances.get(el);
    if (!inst || !inst.data || !inst.data[0] || inst.data[0].length < 2) return false;
    const xs = inst.data[0];
    return applyXRange(el, inst, xs[0], xs[xs.length - 1]);
  }

  /**
   * 给宿主挂上复位按钮与双击复位（幂等：同一宿主持有一个按钮）。
   * 按钮放在**父元素**（`.chart-box`）里：宿主的 children 归 uPlot 管，
   * `destroy()` 会用 `replaceChildren()` 清空它。
   */
  function ensureZoomUi(el, instance) {
    const host = el && el.parentElement;
    if (!host || !host.appendChild || typeof document === "undefined" || !document.createElement) return;
    if (!host.__chartCtrl) {
      // 图标簇（＋ / − / ⟲）而不是一句英文按钮：见 style.css 里 `.chart-ctrl` 的说明。
      const bar = document.createElement("div");
      bar.className = "chart-ctrl";
      const mk = function (label, title, fn) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.addEventListener("click", fn);
        bar.appendChild(b);
        return b;
      };
      mk("＋", "Zoom in", function () {
        zoomBy(el, 0.6);
      });
      mk("−", "Zoom out", function () {
        zoomBy(el, 1.7);
      });
      const reset = mk("⟲", "Reset zoom (double-click the chart)", function () {
        resetZoom(el);
      });
      ctrlReset.set(el, reset);
      host.appendChild(bar);
      host.__chartCtrl = bar;
      host.addEventListener("dblclick", function () {
        resetZoom(el);
      });

      // 滚轮缩放（以指针所在的数据位置为锚）+ 拖拽手势。
      // uPlot 两者都不提供（issue #298），所以由我们在 pointer 层实现。
      const over = instance && instance.over;
      if (over) {
        over.addEventListener(
          "wheel",
          function (ev) {
            if (!ev.deltaY) return;
            ev.preventDefault();
            const rect = over.getBoundingClientRect();
            const frac = rect.width > 0 ? (ev.offsetX !== undefined ? ev.offsetX : ev.clientX - rect.left) / rect.width : 0.5;
            const cur = instances.get(el);
            if (!cur) return;
            const lo = cur.scales.x.min;
            const hi = cur.scales.x.max;
            const anchor = Number.isFinite(lo) && Number.isFinite(hi) ? lo + (hi - lo) * frac : undefined;
            zoomBy(el, ev.deltaY > 0 ? 1.15 : 0.87, anchor);
          },
          { passive: false },
        );
        // 选区带：拖拽时**当场**画出将放大的区间。没有它的话，拖拽在松手前毫无反馈，
        // 用户只能靠"松手后才知道缩到哪"来学习这个手势（2026-09-25 用户：交互不合直觉）。
        const hostEl = el.parentElement;
        const band = (function () {
          if (!hostEl || !hostEl.appendChild || typeof document === "undefined") return null;
          if (hostEl.__chartSel) return hostEl.__chartSel;
          const d = document.createElement("div");
          d.className = "chart-sel";
          d.hidden = true;
          hostEl.appendChild(d);
          hostEl.__chartSel = d;
          return d;
        })();
        let mode = null; // "zoom" | "pan"
        let startX = 0;
        let startY = 0;
        let lastX = 0;
        const hideBand = function () {
          if (band) band.hidden = true;
        };
        over.addEventListener("pointerdown", function (ev) {
          if (ev.button !== 0) return;
          // Shift+拖拽 = 平移（只在放大之后才有意义，所以是修饰键动作）；
          // 裸拖拽 = 框选缩放（页面提示与用户的预期都是这个）。
          mode = ev.shiftKey ? "pan" : "zoom";
          startX = ev.clientX;
          startY = ev.clientY;
          lastX = ev.clientX;
          over.setPointerCapture?.(ev.pointerId);
        });
        over.addEventListener("pointermove", function (ev) {
          if (mode === "pan") {
            const dx = ev.clientX - lastX;
            lastX = ev.clientX;
            if (dx !== 0) panBy(el, dx);
            return;
          }
          if (mode !== "zoom" || !band) return;
          const rect = over.getBoundingClientRect();
          const left = Math.min(ev.clientX, startX) - rect.left;
          const width = Math.abs(ev.clientX - startX);
          if (width < 4) {
            hideBand();
            return;
          }
          // 区间读数在**拖拽过程中**就给：它就是"对应坐标轴范围"的即时反馈。
          const cur = instances.get(el);
          const xs = (cur && cur.data && cur.data[0]) || [];
          const r = dragToRange(startX - rect.left, ev.clientX - rect.left, startY - rect.top, ev.clientY - rect.top, {
            width: rect.width,
            total: xs.length,
          });
          band.hidden = false;
          band.style.left = left + "px";
          band.style.width = width + "px";
          if (r) {
            const cfg = chartCfg.get(el) || {};
            band.title = formatRangeCaption({ from: r.from, to: r.to, total: xs.length }, cfg);
          } else {
            band.title = "";
          }
        });
        const finish = function (ev) {
          if (mode === "pan") {
            mode = null;
            return;
          }
          if (mode !== "zoom") return;
          mode = null;
          hideBand();
          if (!ev) return;
          const rect = over.getBoundingClientRect();
          const cur = instances.get(el);
          const xs = (cur && cur.data && cur.data[0]) || [];
          const r = dragToRange(startX - rect.left, ev.clientX - rect.left, startY - rect.top, ev.clientY - rect.top, {
            width: rect.width,
            total: xs.length,
          });
          if (r && cur) applyXRange(el, cur, r.from, r.to);
        };
        over.addEventListener("pointerup", finish);
        over.addEventListener("pointercancel", function () {
          mode = null;
          hideBand();
        });
        over.addEventListener("pointerleave", function () {
          if (mode !== "pan") {
            mode = null;
            hideBand();
          }
        });
      }
    }
    const rt = ctrlReset.get(el);
    if (rt && rt.disabled !== undefined) {
      // 未缩放时"复位"没有意义 → 置灰（有意义的禁用胜过点了没反应的按钮）。
      const z = instance ? isZoomed(instance) : false;
      if (rt.disabled === z) rt.disabled = !z;
    }
    // uPlot 在每次 `setScale` 之后调用 `hooks.setScale`（拖拽缩放会走这里）。
    // 钩子数组按调用时读取，所以在构造之后挂也生效。
    if (instance) {
      instance.hooks = instance.hooks || {};
      // 视野变化**不再**靠 `hooks.setScale`：那条路径只在 uPlot 自己重算 scales 时
      // 触发，而我们现在直接写极值（见 applyXRange）。派生状态（类名/按钮）由
      // applyXRange 统一同步，避免"两个地方各同步一半"。
    }
    setZoomed(el, isZoomed(instance));
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
    // 翻译层判定"没有可画的数据" → 空状态（并且不再构造 uPlot）。
    if (built.empty) {
      showEmpty(el, built.emptyText || "no data yet — this chart fills in as the run progresses");
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
          // `setData` 的第二个参数默认是 **true（重置 scales）**——那会把用户刚拖出来的
          // 视野在下一帧数据到达时立刻擦掉（2026-09-23 真机实测：缩放"点了没反应"，
          // 其实是被 1 帧/秒的数据重置了）。用户缩放后必须**保留**视野，否则缩放功能
          // 等于不存在。未缩放时才让 uPlot 自己贴合新数据。
          prev.setData(built.data, prev.__zoomedByUser === true ? false : true);
        }
        prev.__lastWidth = el.clientWidth || prev.__lastWidth;
        return prev;
      }
    }
    // 清掉空状态占位：数据回来以后那句"还没有数据"必须消失，
    // 否则它会**永远压在图上**（真机截图里就是一条幽灵文字）。
    clearEmpty(el);
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
      // 区间读数的配置（单位/标签）来自调用方：图知道数据，不知道怎么念它。
      chartCfg.set(el, built.range || {});
      ensureZoomUi(el, instance);
      // 首帧也要有区间读数：否则"full range"只在用户第一次交互后才出现，
      // 而用户正是靠这一行判断"现在看的是不是全部"。
      setRangeCaption(el, instance, ...(() => {
        const xs = (instance.data && instance.data[0]) || [];
        return [xs[0] ?? 0, xs[xs.length - 1] ?? 0];
      })());
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
    chartCfg.delete(el);
    setZoomed(el, false);
    // 区间读数与图同寿：图没了还留着一行"1960-01 → 1960-05"就是**幽灵事实**。
    const host = el && el.parentElement;
    if (host && host.__chartRange) {
      host.__chartRange.remove();
      host.__chartRange = null;
    }
    if (host && host.__chartSel) host.__chartSel.remove();
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
    // 缩放 API **统一收宿主元素**（el），与 resetZoom/zoomBy 一致。
    // 曾经导出的是收实例的内部版 `isZoomed(inst)`，而调用方按元素传 → 永远返回
    // false（探针与冒烟测试因此得到过假的"没有缩放"结论）。
    resetZoom: resetZoom,
    zoomBy: zoomBy,
    panBy: panBy,
    isZoomed: function (el) {
      return isZoomed(instances.get(el));
    },
    // Exposed for tests: the axis-width rule (measured from the formatted labels).
    axisSizeFor: axisSizeFor,
    // Exposed for tests: the zoom/pan range math + the apply path (no setScale).
    zoomRange: zoomRange,
    panRange: panRange,
    dragToRange: dragToRange,
    formatRangeCaption: formatRangeCaption,
    applyXRange: applyXRange,
    // Exposed for tests: pure translations with no DOM/uPlot involvement.
    toLineData: toLineData,
    toStackedData: toStackedData,
    stackedLowerBounds: stackedLowerBounds,
    stackedUpperBounds: stackedUpperBounds,
    toStackedAreaData: toStackedAreaData,
  };
})();
