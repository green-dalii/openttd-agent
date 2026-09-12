/* Stage view rendering — zoomed real minimap + our own overlay + legend.
 *
 * 职责: 把 `<session>/stages/NNN.json`（几何）+ `NNN.png`（真实小地图）合成一张
 *   可读的施工画面，并给出**我们能负责的图例**。纯函数部分可在 node:vm 里单测。
 *
 * 为什么需要「放大到施工窗口」（2026-09-12 实测）:
 *   `screenshot minimap` 对 256×256 地图输出 256×256 PNG = **1 像素/格**。
 *   一次施工只改几格 → 图上只差 1-2 像素 → **每个阶段的画面看起来一样**
 *   （实测 6 次抓取仅 3 张不同，且游戏日期全是 1950-01-01）。
 *   所以服务端给出 `focus` 窗口，这里用 CSS 裁剪放大，让改动可见。
 *
 * 为什么图例分两部分: 底图颜色是 **OpenTTD 自己的地形小地图配色**（不是我们画的），
 *   我们只能如实标注；而路线/城镇/车库是**我们自己叠加的**，所以可以精确保证。
 *   把两者混在一起宣称"颜色含义"会误导用户。
 *
 * 禁止: 在此发请求（URL 由调用方给出）；不要声称底图像素是我们绘制的。
 */
