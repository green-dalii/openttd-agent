/* Live page — Alpine view model.
 *
 * 职责: 把 Live 页的**全部推导**集中为可测的纯逻辑：
 *   哪些 KPI 属于"结果"、哪些属于"成本"，现金曲线怎么取点，token 怎么拆成堆叠柱，
 *   事件怎么过滤/计数，空态该说什么，以及"现在在做什么"的摘要。
 *   模板只做声明式渲染，没有 if/else 业务判断。
 *
 * 为什么这样分层（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.4 阶段 4）:
 *   迁移到 Alpine 的风险不是"指令写错"，而是**把已有业务规则弄丢**。
 *   规则留在可单测的纯函数里，DOM 绑定退化为机械翻译，规则就不会悄悄消失。
 *
 * 信息架构（本次重构的第一性原理，见 docs/DASHBOARD-UI.md §5.1）:
 *   旧页面把「Agent 域」和「Economy 域」分成两大块，导致"公司在赚钱吗"和
 *   "这次花了多少 token"混在一条 KPI 里，而唯一能说明"是否在推理"的步骤流被埋在中间。
 *   新顺序按**用户实际会问的问题**排：
 *     ① Now（它在做什么）→ ② Result（公司赢了吗）→ ③ Progress（做成了什么）
 *     → ④ Thinking（真的在推理吗）→ ⑤ Cost（花了多少）→ ⑥ Detail（原始日志，默认收起）
 *
 * 事实来源: docs/DASHBOARD-UI.md §5.1、docs/DASHBOARD-API.md §4（WS 帧形状）。
 * 禁止: 在此碰 DOM 或 Alpine 指令；不发请求。
 */
