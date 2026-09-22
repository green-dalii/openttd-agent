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
  /**
   * 把一条实测读数渲染成人读的一行（R2）。
   *
   * 缺读数显示 "—"，**不能**默认成 0：缺报与真实的 0 是两件事，
   * 而记忆面板存在的意义就是让人能判断这条经验有没有依据（AGENTS §5.2）。
   */
  function outcomeLabel(o) {
    if (!o || typeof o !== "object") return "—";
    const metric = typeof o.metric === "string" ? o.metric : "";
    const before = Number(o.before);
    const after = Number(o.after);
    if (!metric || !Number.isFinite(before) || !Number.isFinite(after)) return "—";
    return `${metric} ${before} → ${after}`;
  }

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
      /**
       * Static action surface (AB-1, SPEC §10.91). The page mirrors what
       * /api/capabilities returns: `{ actions: [{name, effect, gate}], generatedFrom }`.
       * Null until live.js fetches the endpoint and stores the payload here.
       * The dashboard is honest about capability only when this is set.
       */
      actionCatalog: null,
      /**
       * 快照面板一次渲染多少张。默认 6：够看清最近几个施工阶段，
       * 又不会让这一块占掉整页的一半以上（实测每张 ~283px 高）。
       */
      stageViewsLimit: 6,
      /** 时间线默认渲染几段（实测 46 段 = 2254px）。 */
      stagesLimit: 8,
      stagesExpanded: false,
      /** 用户点了"展开"就全显示——限制是默认视图，不是删除数据。 */
      stageViewsExpanded: false,
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

      /**
       * 服务器快照里的 `recent` 与本地已有的那份**内容等价**吗？
       *
       * 为什么需要（2026-09-22 实测）：`onSnapshot` 每帧执行 `this.recent = s.recent || []`，
       * 即**每帧换一个新数组**。Alpine 的 `x-for` 看到新数组就把整张表重渲染一遍——
       * 真机量到 **13,000+ 次 DOM 变更/秒**（`ol.events` 一项就 66k/25s），
       * 而 `docH` 随之在 131px 幅度上抖动，浏览器的滚动锚定把这 131px
       * 原样传给用户的滚动位置（"页面自己在滚"）。
       *
       * 事件是**追加**的，所以"长度 + 末尾序号"相同就等价；等价时保持**同一个数组引用**，
       * Alpine 就不会重渲染。
       */
      sameEventList(a, b) {
        const x = Array.isArray(a) ? a : [];
        const y = Array.isArray(b) ? b : [];
        if (x.length !== y.length) return false;
        if (x.length === 0) return true;
        const lx = x[x.length - 1] || {};
        const ly = y[y.length - 1] || {};
        return lx.seq === ly.seq && lx.kind === ly.kind && String(lx.text || "").length === String(ly.text || "").length;
      },

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
            // 图例必须是**稳定**的字符串。执行器把相位写进公司名（`EX rd s4 r27 …`），
            // 于是"公司名"每秒变好几次——把它当图例，图例就在闪，还会让图表每帧重建
            //（ucharts 的形状签名曾包含系列名）。相位本身在别处已经可见（Now / 公司卡）。
            const rawName = (c.info && c.info.name) || "";
            const stableName = /^EX\b/.test(rawName.trim()) ? "" : rawName.trim();
            return {
              name: stableName || `Company ${id}`,
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

      /**
       * 时间线实际渲染的条目——默认只给最新几段。
       *
       * 与 Stage views 同一个理由（2026-09-22 实测）：阶段总结随运行**无限增长**，
       * 真机量到 46 条时该面板 2254px（占整页三分之一），而它只是"已经做了什么"的清单。
       * 默认视图给最新若干段；展开后全给（上限是默认视图，不是丢数据）。
       */
      stagesShown() {
        const all = this.stageList();
        if (this.stagesExpanded) return all;
        return all.slice(0, this.stagesLimit);
      },

      /** 还有多少段没显示。 */
      stagesHiddenCount() {
        const all = (this.stages || []).length;
        return Math.max(0, all - this.stagesShown().length);
      },

      /** Stage snapshots, newest first (the visual record of progress). */
      stageViewsNewestFirst() {
        return (this.stageViews || []).slice().reverse();
      },

      /**
       * 面板实际渲染的快照列表——**默认只给最新几张**。
       *
       * 为什么（2026-09-22 用户实测）：快照每到一个施工相位就多一张，真机量到
       * 24 张时代该面板已经 **4317px**，占整页高度 **57%**（整页 7639px ≈ 8.5 屏），
       * 而每张缩略图只有 ~310px 宽（"每个图表过窄"）。快照数量随运行时长增长，
       * 不设上限的话长局会把页面撑到无法阅读。
       *
       * 默认取最新 `stageViewsLimit` 张；用户点"展开"后全给。
       */
      stageViewsShown() {
        const all = this.stageViewsNewestFirst();
        if (this.stageViewsExpanded) return all;
        return all.slice(0, this.stageViewsLimit);
      },

      /** 还有多少张没显示（0 表示没有可展开的）。 */
      stageViewsHiddenCount() {
        const all = (this.stageViews || []).length;
        return Math.max(0, all - this.stageViewsShown().length);
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
            // R2: 经验不再分 do/dont（那是指令），而是带一条**实测读数**。
            // 读数缺失时显示 “—”，不能默认成 0（缺报 ≠ 0）。
            outcome: outcomeLabel(l && l.outcome),
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

      /**
       * `x-for` 迭代用的**保证是数组**的访问器（D45）。
       *
       * `memoryInEffect()` 目前总是返回对象，所以 `memoryInEffect().lessons` 是安全的；
       * 但"目前恰好安全"不是契约——一旦那个函数为"没数据"返回 null（`actionSurface()`
       * 就是这么做的，而且是对的），模板就会抛 Alpine 表达式错误。
       * 统一规则：**`x-for` 只迭代"保证是数组"的东西**，可空判断留在视图模型里。
       */
      memoryLessons() {
        return this.memoryInEffect().lessons;
      },

      memoryStrategies() {
        return this.memoryInEffect().strategies;
      },

      /**
       * Action surface panel view (AB-1 dashboard mirror).
       *
       * Pure derivation over `this.actionCatalog`:
       *   - Normalises each action into a row with a stable key (Alpine :key)
       *     and a human-readable badge for the read/write split.
       *   - Counts writes (changes game state) and conditional (gated) actions
       *     so the header can summarize the shape at a glance.
       *
       * Returns null when no catalog is loaded: the panel must stay hidden,
       * not render an empty list, because a UI that says "no actions exist"
       * when the server has simply not been queried is a capability lie.
       */
      actionSurface() {
        const c = this.actionCatalog;
        if (!c || !Array.isArray(c.actions) || c.actions.length === 0) return null;
        let writes = 0;
        let conditional = 0;
        const actions = c.actions.map((a) => {
          const isWrite = a && a.effect === "write";
          if (isWrite) writes++;
          const gate = a && a.gate;
          if (gate && typeof gate === "object") conditional++;
          return {
            name: a && a.name ? String(a.name) : "",
            effect: isWrite ? "write" : "read",
            // The badge text is the only thing telling the operator "this
            // changes the game state" — without it, the read/write split is
            // invisible. Keep the wording operator-facing, not agent-facing.
            effectLabel: isWrite ? "changes game state" : "read-only",
            badgeClass: isWrite ? "tag-write" : "tag-read",
            gateKey: gate && typeof gate === "object" ? (gate.key || null) : null,
            gateReason: gate && typeof gate === "object" ? String(gate.reason || "") : "",
            // Unique-per-row key for Alpine's x-for :key. Using the action name
            // (the catalog has no duplicates; actionCatalog() asserts this).
            key: a && a.name ? String(a.name) : `a${Math.random()}`,
          };
        }).filter((row) => row.name);
        if (actions.length === 0) return null;
        return {
          actions,
          writes,
          conditional,
          total: actions.length,
          summary: `${actions.length} action(s) · ${writes} change game state · ${conditional} conditional`,
        };
      },

      /**
       * The rows for `x-for` — **永不为 null**。
       *
       * 为什么需要这一个额外函数（真机 CDP 探针抓到的 bug）：`actionSurface()` 在目录
       * 还没加载时返回 `null`（这是对的："没加载" 不能渲染成 "0 个动作"），
       * 但 `<template x-for="a in actionSurface().actions">` 会**独立求值**——
       * `x-show` 的 false 拦不住它——于是每次页面加载都抛
       * `Cannot read properties of null (reading 'actions')`（Alpine 表达式错误 + TypeError）。
       *
       * 规则：**`x-for` 绝不能穿过可空表达式**。可见性用 `actionSurface()`，
       * 迭代用这个永远返回数组的函数。
       */
      actionRows() {
        const s = this.actionSurface();
        return s ? s.actions : [];
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
