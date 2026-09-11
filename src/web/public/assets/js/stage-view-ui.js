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
    LEGEND: LEGEND,
  };
})();