"use strict";
(function () {
  const U = window.UI;

  /** Bounded feeds: the page must not grow without limit over a long run. */
  const MAX_EVENTS_SHOWN = 160;
  const MAX_STEPS_SHOWN = 200;

  /** Cash-chart metric order for the switch. */
  const CASH_METRICS = [
    { id: "money", label: "Cash" },
    { id: "loan", label: "Loan" },
    { id: "income", label: "Income" },
  ];

  /** Per-turn chart metrics. */
  const TOKEN_METRICS = [
    { id: "total", label: "Tokens", hint: "input / output / reasoning per turn" },
    { id: "cost", label: "Cost", hint: "spend per turn" },
  ];

  /** Colours for the token composition, matching the dashboard palette. */
  const TOKEN_SERIES = [
    { name: "Input", key: "input", color: "#5fb3ff" },
    { name: "Output", key: "output", color: "#7bc96f" },
    { name: "Reasoning", key: "reasoning", color: "#c3a6ff" },
    { name: "Cache read", key: "cacheRead", color: "#56d4dd" },
  ];

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  /**
   * Create the Live view model.
   *
   * State is mutated by the WS handlers in live.js; every derivation below is a
   * pure function of that state, which is what makes the page testable.
   */
  /**
   * Upsert a stage view into the list, keyed by archive `index`.
   *
   * 为什么必须幂等而非 append:同一帧可能被投递两次(重连 / 监听器重复注册),
   * 盲追加会产生两条 `index` 相同的记录 —— 而 `index` 是 Alpine `x-for` 的 `:key`,
   * 重复 key 会让整段列表**渲染不出任何节点**(实测:2 条同 key → 0 个 `.snap`),
   * 且第 2 条没有图片(后到的 stageImage 只会补到第一个同 index 的记录上)。
   * 用 upsert 后,重复投递不再产生分歧。
   */
  function upsertStageView(list, v) {
    const arr = Array.isArray(list) ? list.slice() : [];
    const incoming = v && typeof v === "object" ? v : null;
    if (!incoming) return arr;
    const i = arr.findIndex((x) => x && x.index === incoming.index);
    if (i === -1) arr.push(incoming);
    // 保留已有的 image(后到的补图帧可能先于/后于本体帧到达)
    else arr[i] = Object.assign({}, arr[i], incoming, {
      image: incoming.image || arr[i].image,
    });
    return arr.slice(-24);
  }

  function create() {
    return {
      /* ------------------------------ state ------------------------------ */
      link: "connecting",
      sessionId: null,
      date: null,
      companies: {},
      recent: [],
      telemetry: null,
      steps: [],
      thinking: [],
      stages: [],
      stageViews: [],
      /**
       * Cross-game memory injected into THIS game (from the snapshot).
       *
       * Shape: { lessonsInjected, strategiesInjected, lessons[], strategies[] }.
       * Null until the server reports it; the panel stays hidden in that case.
       */
      memory: null,
      run: null,
      runControl: false,
      startedAt: null,
      /** UI state (persisted prefs are applied by the page on init). */
      evSearch: "",
      evHidden: new Set(),
      cashMetric: "money",
      tokenMetric: "total",
      stepFilter: "all",
      stepRaw: false,
      evRaw: false,
      follow: true,

      /* ---------------------------- constants ---------------------------- */
      cashMetrics: CASH_METRICS,
      tokenMetrics: TOKEN_METRICS,

      /* --------------------------- derivations --------------------------- */
      /** The agent plays company 0; fall back to the first company seen. */
      primaryCompany() {
        const ids = Object.keys(this.companies || {});
        if (!ids.length) return {};
        return this.companies["0"] || this.companies[ids[0]] || {};
      },

      /** Server-owned history of the primary company (oldest → newest). */
      primaryHistory() {
        return this.primaryCompany().history || [];
      },

      /**
       * History of one named metric, non-finite points dropped.
       *
       * Named per-metric on purpose: `hasHistory(metric)` used to consult the
       * *selected* cash metric regardless of its argument, so "Income / yr" showed
       * a sparkline whenever *Cash* had history. The argument was decorative.
       */
      sparkSeries(metric) {
        if (!metric) return [];
        return this.primaryHistory()
          .map((h) => Number(h[metric]))
          .filter((v) => Number.isFinite(v));
      },

      /** Whether a metric has enough points to draw a sparkline. */
      hasSpark(metric) {
        return this.sparkSeries(metric).length > 1;
      },

      /**
       * Sparkline specs aligned to `resultKpis()` order (null where there is no
       * series). `UI.paintSparks` matches tiles by position, and both lists come
       * from `resultKpis()`, so they cannot drift apart.
       */
      sparkSpecs() {
        return this.resultKpis().map((k) => {
          const data = this.sparkSeries(k.spark);
          return data.length > 1 ? { data } : null;
        });
      },

      /**
       * Outcome KPIs: "is the company winning?".
       *
       * Deliberately free of cost metrics — the old page mixed `Tokens used` into
       * this strip, which confused an outcome with an expense.
       */
      resultKpis() {
        const c = this.primaryCompany();
        const e = c.economy || {};
        const s = c.stats || {};
        const hist = c.history || [];
        const seriesOf = (key) => hist.map((h) => Number(h[key])).filter((v) => Number.isFinite(v));
        const money = seriesOf("money");
        const income = seriesOf("income");
        const delta = (arr) => (arr.length > 1 ? arr[arr.length - 1] - arr[arr.length - 2] : undefined);
        return [
          { k: "Cash", v: U.fmtMoney(e.money), delta: delta(money), deltaFmt: "money", spark: "money" },
          { k: "Income / yr", v: U.fmtMoney(e.income), delta: delta(income), deltaFmt: "money", spark: "income" },
          { k: "Company value", v: U.fmtMoney(e.companyValue) },
          { k: "Loan", v: U.fmtMoney(e.loan) },
          { k: "Fleet", v: `${U.fmtInt(s.vehicles ?? 0)} veh`, hint: `${U.fmtInt(s.stations ?? 0)} stations` },
        ];
      },

      /** Cost KPIs: "what is this costing me?". */
      costKpis() {
        const t = this.telemetry;
        const u = (t && t.usage && t.usage.total) || {};
        const totals = (t && t.totals) || {};
        const failRate = totals.toolCalls ? totals.toolFailures / totals.toolCalls : 0;
        return [
          { k: "Tokens used", v: U.fmtTok(u.totalTokens), hint: U.fmtCost(u.costTotal) },
          { k: "Decisions", v: U.fmtInt(totals.decisions) },
          {
            k: "Tool calls",
            v: U.fmtInt(totals.toolCalls),
            hint: totals.toolFailures ? `${U.fmtInt(totals.toolFailures)} failed (${U.fmtPct(failRate)})` : "none failed",
          },
        ];
      },

      /** Whether there is any company at all (drives the empty state). */
      companiesEmpty() {
        return Object.keys(this.companies || {}).length === 0;
      },

      /**
       * One card per company (the game can have several; the agent plays 0).
       *
       * Kept separate from `resultKpis()`: the KPI strip answers "is OUR company
       * winning", while these cards let you compare against any other company.
       */
      companyCards() {
        const ids = Object.keys(this.companies || {});
        return ids.map((id) => {
          const c = this.companies[id] || {};
          const i = c.info || { name: `Company ${id}`, isAi: false };
          const e = c.economy || {};
          const st = c.stats || {};
          const money = Number(e.money || 0);
          return {
            id,
            name: i.name || `Company ${id}`,
            isAi: Boolean(i.isAi),
            neg: money < 0,
            money: U.fmtMoney(e.money),
            value: `value ${U.fmtMoney(e.companyValue)} · loan ${U.fmtMoney(e.loan)}`,
            fleet: `${U.fmtInt(st.vehicles ?? "—")} veh · ${U.fmtInt(st.stations ?? "—")} stn${
              i.manager ? ` · ${i.manager}` : ""
            }`,
          };
        });
      },

      /** Cash-curve series, one per company, for the selected metric. */
      cashSeries() {
        const ids = Object.keys(this.companies || {});
        return ids
          .map((id, idx) => {
            const c = this.companies[id] || {};
            return {
              name: (c.info && c.info.name) || `Company ${id}`,
              color: U.pickColor ? U.pickColor(idx) : "#5ac8fa",
              data: (c.history || []).map((h) => num(h[this.cashMetric])),
            };
          })
          .filter((s) => s.data.length);
      },

      /** Axis labels: game dates, so the curve is readable without a legend. */
      cashLabels() {
        const first = Object.values(this.companies || {})[0] || {};
        return (first.history || []).map((h) =>
          h.year == null ? "—" : `${h.year}-${String(h.month ?? 1).padStart(2, "0")}`,
        );
      },

      /** Series for the per-turn chart. */
      tokenSeries() {
        if (this.tokenMetric === "cost") {
          return [{ name: "Cost", color: "#e5c07b" }];
        }
        return TOKEN_SERIES.map((t) => ({ name: t.name, color: t.color }));
      },

      /**
       * Per-turn items for the stacked bars.
       *
       * Composition, not comparison: input dwarfs output/reasoning, so stacking is
       * the only honest way to show both the per-turn total and its split.
       */
      tokenItems() {
        const byTurn = (this.telemetry && this.telemetry.usage && this.telemetry.usage.byTurn) || [];
        const isCost = this.tokenMetric === "cost";
        return byTurn.map((r) => {
          const u = r.usage || {};
          return {
            label: `T${r.turn}`,
            values: isCost
              ? [num(u.costTotal)]
              : TOKEN_SERIES.map((s) => num(u[s.key])),
            sub: isCost
              ? `${U.fmtInt(u.totalTokens)} tokens`
              : `${U.fmtInt(u.totalTokens)} tokens in ${U.fmtInt(r.steps)} step(s)`,
          };
        });
      },

      /** Agent steps, filtered by the segmented control. */
      visibleSteps() {
        const all = this.steps || [];
        const f = this.stepFilter;
        const shown =
          f === "message"
            ? all.filter((s) => s.kind === "message")
            : f === "tool"
              ? all.filter((s) => s.kind === "tool")
              : f === "failed"
                ? all.filter((s) => s.kind === "tool" && s.ok === false)
                : all;
        return shown.slice(-MAX_STEPS_SHOWN);
      },

      /** Category chips for the event filter, with counts. */
      categoryChips() {
        const { counts, order } = U.categoryCounts(this.recent);
        return order.map((cat) => ({
          cat,
          label: U.categoryLabel(cat),
          cls: U.categoryClass(cat),
          n: counts[cat] || 0,
          off: this.evHidden.has(cat),
        }));
      },

      /** Events after the category and search filters, newest first. */
      visibleEvents() {
        return (this.recent || [])
          .filter((e) => !this.evHidden.has(U.categoryOf(e.kind)))
          .filter((e) => U.eventMatches(e, this.evSearch))
          .slice(-MAX_EVENTS_SHOWN)
          .reverse();
      },

      /** How many events exist in total (for the "N collected" line). */
      eventTotal() {
        return U.categoryCounts(this.recent).total;
      },

      /** The honest empty state: why are these panels empty, and what to do. */
      notice() {
        const t = this.telemetry;
        const brain = t && t.brain;
        const hasReal = Boolean(brain && brain.kind === "real");
        const runState = (this.run && this.run.state) || "idle";
        const err = this.run && this.run.error;

        if (err) {
          return {
            show: true, kind: "err", title: "Could not start", body: String(err),
            canStart: this.runControl, hint: "",
          };
        }
        if (hasReal) return { show: false, kind: "", title: "", body: "", canStart: false, hint: "" };

        const idle = this.runControl && runState === "idle";
        if (idle) {
          return {
            show: true,
            kind: "",
            title: "No run is active",
            body: "Start a run to see the agent's decisions, token usage and steps.",
            canStart: true,
            hint: "",
          };
        }
        return {
          show: true,
          kind: "",
          title: "This run has no LLM",
          body:
            "Token usage and LLM steps only exist when an agent is driving. This run only " +
            "observes the built-in game AI, so those panels stay empty by design.",
          canStart: this.runControl && runState === "idle",
          hint: this.runControl ? "" : "Restart with `pnpm run cli --serve` to control runs from here.",
        };
      },

      /** Run-control state for the header pills and buttons. */
      runState() {
        return (this.run && this.run.state) || "idle";
      },

      runBusy() {
        const s = this.runState();
        return s === "starting" || s === "stopping";
      },

      /** Human name for the current brain, never letting a demo look real. */
      brainLabel() {
        const t = this.telemetry;
        const b = t && t.brain;
        if (!b || !b.kind) return "not configured";
        if (b.kind === "real") return `real LLM · ${b.provider || "—"} / ${b.model || "—"}`;
        return `⚠ scripted demo (not a real LLM) · ${b.provider || "—"} / ${b.model || "—"}`;
      },

      /**
       * The "what is it doing right now" summary.
       *
       * This is the answer to the first question a returning operator has, and the
       * old page gave no single place to find it: intent, last action and staleness
       * were scattered across a step feed.
       */
      nowSummary() {
        const t = this.telemetry || {};
        const lastMsg = [...(this.steps || [])].reverse().find((s) => s.kind === "message" && s.text);
        const lastTool = [...(this.steps || [])].reverse().find((s) => s.kind === "tool");
        return {
          state: this.runControl ? this.runState() : t.sessionId ? "running" : "idle",
          brain: this.brainLabel(),
          lastDecision: t.lastActivityAt ? U.fmtAgo(t.lastActivityAt) : "",
          intent: lastMsg ? String(lastMsg.text).slice(0, 400) : "no decision recorded yet",
          action: lastTool
            ? `${lastTool.tool || "tool"}${lastTool.ok === false ? " (failed)" : ""} — ${lastTool.summary || ""}`
            : "—",
          turns: `${U.fmtInt(t.activeTurn || 0)} active / ${U.fmtInt(t.turns || 0)} total`,
        };
      },

      /** Staged summaries, newest first. */
      stageList() {
        return (this.stages || []).slice().reverse();
      },

      /** Stage snapshots, newest first (the visual record of progress). */
      stageViewsNewestFirst() {
        return (this.stageViews || []).slice().reverse();
      },

      /**
       * "What was this game told?" — the per-game view of the memory system.
       *
       * The metrics ledger only records a COUNT (`lessonsInjected: 1`). A count is
       * unverifiable: it cannot tell you whether the right lesson was injected, or
       * whether anything was injected at all. This exposes the actual content, which
       * is the whole reason the panel exists (AGENTS §5.1).
       */
      memoryInEffect() {
        const m = this.memory || {};
        // Guard the shape: this data crosses the wire, and a malformed field must
        // degrade to "nothing shown", never to a thrown render error.
        const rawLessons = Array.isArray(m.lessons) ? m.lessons : [];
        const rawStrategies = Array.isArray(m.strategies) ? m.strategies : [];
        const lessons = rawLessons
          .map((l) => ({
            text: l && typeof l.text === "string" ? l.text.trim() : "",
            kind: l && l.kind === "dont" ? "dont" : "do",
            confidence: U.fmtPct(Number(l && l.confidence) || 0, 0),
            evidence: (l && Array.isArray(l.evidence) ? l.evidence : []).map(String),
          }))
          .filter((l) => l.text);
        const strategies = rawStrategies
          .map((c) => {
            if (!c || !c.action) return null;
            const params = Object.entries(
              c.params && typeof c.params === "object" ? c.params : {},
            )
              .map(([k, v]) => `${k}=${v}`)
              .join(", ");
            return { label: params ? `${c.action} (${params})` : String(c.action) };
          })
          .filter((s) => s !== null);
        const lessonsInjected = Number(m.lessonsInjected) || lessons.length;
        const strategiesInjected = Number(m.strategiesInjected) || strategies.length;
        const total = lessonsInjected + strategiesInjected;
        return {
          active: total > 0,
          lessonsInjected,
          strategiesInjected,
          lessons,
          strategies,
          /** Honest one-liner: "nothing" is a statement, not a blank. */
          summary:
            total === 0
              ? "nothing — this game ran on the base prompt"
              : `${U.fmtInt(lessonsInjected)} lesson(s) + ${U.fmtInt(strategiesInjected)} strategy card(s)`,
        };
      },

      /** Per-tool performance rows. */
      toolRows() {
        const t = this.telemetry;
        return (t && t.usage && t.usage.byTool) || [];
      },

      /** Runtime detail rows for the cost/runtime table. */
      runtimeRows() {
        const t = this.telemetry;
        if (!t) return [];
        const u = (t.usage && t.usage.total) || {};
        const totals = t.totals || {};
        const failRate = totals.toolCalls ? totals.toolFailures / totals.toolCalls : 0;
        return [
          ["Turns", `${U.fmtInt(t.activeTurn || 0)} active / ${U.fmtInt(t.turns || 0)} total`],
          ["Decisions", U.fmtInt(totals.decisions)],
          ["Tool calls", U.fmtInt(totals.toolCalls)],
          ["Tool failures", `${U.fmtInt(totals.toolFailures)} (${U.fmtPct(failRate)})`],
          ["Input tokens", U.fmtTok(u.input)],
          ["Output tokens", U.fmtTok(u.output)],
          ["Reasoning", U.fmtTok(u.reasoning)],
          ["Cache r/w", `${U.fmtTok(u.cacheRead)} / ${U.fmtTok(u.cacheWrite)}`],
          ["Total tokens", U.fmtTok(u.totalTokens)],
          ["Cost", U.fmtCost(u.costTotal)],
          ["Last activity", U.fmtAgo(t.lastActivityAt)],
        ];
      },

      /** Per-turn table rows, newest last. */
      turnRows() {
        const t = this.telemetry;
        const byTurn = (t && t.usage && t.usage.byTurn) || [];
        return byTurn.map((r) => {
          const u = r.usage || {};
          return {
            turn: r.turn,
            input: U.fmtTok(u.input),
            output: U.fmtTok(u.output),
            reasoning: U.fmtTok(u.reasoning),
            cache: U.fmtTok(u.cacheRead),
            total: U.fmtTok(u.totalTokens),
            cost: U.fmtCost(u.costTotal),
            steps: U.fmtInt(r.steps),
          };
        });
      },

      /** Reasoning entries, newest first. */
      thinkingNewestFirst() {
        return (this.thinking || []).slice().reverse();
      },

      /**
       * The hidden-category set with `cat` flipped.
       *
       * Returns a NEW Set: Alpine tracks reassignment, not in-place mutation, so
       * mutating the existing set would not re-render the chips.
       */
      toggleCategorySet(cat) {
        const next = new Set(this.evHidden);
        if (next.has(cat)) next.delete(cat);
        else next.add(cat);
        return next;
      },
    };
  }

  window.LiveView = {
    upsertStageView: upsertStageView,
    create: create,
    CASH_METRICS: CASH_METRICS,
    TOKEN_METRICS: TOKEN_METRICS,
    TOKEN_SERIES: TOKEN_SERIES,
    MAX_EVENTS_SHOWN: MAX_EVENTS_SHOWN,
    MAX_STEPS_SHOWN: MAX_STEPS_SHOWN,
  };
})();
