/* Alpine.js bridge — shared setup for the dashboard pages.
 *
 * 职责: 在 Alpine 启动前注册共用能力，使页面模板可以直接声明式地渲染：
 *   - `$ui` magic：把 `window.UI` 的格式化/分类/组件助手带进模板表达式
 *   - `$fmt` magic：模板里高频用到的格式化函数（避免模板里写长链）
 *   - 共用组件：状态徽章、KPI 卡等跨页面复用的小块
 *
 * 为什么用 Alpine（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.4）:
 *   手写 `renderX()` + `innerHTML` 的问题是**状态与 DOM 手工同步** —— 每加一个
 *   字段就要在 3 处（state、渲染、事件绑定）同时改，漏一处就出现"点了没反应"
 *   这类静默 bug。Alpine 让 DOM 成为状态的函数，且**不需要构建链**
 *   （指令写在 HTML 属性里，20 KB gzip，MIT），符合本项目的硬约束。
 *
 * 为什么不是 Vue/React: 它们要么需要 bundler，要么需要 JSX 编译。
 *   petite-vue 更小但维护弱。Alpine 是唯一"有响应式但无构建步骤"的主流选项。
 *
 * 禁止:
 *   - 在此写页面业务逻辑（各页面自己注册组件）。
 *   - 在此发请求。
 *   - 依赖 Alpine 之外的新全局（保持 vendored 依赖清单可审计）。
 */
"use strict";
(function () {
  /**
   * Register everything on `alpine:init`.
   *
   * Alpine fires this immediately before it walks the DOM, and a deferred script
   * that runs earlier still catches it - so page scripts can safely register
   * their own components afterwards, in any order among themselves.
   */
  document.addEventListener("alpine:init", function () {
    const Alpine = window.Alpine;
    if (!Alpine) return;
    // Asserted (not `|| {}`) so the shared helpers keep their types inside
    // this closure; the script is only loaded on pages that include common.js.
    const U = /** @type {UiModule} */ (window.UI);

    /* ------------------------------ magics ------------------------------ */
    /** `$ui.fmtTok(x)`, `$ui.esc(x)`, ... — the shared presentation helpers. */
    Alpine.magic("ui", () => U);

    /**
     * Short aliases for the formatters used inside templates. Templates read
     * much better as `$fmt.tok(x)` than `$ui.fmtTok(x)`, and every one of these
     * is null-safe (the formatters already render "—" for missing data).
     */
    Alpine.magic("fmt", () => ({
      int: (v) => U.fmtInt(v),
      money: (v) => U.fmtMoney(v),
      tok: (v) => U.fmtTok(v),
      cost: (v) => U.fmtCost(v),
      duration: (v) => U.fmtDuration(v),
      ago: (v) => U.fmtAgo(v),
      clock: (v) => U.fmtClock(v),
      pct: (v, d) => U.fmtPct(v, d),
      gameDate: (v) => U.fmtGameDate(v),
      esc: (v) => U.esc(v),
    }));

    /* --------------------------- shared pieces --------------------------- */
    /**
     * Status badge metadata.
     *
     * `interrupted` is the state a hard-killed run ends in (no finalize could
     * run), so it must be visibly distinct from a live `running` and explain
     * itself rather than looking like a generic warning.
     * See docs/STARTUP-AND-LIFECYCLE.md §5.
     */
    Alpine.store("badges", {
      info(s) {
        return (
          {
            running: { cls: "live", title: "Currently running" },
            completed: { cls: "ok", title: "Finished normally" },
            aborted: { cls: "warn", title: "Stopped by the user" },
            error: { cls: "bad", title: "Ended with an error" },
            interrupted: {
              cls: "bad",
              title:
                "The process stopped without shutting down cleanly (crash, kill -9, or power loss), " +
                "so the run has no final result. Anything recorded before that point is still intact.",
            },
          }[s] || { cls: "warn", title: "" }
        );
      },
    });

    /**
     * Read a small UI preference through the shared pref API, as Alpine state.
     * `x-model` uses this so toggles persist without page-level glue.
     */
    Alpine.magic("pref", () => (key, fallback) => U.getPref(key, fallback));
    Alpine.magic("setPref", () => (key, value) => U.setPref(key, value));

    /**
     * Shared "raw JSON" disclosure used by several pages: `$raw.toggle(el)`.
     * Kept as a magic rather than a component because it is a few lines inside
     * lists where a child component per row would be wasteful.
     */
    Alpine.magic("raw", () => ({
      toggle(ev) {
        const pre = ev.currentTarget.parentElement.querySelector(".raw");
        if (pre) pre.hidden = !pre.hidden;
      },
    }));
  });
})();
