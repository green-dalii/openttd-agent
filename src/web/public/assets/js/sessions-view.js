/* Sessions page — Alpine view model.
 *
 * 职责: 把"历史局浏览/回放/对比"的**状态推导**集中为纯函数
 *   （`window.SessionsView.create(seed)`），返回给 Alpine 模板直接消费。
 *   模板只做展示，所有判断（哪些运行可见、成功率怎么算、Δ 的方向、
 *   哪些 token 分片要画）都在这里，因而可以在 node:vm 里完整单测。
 *
 * 为什么这样切分（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.4 阶段 4）:
 *   迁移到 Alpine 的风险不是"指令写错"，而是**把已有业务规则弄丢**。
 *   把规则留在可测的纯函数里，页面模板退化为声明式渲染，规则就不会悄悄消失。
 *
 * 事实来源: docs/DASHBOARD-UI.md §5.3、docs/DASHBOARD-API.md §2.5/§3.3、
 *   docs/STARTUP-AND-LIFECYCLE.md §5（interrupted 的语义）。
 * 禁止: 在此写 DOM 操作或 Alpine 指令（模板在 HTML 里）；不发请求。
 */
"use strict";
(function () {
  const U = window.UI;

  /** Token donut: fixed order + colour so two runs are visually comparable. */
  const TOKEN_SLICES = [
    { label: "Input", key: "input", color: "#5fb3ff" },
    { label: "Output", key: "output", color: "#7bc96f" },
    { label: "Reasoning", key: "reasoning", color: "#c3a6ff" },
    { label: "Cache read", key: "cacheRead", color: "#56d4dd" },
    { label: "Cache write", key: "cacheWrite", color: "#e5c07b" },
  ];

  /** Status badge metadata; see docs/STARTUP-AND-LIFECYCLE.md §5. */
  const STATUS_INFO = {
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
  };

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const usageOf = (meta) => ((meta || {}).totals || {}).usage || {};
  const outcomeOf = (meta) => (meta || {}).outcome || {};

  /**
   * Build the Sessions view model.
   *
   * `seed` carries the already-loaded data so the model stays a pure projection:
   *   { sessions, data, compareData, onlyDone }
   * Fetching lives in the page script (Alpine component's `init`).
   */
  function create(seed) {
    const s = seed || {};
    return {
      /* ------------------------------ state ------------------------------ */
      sessions: s.sessions || [],
      data: s.data || null,
      compareData: s.compareData || null,
      compareWith: s.compareWith || null,
      onlyDone: Boolean(s.onlyDone),
      stepFilter: "all",
      stepRaw: false,

      /* ---------------------------- derivation ---------------------------- */
      visible() {
        return this.onlyDone
          ? this.sessions.filter((x) => x.status === "completed")
          : this.sessions;
      },

      /**
       * Header totals. `successRate` is `null` (not 0) when nothing completed —
       * "nothing finished" and "everything failed" are different facts.
       */
      totals() {
        const all = this.sessions;
        const done = all.filter((x) => x.status === "completed");
        const built = done.filter((x) => outcomeOf(x).constructionDone === true);
        return {
          count: all.length,
          done: done.length,
          successRate: done.length ? built.length / done.length : null,
          tokens: all.reduce((a, x) => a + num(usageOf(x).totalTokens), 0),
          cost: all.reduce((a, x) => a + num(usageOf(x).costTotal), 0),
        };
      },

      statusInfo(status) {
        return STATUS_INFO[status] || { cls: "warn", title: "" };
      },

      isBuilt(session) {
        return outcomeOf(session).constructionDone === true;
      },

      isIncomplete(session) {
        // Unknown (field absent) is NOT a failure.
        return outcomeOf(session).constructionDone === false;
      },

      /** Token composition for the donut; empty slices are dropped. */
      tokenSlices() {
        const u = usageOf(this.data && this.data.meta);
        return TOKEN_SLICES
          .map((t) => ({ label: t.label, value: num(u[t.key]), color: t.color }))
          .filter((t) => t.value > 0);
      },

      /**
       * Comparison table rows. `delta` is right-hand run minus left-hand run, so
       * a positive Δ on Cash is an improvement while a positive Δ on cost or
       * failures is a regression. Non-numeric rows have `delta: null`.
       */
      compareRows() {
        const ma = (this.data && this.data.meta) || {};
        const mb = (this.compareData && this.compareData.meta) || {};
        const ta = ma.totals || {}, tb = mb.totals || {};
        const ua = ta.usage || {}, ub = tb.usage || {};
        const oa = outcomeOf(ma), ob = outcomeOf(mb);
        const dur = (m) => (m && m.endedAt ? m.endedAt - m.startedAt : undefined);
        const delta = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null);

        const rows = [
          ["Result", oa.constructionDone === true ? "built" : oa.constructionDone === false ? "incomplete" : "—",
            ob.constructionDone === true ? "built" : ob.constructionDone === false ? "incomplete" : "—", null],
          ["Cash", U.fmtMoney(oa.money), U.fmtMoney(ob.money), delta(num(oa.money), num(ob.money))],
          ["Vehicles", U.fmtInt(oa.vehicles), U.fmtInt(ob.vehicles), delta(num(oa.vehicles), num(ob.vehicles))],
          ["Stations", U.fmtInt(oa.stations), U.fmtInt(ob.stations), delta(num(oa.stations), num(ob.stations))],
          ["Decisions", U.fmtInt(ta.decisions), U.fmtInt(tb.decisions), delta(num(ta.decisions), num(tb.decisions))],
          ["Tool calls", U.fmtInt(ta.toolCalls), U.fmtInt(tb.toolCalls), delta(num(ta.toolCalls), num(tb.toolCalls))],
          ["Tool failures", U.fmtInt(ta.toolFailures), U.fmtInt(tb.toolFailures),
            delta(num(ta.toolFailures), num(tb.toolFailures))],
          ["Tokens", U.fmtTok(ua.totalTokens), U.fmtTok(ub.totalTokens), delta(num(ua.totalTokens), num(ub.totalTokens))],
          ["Cost", U.fmtCost(ua.costTotal), U.fmtCost(ub.costTotal), delta(num(ua.costTotal), num(ub.costTotal))],
          ["Duration",
            Number.isFinite(dur(ma)) ? U.fmtDuration(dur(ma)) : "—",
            Number.isFinite(dur(mb)) ? U.fmtDuration(dur(mb)) : "—",
            delta(dur(ma), dur(mb))],
          ["Mode", ma.mode, mb.mode, null],
          ["Model", (ma.llm && ma.llm.model) || "—", (mb.llm && mb.llm.model) || "—", null],
        ];
        return rows.map(([key, a, b, d]) => ({ key, a, b, delta: d }));
      },

      /** Filtered agent steps (LLM / tools / failures). */
      steps() {
        const all = ((this.data && this.data.telemetry) || {}).steps || [];
        const f = this.stepFilter;
        if (f === "message") return all.filter((x) => x.kind === "message");
        if (f === "tool") return all.filter((x) => x.kind === "tool");
        if (f === "failed") return all.filter((x) => x.kind === "tool" && x.ok === false);
        return all;
      },

      /* ------------------------------ actions ------------------------------ */
      toggleOnlyDone(value) {
        this.onlyDone = Boolean(value);
        U.setPref("sessions.onlyDone", this.onlyDone);
      },

      /** Human-readable Δ cell; `null` means "not comparable". */
      deltaText(d) {
        if (d === null || !Number.isFinite(d)) return "—";
        const rounded = Math.abs(d) >= 1000 ? U.fmtInt(Math.round(d)) : String(Math.round(d * 1000) / 1000);
        return (d > 0 ? "+" : "") + rounded;
      },

      deltaClass(d) {
        if (d === null || !Number.isFinite(d) || d === 0) return "dim";
        return d > 0 ? "pos" : "neg";
      },
    };
  }

  window.SessionsView = { create: create, TOKEN_SLICES: TOKEN_SLICES, STATUS_INFO: STATUS_INFO };
})();