"use strict";
(function () {
  /**
   * CSS `background-position` (in %) that centres map point `p` inside a
   * backdrop magnified `scale` times.
   *
   * 推导: 放大后背景宽 = scale·W。要让图像坐标 p·scale·W 落在容器中心 W/2，
   * 需要的偏移是 W/2 − p·scale·W；而 `background-position: q%` 的偏移是
   * q·W·(1−scale)。两式相等 => q = (0.5 − p·scale) / (1 − scale)。
   * scale = 1 时退化为居中（无需裁剪）。
   */
  function bgPosition(p, scale) {
    const s = Number(scale) > 1 ? Number(scale) : 1;
    if (s === 1) return 50;
    return ((0.5 - Number(p) * s) / (1 - s)) * 100;
  }

  /**
   * Where a map coordinate lands inside the cropped element, as a percentage.
   * Inverse of `bgPosition`: the window covers `1/scale` of the map.
   */
  function inWindow(p, centre, scale) {
    const s = Number(scale) > 1 ? Number(scale) : 1;
    return ((Number(p) - Number(centre)) * s + 0.5) * 100;
  }

  /** Inline style for the zoomed base minimap. */
  function backdropStyle(url, focus) {
    const f = focus || { x: 0.5, y: 0.5, scale: 1 };
    const z = Number(f.scale) > 1 ? Number(f.scale) : 1;
    return [
      `background-image:url("${String(url).replace(/"/g, "%22")}")`,
      `background-size:${(z * 100).toFixed(2)}% auto`,
      `background-position:${bgPosition(f.x, z).toFixed(2)}% ${bgPosition(f.y, z).toFixed(2)}%`,
    ].join(";");
  }

  /** Overlay marks (our own drawings) derived from the stage geometry. */
  function overlayMarks(view) {
    const v = view || {};
    const f = v.focus || { x: 0.5, y: 0.5, scale: 1 };
    const marks = [];
    for (const r of v.routes || []) {
      if (!r || !r.from || !r.to) continue;
      marks.push({
        kind: "route",
        label: r.label || "",
        // Percentages inside the cropped window; the SVG scales to fit.
        x1: inWindow(r.from.x, f.x, f.scale),
        y1: inWindow(r.from.y, f.y, f.scale),
        x2: inWindow(r.to.x, f.x, f.scale),
        y2: inWindow(r.to.y, f.y, f.scale),
      });
    }
    for (const m of v.markers || []) {
      if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      marks.push({
        kind: m.kind,
        label: m.label || m.kind,
        x: inWindow(m.x, f.x, f.scale),
        y: inWindow(m.y, f.y, f.scale),
      });
    }
    // Only marks that fall inside the window are worth drawing.
    const inside = (p) => p >= -4 && p <= 104;
    return marks.filter((m) =>
      m.kind === "route"
        ? inside(m.x1) || inside(m.y1) || inside(m.x2) || inside(m.y2)
        : inside(m.x) && inside(m.y),
    );
  }

  /**
   * 把 overlayMarks 的混合列表拆成两类。
   *
   * 为什么需要拆分:Alpine 的 `x-for` 要求模板内**恰好一个根元素**。
   * 用 `<template x-if>` 在一个 `x-for` 里分支(route vs point)会放两个兄弟根,
   * 导致 "Cannot read properties of undefined (reading 'children')" 且内层拿不到循环变量。
   * 拆成两个数组、各用一个平铺的 `x-for`,既避开这个坑,渲染路径也更直。
   */
  function routesOf(marks) {
    return (marks || []).filter((m) => m && m.kind === "route");
  }

  /** 非路线的标记(城镇 / 车库 / 其他)。 */
  function pointsOf(marks) {
    return (marks || []).filter((m) => m && m.kind !== "route");
  }

  /** 点标记的 CSS 类——颜色只由 kind 决定,放在这里以便单测锁定。 */
  function pointClass(m) {
    if (!m) return "ov-other";
    return m.kind === "town" ? "ov-town" : m.kind === "depot" ? "ov-depot" : "ov-other";
  }

  /** 点标记半径:城镇按人口加权(更大 = 更显眼)。 */
  function pointRadius(m) {
    return m && m.kind === "town" ? 3 : 2.2;
  }

  /** 数字→属性文本,非有限值一律丢弃(避免 "NaN" 进入 SVG)。 */
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : null;
  }

  /** 把文本转义成可安全放进双引号属性的形式。 */
  function escAttr(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Render the overlay as a complete `<svg>` **markup string**.
   *
   * 为什么不直接在 HTML 里写 `<template x-for>`:`<template>` 放在 `<svg>` 内部
   * 会被 HTML 解析器当作 **SVG 命名空间元素**,而不是 `HTMLTemplateElement`。
   * 它的 `.content` 是 `undefined`,于是 Alpine 的 `x-for` 读 `.content.children`
   * 直接抛 "Cannot read properties of undefined (reading 'children')",
   * 并且循环变量 `m` 永远不会绑定(表现为满屏 `m is not defined`)。
   * 实测证据(Chrome,2026-09-12):
   *   { expr: 'm in stageRoutes(v)', ns: 'SVG', isHTMLTemplate: false, contentDefined: false }
   *
   * 所以标记改成**字符串拼接**,再由 `x-html` 注入一个 HTML 容器——注入时
   * `<svg>` 处于 HTML 解析上下文,命名空间才是对的。生成逻辑是纯函数,可在 Node 单测。
   */
  function overlaySvg(view) {
    const marks = overlayMarks(view);
    const routes = routesOf(marks);
    const points = pointsOf(marks);
    if (!routes.length && !points.length) return "";

    const parts = [];
    for (const m of routes) {
      const x1 = num(m.x1), y1 = num(m.y1), x2 = num(m.x2), y2 = num(m.y2);
      if (x1 === null || y1 === null || x2 === null || y2 === null) continue;
      parts.push(
        `<line class="ov-route" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"></line>`,
      );
    }
    for (const m of points) {
      const x = num(m.x), y = num(m.y);
      if (x === null || y === null) continue;
      parts.push(
        `<circle class="${pointClass(m)}" cx="${x}" cy="${y}" r="${pointRadius(m)}"></circle>`,
      );
    }
    if (!parts.length) return "";

    // aria-label 里放计数,便于无障碍与断言;坐标是百分比(0-100)。
    const label = `overlay: ${routes.length} route(s), ${points.length} marker(s)`;
    return (
      `<svg class="snap-ov" viewBox="0 0 100 100" preserveAspectRatio="none"` +
      ` aria-label="${escAttr(label)}">${parts.join("")}</svg>`
    );
  }

  /** The legend: what we draw (exact), plus an honest note about the base map. */
  const LEGEND = {
    ours: [
      { cls: "lg-route", label: "planned / built route" },
      { cls: "lg-town", label: "town (size = population)" },
      { cls: "lg-depot", label: "depot / station" },
    ],
    // Measured from our own captures (2026-09-12) of OpenTTD's terrain minimap.
    base: [
      { color: "#1c448c", label: "water" },
      { color: "#40700c", label: "land" },
      { color: "#800000", label: "town / built-up" },
      { color: "#626562", label: "rock / rough" },
    ],
  };

  window.StageViewUI = {
    bgPosition: bgPosition,
    inWindow: inWindow,
    backdropStyle: backdropStyle,
    overlayMarks: overlayMarks,
    routesOf: routesOf,
    pointsOf: pointsOf,
    pointClass: pointClass,
    pointRadius: pointRadius,
    overlaySvg: overlaySvg,
    LEGEND: LEGEND,
  };
})();
