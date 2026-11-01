/* Live page — Alpine view model.
 *
 * 职责: 把 Live 页的**全部推导**集中为可测的纯逻辑：
 *   哪些 KPI 属于"结果"、哪些属于"成本"，现金曲线怎么取点，token 怎么拆成堆叠柱，
 *   事件怎么过滤/计数，空态该说什么，以及"现在在做什么"的摘要。
 *   模板只做声明式渲染，没有 if/else 业务判断。
 *
 * 为什么这样分层（docs/FRONTEND.md §3.4 阶段 4）:
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

  /**
   * Transport headline (D6c): counts when known, "not measured" when absent.
   *
   * `undefined` is not zero: a backend that cannot report retries (the bare
   * Agent path) must not be shown as "clean" - that would be a claim we did not
   * measure. Only the harness reports these today.
   */
  function wireHeadline(totals) {
    if (totals.retries === undefined && totals.faults === undefined) return "not measured";
    const n = (Number(totals.retries) || 0) + (Number(totals.faults) || 0);
    return n === 0 ? "clean" : `${n} issue(s)`;
  }

  /** Last retry/fault message, or the fact that there was none / no data. */
  function wireHint(t) {
    const issues = (t && t.recentRuntimeIssues) || [];
    if (issues.length) {
      const last = issues[issues.length - 1];
      return `${last.kind}: ${last.message}`;
    }
    const known = !!(t && t.totals && t.totals.retries !== undefined);
    return known ? "no retries or faults" : "backend reports no wire data";
  }


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

  /**
   * Token composition series — **最大分离的四个色相**。
   *
   * 为什么改（2026-09-23 用户报告"图例选择差、颜色区分度低，看不清"）：
   * 原来 `Input #5fb3ff`（蓝）与 `Cache read #56d4dd`（青）在深色底上几乎同色，
   * 堆叠里根本分不清哪一层是哪一个。现在四色相在色环上互相远离：
   * 蓝 / 绿 / 琥珀 / 紫。
   */
  const TOKEN_SERIES = [
    { name: "Input", key: "input", color: "#5fb3ff" },
    { name: "Output", key: "output", color: "#7bc96f" },
    { name: "Reasoning", key: "reasoning", color: "#c3a6ff" },
    { name: "Cache read", key: "cacheRead", color: "#e5c07b" },
  ];

  /**
   * 线路表的列（顺序 = 渲染顺序；`id` 同时是排序键）。
   *
   * 为什么这张表值得存在（用户："为什么没有交通线的统计"）：GS 早就在上报逐线路读数
   * （`route-stats`），账本也知道每条线的两端城镇——数据一直有，只是**从来没被发到页面**。
   */
  const ROUTE_COLUMNS = [
    { id: "job", label: "Route", align: "left" },
    { id: "endpoints", label: "Endpoints", align: "left" },
    { id: "vehicles", label: "Veh", align: "num" },
    { id: "waiting", label: "Waiting", align: "num" },
    { id: "income", label: "Income / day", align: "num" },
    { id: "profit", label: "Profit YTD", align: "num" },
  ];

  /** 可排序的列（`endpoints` 是文本，排序无意义）。 */
  const ROUTE_SORTABLE = ["job", "vehicles", "waiting", "income", "profit"];

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

  /** 合并两段"类型 → 数量"（多公司时求和），保持按数量降序。 */
  function mergeParts(a, b) {
    const by = new Map();
    for (const x of [...(a || []), ...(b || [])]) by.set(x.label, (by.get(x.label) || 0) + x.n);
    return [...by.entries()].map(([label, n]) => ({ label, n })).sort((x, y) => y.n - x.n);
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
      /**
       * 暂停归因（来自 snapshot.control）：`{pausedByAgent, agentPausedAt}`。
       *
       * 为什么页面要读它而不只看 `run.pausedBy`（2026-09-25 真机事故）：agent 调
       * `set_pause` 时，supervisor 的 `run.state` 可能还没被更新（CLI 单跑没有
       * supervisor；serve 也要靠新接线才同步）。**"谁让它停的"是后端记录的事实**，
       * 页面必须以它为准，否则用户只会看到"进程活着但没进展"这种无法行动的结论。
       */
      control: null,
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
      /**
       * 每 5 s 递增的时钟。为什么不是 `Date.now()` 直接进模板：模板只在依赖的
       * 响应式数据变化时重绘，而"现在"不是响应式的——`nowTick` 让运行时长
       * 自己往前走，且不引入忙轮询（2026-11-01：旧实现的 `startedAt` 从未被赋值，
       * 于是运行中顶栏的 Elapsed 永远是 "—"）。
       */
      nowTick: Date.now(),
      /**
       * 线路事实（后端每个 snapshot 帧都带）。形状见 `toWireSnapshot` 的 extras：
       * `{job, vehicles, waiting, profitYtd, incomePerDay|null, townA?, townB?}`。
       */
      routes: [],
      /**
       * 线路数据是否**可得**。false = 这个 run 没有 GS 通道（watch 模式）。
       * 必须与 `routes: []` 区分开：**"不可得"不是"零条线路"**。
       */
      routesAvailable: false,
      /**
       * 候选城镇（Bridge GS 取样：**人口最多的前 10 个**，`town_list`）。
       * 形状：`[{id, population, x, y}]`，已按人口降序。
       */
      towns: [],
      /**
       * 地图上的城镇**总数**（GS 的 `tlist.Count()`）。null = 未收到。
       * 与 `towns.length` 分开：前者是地图事实，后者只是样本量。
       */
      townsTotal: null,
      /** 城镇数据是否**可得**。false = 这个 run 没有 GS 通道（watch 模式）。 */
      townsAvailable: false,
      /** 产业样本（GS 按产量取样）与总数。 */
      industries: [],
      industriesTotal: null,
      /** 按货种聚合的上月原始计数（产业侧，所有公司）。 */
      cargoTotals: [],
      /** 产业/货种是否可得（与城镇同源：GS 通道）。 */
      industryAvailable: false,
      /** 本公司口径运量（`GSCargoMonitor` 累计 + 游戏季度总量）或 null。 */
      companyCargo: null,
      companyCargoAvailable: false,
      /** 线路表排序（默认按每日收益，null 排最后）。 */
      routeSortKey: "income",
      routeSortDir: "desc",
      /**
       * 详情抽屉：null（关）| "fleet" | "cash" | "income" | "routes"。
       * 只呈现**确实存在**的数据；没有载荷的卡片不做成可点（假按钮 = bug）。
       */
      drawer: null,

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
      /** 线路表的列定义（模板迭代它，不硬编码列）。 */
      routeColumns: ROUTE_COLUMNS,

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

      /**
       * The decisions' positions on the cash curve (for the vertical markers).
       *
       * 纯函数在 LiveView.decisionMarkers 里（可单测）；这里只把两边的数据递过去。
       */
      decisionMarkers() {
        return window.LiveView.decisionMarkers(this.primaryHistory(), (this.timeline && this.timeline.rows) || []);
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
       * 公司价值是否已经有意义。
       *
       * 为什么需要这条判定（2026-09-22 真机看截图发现）：管理协议 `ServerCompanyEconomy`
       * **只发 `old_economy[]`**（两个历史财政年度），**不发当前值**。所以"公司价值"实际是
       * **上一个财年结束时**的值；而在**第一个财年结束之前**，它是 OpenTTD 的初始占位值 **1**。
       * 于是仪表盘长期显示 `£1`（同期现金 £226k、贷款 £300k）——这是**在说谎**：
       * 把一个占位值当成当前价值。规则：**没测到的值不显示数字**（AGENTS §2 的精神）。
       */
      companyValueKnown(raw) {
        const v = Number(raw);
        return Number.isFinite(v) && v > 1;
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
          { k: "Cash", v: U.fmtMoney(e.money), delta: delta(money), deltaFmt: "money", spark: "money", drawerId: "cash" },
          {
            k: "Income / yr",
            v: U.fmtMoney(e.income),
            delta: delta(income),
            deltaFmt: "money",
            spark: "income",
            drawerId: "income",
          },
          {
            k: "Value (last yr)",
            v: this.companyValueKnown(e.companyValue) ? U.fmtMoney(e.companyValue) : "—",
            hint: this.companyValueKnown(e.companyValue) ? undefined : "not reported until the first year ends",
          },
          { k: "Loan", v: U.fmtMoney(e.loan) },
          {
            k: "Fleet",
            v: `${U.fmtInt(s.vehicles ?? 0)} veh`,
            hint: `${U.fmtInt(s.stations ?? 0)} stations`,
            // 「车队在哪条线上」就是这里最该能展开的事实——数据已经有了（routes）。
            drawerId: "fleet",
          },
        ];
      },

      /** Cost KPIs: "what is this costing me?". */
      costKpis() {
        const t = this.telemetry;
        const u = (t && t.usage && t.usage.total) || {};
        const totals = (t && t.totals) || {};
        const failRate = totals.toolCalls ? totals.toolFailures / totals.toolCalls : 0;
        return [
          {
            k: "Tokens used",
            v: U.fmtTok(u.totalTokens),
            hint: U.fmtCostKnown(u.costTotal, t && t.brain ? t.brain.costKnown : undefined),
          },
          { k: "Decisions", v: U.fmtInt(totals.decisions) },
          {
            k: "Tool calls",
            v: U.fmtInt(totals.toolCalls),
            hint: totals.toolFailures ? `${U.fmtInt(totals.toolFailures)} failed (${U.fmtPct(failRate)})` : "none failed",
          },
          // D6c: transport health. A retried call carries the same tokens and the
          // same steps as a clean one, so without this line "this run was slow and
          // expensive" can only be blamed on the model. `undefined` means the
          // backend cannot report it - that is not the same as "clean".
          {
            k: "Wire",
            v: wireHeadline(totals),
            hint: wireHint(this.telemetry),
          },
        ];
      },

      /** Whether there is any company at all (drives the empty state). */
      companiesEmpty() {
        return Object.keys(this.companies || {}).length === 0;
      },

      /**
       * 冷启动：这一局还什么都没发生。
       *
       * 为什么需要（2026-11-01 审计 A1/A3）：空页会铺 8 个 `—` 和一个红色
       * `world frozen`，首屏读起来像"坏了"，而事实只是"还没开跑"。数据区在冷启动
       * 时**不占版面**（不是画一堆空槽），由三步引导回答"我现在能做什么"。
       *
       * 判据只看**已经发生过的事**，不猜：有局在跑、有世界读数、或有过 turn，都不是冷启动。
       */
      coldStart() {
        const runState = (this.run && this.run.state) || "idle";
        if (runState !== "idle") return false;
        if (!this.companiesEmpty()) return false;
        const steps = Array.isArray(this.steps) ? this.steps : [];
        if (steps.length) return false;
        const t = this.telemetry || {};
        if (Number(t.turns) > 0) return false;
        return true;
      },

      /**
       * 冷启动的三步引导：① 选模型 → ② 设上限 → ③ 开跑。
       *
       * 为什么是三步而不是一句 "no run is active"：用户要的是**下一步动作**，
       * 不是对空页的解释。第 1、2 步是链接（配置在另一页），第 3 步是按钮本身
       * （`start: true`，模板据此渲染 `startRun('agent')`）。
       *
       * 何时**不**显示：
       *   - 没有 run 控制（`--watch`）：页面不能开跑，说了就是假承诺；
       *   - 已经有一局在跑：引导会与真实读数抢版面；
       *   - 启动失败：错误卡是此刻唯一值得读的东西，引导会让它被埋掉。
       */
      startGuide() {
        const n = this.notice();
        const runState = (this.run && this.run.state) || "idle";
        const show = Boolean(this.runControl) && runState === "idle" && n.show && n.kind !== "err";
        if (!show) return { show: false, steps: [] };
        return {
          show: true,
          steps: [
            {
              n: 1,
              title: "Choose the model",
              body: "The provider and model decide how the agent thinks. Keys live in a file outside the repository, never in it.",
              action: "Open Configure",
              href: "/configure",
              start: false,
            },
            {
              n: 2,
              title: "Set the limits",
              body: "Seed, game days, token cap and cost cap are optional — an empty field keeps the server's own setting.",
              action: "Open run settings",
              href: "/configure#run-settings",
              start: false,
            },
            {
              n: 3,
              title: "Start the run",
              body: "Start agent plays with that model. Observe only records what the built-in AI does, with no model calls at all.",
              action: "Start agent",
              href: "",
              start: true,
            },
          ],
        };
      },

      /**
       * 引导步骤（**永远返回数组**）。
       *
       * 为什么单独一个函数：`x-for` 会独立求值，而 `startGuide()` 在数据到达前可能
       * 没有 `steps`，Alpine 会报 "x-for 穿过可空表达式"（D45，与 `healthTiles` 同一个坑）。
       */
      startGuideSteps() {
        const g = this.startGuide();
        return Array.isArray(g.steps) ? g.steps : [];
      },

      /**
       * 本局会话 id（顶栏移到页内之后由这里统一取）。
       *
       * 为什么不是直接读 `this.sessionId`：那个字段从来没人写（与 `startedAt` 同一类
       * 缺陷——注释说"由 live.js 灌入"，实际没有灌）。权威来源是遥测快照，
       * serve 模式下还有 supervisor 的 `run.sessionId`。
       */
      runSessionId() {
        for (const raw of [this.telemetry && this.telemetry.sessionId, this.run && this.run.sessionId, this.sessionId]) {
          if (typeof raw === "string" && raw) return raw;
        }
        return null;
      },

      /**
       * 服务端记录的本局开始时间。
       *
       * 两个来源，按可信度排：`run.startedAt`（supervisor，serve 模式控制运行的那一侧）、
       * `telemetry.startedAt`（遥测快照，agent/watch 直接跑时**没有** `/api/run`）。
       * 都没有就返回 null —— 页面上写 "—"，不编一个 0 秒。
       */
      runStartedAt() {
        for (const raw of [this.run && this.run.startedAt, this.telemetry && this.telemetry.startedAt]) {
          const at = Number(raw);
          if (Number.isFinite(at) && at > 0) return at;
        }
        return null;
      },

      /**
       * 运行时长。窗口没有开始时间时返回 "—"（**没测到**，不是 0 秒）。
       * 浏览器时钟落后于服务端时不出现负数。
       */
      elapsedText(nowMs) {
        const at = this.runStartedAt();
        if (at === null) return "—";
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        return U.fmtDuration(Math.max(0, now - at));
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
            value: `value ${this.companyValueKnown(e.companyValue) ? U.fmtMoney(e.companyValue) : "—"} · loan ${U.fmtMoney(e.loan)}`,
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
      /**
       * 区间读数用的标签：**日**精度（轴标签是月，读数要给更细的那一层）。
       *
       * 为什么不是"第几个采样点"：那对人没有意义。也不是"天"：x 是采样序号，
       * 一天可能有多个点，写成"76 天"就是编造单位（AGENTS 的诚实规则）。
       * 所以念**首尾采样点各自的日期** —— 是真的，且用户能对照日历。
       */
      cashRangeLabel(i) {
        const first = Object.values(this.companies || {})[0] || {};
        const h = (first.history || [])[i];
        if (!h || h.year == null) return "—";
        const mm = String(h.month ?? 1).padStart(2, "0");
        const dd = String(h.day ?? 1).padStart(2, "0");
        return `${h.year}-${mm}-${dd}`;
      },

      cashLabels() {
        const first = Object.values(this.companies || {})[0] || {};
        return (first.history || []).map((h) =>
          h.year == null ? "—" : `${h.year}-${String(h.month ?? 1).padStart(2, "0")}`,
        );
      },

      /**
       * 该画哪些 token 系列（下标）——**全零的系列不进图，也不占图例**。
       *
       * 为什么（2026-09-23 用户："图例选择差"）：真机长局里 `reasoning` **90 轮恒为 0**，
       * 于是一个永远为零的系列永久占据图例与堆叠空间。零信息量的系列不是"完整"，
       * 是噪声。隐藏后仍会**用一句话说明**（`tokenHiddenNote()`），不静默丢弃。
       *
       * 该下标列表是 `tokenSeries()` 与 `tokenItems()` 的**唯一对齐来源**——
       * 两处各算一次就会漂移，而漂移的表现是"颜色和数值对不上"。
       */
      tokenLiveIndexes() {
        if (this.tokenMetric === "cost") return [0];
        const byTurn = (this.telemetry && this.telemetry.usage && this.telemetry.usage.byTurn) || [];
        const idx = [];
        for (let i = 0; i < TOKEN_SERIES.length; i++) {
          const key = TOKEN_SERIES[i].key;
          if (byTurn.some((r) => num((r.usage || {})[key]) > 0)) idx.push(i);
        }
        // 还没有任何用量 → 保留全部：那种情况该由"空状态"表达，
        // 而不是靠删掉所有系列制造一张空图。
        return idx.length ? idx : TOKEN_SERIES.map((t, i) => i);
      },

      /** 被隐藏的零值系列，用一句可读的话说明（隐藏 ≠ 静默）。 */
      tokenHiddenNote() {
        if (this.tokenMetric === "cost") return "";
        const live = this.tokenLiveIndexes();
        const hidden = TOKEN_SERIES.filter((t, i) => live.indexOf(i) === -1).map((t) => t.name);
        return hidden.length ? `${hidden.join(", ")} = 0 in every turn — hidden` : "";
      },

      /** Series for the per-turn chart. */
      tokenSeries() {
        if (this.tokenMetric === "cost") {
          return [{ name: "Cost", color: "#e5c07b" }];
        }
        return this.tokenLiveIndexes().map((i) => ({ name: TOKEN_SERIES[i].name, color: TOKEN_SERIES[i].color }));
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
        // **同一份**下标列表（见 tokenLiveIndexes）：两处各算一次就会漂移。
        const idx = this.tokenLiveIndexes();
        return byTurn.map((r) => {
          const u = r.usage || {};
          return {
            label: `T${r.turn}`,
            values: isCost ? [num(u.costTotal)] : idx.map((i) => num(u[TOKEN_SERIES[i].key])),
            sub: isCost
              ? `${U.fmtInt(u.totalTokens)} tokens`
              : `${U.fmtInt(u.totalTokens)} tokens in ${U.fmtInt(r.steps)} step(s)`,
          };
        });
      },

      /* ------------------------------ routes ------------------------------ */

      /**
       * 线路表的一行（全部显示串在这里算完，模板只做声明式渲染）。
       *
       * 三条**诚实规则**（本仓库的底线，逐条对应真实事故）：
       *   ① `incomePerDay === null` **不是 0**——它表示"还不可测"（这条线没有车，
       *      或年内天数太少不足以除）。显示 0 会被读成"这条线不赚钱"，那是编造事实。
       *   ② `profitYtd === -1` 表示 GS **读不到**该读数（`route-stats.ts`），显示 `—`，
       *      绝不能显示成"亏损"。
       *   ③ 账本不知道 job 时 `townA/townB` 缺失 → 两端显示 `—`，**不猜**一对城镇。
       */
      routeRows() {
        const list = Array.isArray(this.routes) ? this.routes : [];
        return list.map((r) => {
          const job = num(r.job);
          const vehicles = num(r.vehicles);
          const waiting = num(r.waiting);
          const profitRaw = r.profitYtd === undefined || r.profitYtd === null ? NaN : Number(r.profitYtd);
          const profitKnown = Number.isFinite(profitRaw) && profitRaw !== -1;
          const perDayRaw = r.incomePerDay === undefined || r.incomePerDay === null ? NaN : Number(r.incomePerDay);
          const perDayKnown = Number.isFinite(perDayRaw);
          const hasPair = Number.isFinite(Number(r.townA)) && Number.isFinite(Number(r.townB));
          return {
            key: String(job),
            job,
            // 端点显示**城镇名**（2026-09-25）：`#4 → #8` 看不出是哪两座城，
            // 而"为什么选了这两座"正是复盘第一个要回答的问题。没有名字时回退 `#4`。
            endpoints: hasPair ? `${this.townName(r.townA)} → ${this.townName(r.townB)}` : "—",
            endpointsHint: hasPair ? undefined : "endpoints unknown (not in the route ledger)",
            vehicles: U.fmtInt(vehicles),
            waiting: U.fmtInt(waiting),
            // 去重所需（2026-09-25）：共享车站会让同一辆车/同一批乘客被每条用到该站的
            // 线路各数一次 —— 公司 25 辆车曾被报成 129。有 id 才算得出真数。
            _vehIds: Array.isArray(r.vehiclesIds) ? r.vehiclesIds.map((v) => num(v)).filter((v) => Number.isFinite(v)) : [],
            _endsA: num(r.endsA),
            _endsB: num(r.endsB),
            _waitA: Number.isFinite(Number(r.waitA)) ? Number(r.waitA) : null,
            _waitB: Number.isFinite(Number(r.waitB)) ? Number(r.waitB) : null,
            income: perDayKnown ? U.fmtMoney(perDayRaw) : "—",
            incomeHint: perDayKnown
              ? undefined
              : vehicles === 0
                ? "not measurable — no vehicles on this route"
                : "not measurable yet — the year is too young to divide by",
            profit: profitKnown ? U.fmtMoney(profitRaw) : "—",
            profitHint: profitKnown ? undefined : "not readable (GS could not read it)",
            /** 建好但没车：这是"已建未运营"状态，视觉上要能一眼分辨。 */
            idle: vehicles === 0,
            /* 排序用的原始数值（null = 无值）。模板不碰这些。 */
            _job: job,
            _vehicles: vehicles,
            _waiting: waiting,
            _income: perDayKnown ? perDayRaw : null,
            _profit: profitKnown ? profitRaw : null,
          };
        });
      },

      /**
       * 排好序的行。
       *
       * **null 永远排最后**，与升降序无关：`null` 不是"最小值"，它是"没有值"。
       * 升序时把"不可测"排在榜首，会被读成"最差的线路排在前面"——那正好相反。
       */
      routesSorted() {
        const field = { job: "_job", vehicles: "_vehicles", waiting: "_waiting", income: "_income", profit: "_profit" }[
          this.routeSortKey
        ];
        const key = field || "_income";
        const dir = this.routeSortDir === "asc" ? 1 : -1;
        return this.routeRows()
          .slice()
          .sort((a, b) => {
            const av = a[key];
            const bv = b[key];
            const an = av === null || av === undefined;
            const bn = bv === null || bv === undefined;
            if (an && bn) return a._job - b._job;
            if (an) return 1;
            if (bn) return -1;
            if (av === bv) return a._job - b._job;
            return (av < bv ? -1 : 1) * dir;
          });
      },

      /** 点列表头：同一列反向，换列则用该列的默认方向。 */
      sortRoutes(id) {
        if (ROUTE_SORTABLE.indexOf(id) === -1) return;
        if (this.routeSortKey === id) {
          this.routeSortDir = this.routeSortDir === "desc" ? "asc" : "desc";
          return;
        }
        this.routeSortKey = id;
        this.routeSortDir = id === "job" ? "asc" : "desc";
      },

      /** 列头上的排序指示（空串 = 当前未按此列排序）。 */
      routeSortMark(id) {
        if (this.routeSortKey !== id) return "";
        return this.routeSortDir === "desc" ? "▼" : "▲";
      },

      /** 列表头是否可点（`endpoints` 是文本，不排）。 */
      routeColumnSortable(id) {
        return ROUTE_SORTABLE.indexOf(id) !== -1;
      },

      /** 汇总条：几条线、几辆在跑、多少人在等。 */
      /**
       * **为什么没有进展**——暂停归因与停滞告警。
       *
       * 为什么需要（2026-09-23 真机事故）：一个长跑的最后一次决策就是 agent 自己的
       * `set_pause`；游戏冻结、循环 5 小时没动。页面上只有 `paused` 两个字，owner 点
       * Pause 时状态早已是 paused——**"谁让它停的、为什么不动了"完全无从判断**。
       * 只报"停/跑"两种状态，等于把"agent 自己停的"和"人按的"混为一谈。
       */
      controlNote(nowMs) {
        const r = this.run || {};
        const c = this.control || {};
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();

        // ① supervisor 明确知道暂停（页面按的，或已归因给 agent）
        if (r.state === "paused") {
          const by =
            r.pausedBy === "agent"
              ? "the agent itself (set_pause)"
              : r.pausedBy === "dashboard"
                ? "the dashboard"
                : "unknown cause";
          const ago = r.pausedAt ? ` · ${U.fmtAgo(r.pausedAt)} ago` : "";
          return `Paused by ${by}${ago}. While the world is paused the decision loop cannot fire: no new game events, and game-day progress stalls, so no trigger can open.`;
        }

        // ② **世界事实**：agent 自己按了暂停（快照记录，不依赖 run.state）
        if (c.pausedByAgent === true) {
          const at = Number(c.agentPausedAt);
          const ago = Number.isFinite(at) && at > 0 ? ` · ${U.fmtAgo(at)} ago` : "";
          return (
            `Blocked — the agent paused the world itself (set_pause${ago}). ` +
            "A frozen world produces no game-day progress, so no decision can be triggered: " +
            "the process is alive but idle **by that pause**, not by thinking. " +
            "Next: press Resume (or wait for the agent to unpause)."
          );
        }

        // ③ 通道静默（连事件都没有）——这不是"世界停了"，是**数据没到**：多半进程/通道没了。
        if (!this.channelAlive(now)) {
          return (
            "No run data is arriving (no events for over a minute and no recent activity) — " +
            "the run's process or its channel looks gone. Next: check whether the run is still " +
            "alive in the terminal, then Restart it from the dashboard."
          );
        }

        const lastAgent = this.lastAgentActivityAt();
        const agentIdleMin = Number.isFinite(lastAgent) ? (now - lastAgent) / 60000 : Infinity;
        // 有没有 date 证据：`worldAdvancing()` 在**没有证据**时也返回 true（不猜），
        // 所以判定"世界停了"必须显式要求"见过 date、且它已经旧了"。
        const hasDateEvidence = this.lastDateEventAt() !== null;

        // ④ 世界还在推进（**有 date 证据**）→ 正常在跑；agent 长时间不动则提示在等决策窗口
        if (hasDateEvidence && this.worldAdvancing(now)) {
          if (agentIdleMin > 10) {
            return (
              `The world is still advancing, but the agent has not acted for ${Math.round(agentIdleMin)} min — ` +
              "it is waiting for the next decision window (or a model call is hung). " +
              "Next: give it a few more minutes, then Stop if it stays silent."
            );
          }
          return "";
        }

        // 没有 date 证据（刚重载 / 缓冲空）→ 不下结论
        if (!hasDateEvidence) return "";

        // ⑤ 世界不推进，但 agent 刚有活动 → 它还在这一轮里（模型调用/工具），**不是停滞**
        if (agentIdleMin <= 10) {
          return (
            `The game date has not advanced, but the agent was active ${U.fmtAgo(lastAgent)} ago — ` +
            "it is still inside a turn (model call or tool), not stalled. No action needed yet."
          );
        }

        // ⑥ 世界不推进 + agent 久无活动 + 通道仍在收数据 + 未暂停 → 真的停滞
        const since = Number.isFinite(lastAgent) ? U.fmtAgo(lastAgent) : "a long while";
        return (
          `The world has not advanced and the agent has been idle for ${since}, with no recorded pause — ` +
          'this is stalled, not "still working". Next: check the run log, then Resume (if the game is frozen) ' +
          "or Stop and start a new run."
        );
      },

      /**
       * 通道是否还在收数据（**最近**有没有任何事件）。
       *
       * 与 `worldAdvancing` 分开：事件是 company/gs 也在发的，所以"有事件但没有 date"
       * 才是世界停了；"连事件都没有"是**通道/进程**的问题 —— 两者的下一步动作不同。
       * 刚重载、缓冲为空时返回 true（没有证据就不下结论）。
       */
      channelAlive(nowMs) {
        const list = Array.isArray(this.recent) ? this.recent : [];
        if (!list.length) return true;
        let newest = null;
        for (const e of list) {
          const ts = e ? Number(e.ts) : NaN;
          if (Number.isFinite(ts) && (newest === null || ts > newest)) newest = ts;
        }
        if (newest === null) return true;
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        return now - newest <= 90 * 1000;
      },

      /** 最近一次 `date` 事件的墙钟时间（世界是否还在推进的直接证据）。 */
      lastDateEventAt() {
        const list = Array.isArray(this.recent) ? this.recent : [];
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i];
          if (e && e.kind === "date" && Number.isFinite(Number(e.ts))) return Number(e.ts);
        }
        return null;
      },

      /**
       * 世界是否还在推进（最近 90 s 内有 `date` 事件）。
       *
       * 没有 `date` 证据时（缓冲空/刚重载）返回 true —— **"没看见"不等于"没推进"**，
       * 否则页面会在每次重载时闪一条假告警。有非 date 事件但很旧 ⇒ 世界确实停了。
       */
      worldAdvancing(nowMs) {
        const at = this.lastDateEventAt();
        if (at === null) return true;
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        return now - at <= 90 * 1000;
      },

      /**
       * 世界推进速率（游戏日 / 墙钟分钟）+ 是否在推进。
       *
       * 为什么值得单独可视化：用户看到"日期不动"时，第一反应是"卡住了"，但真实速率
       * 可能是**正常偏慢**。用 `date` 事件的墙钟间隔算速率，就把"冻结"与"慢"分开。
       * 只有一个样本时速率是 **null**（不是 0）—— 0 会说成"一天都没走"。
       */
      worldRate(nowMs) {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        const list = (Array.isArray(this.recent) ? this.recent : []).filter(
          (e) => e && e.kind === "date" && Number.isFinite(Number(e.ts)),
        );
        if (!list.length) return { advancing: false, daysPerMin: null, lastAt: null, samples: 0 };
        const lastAt = Number(list[list.length - 1].ts);
        // 只用最近 5 分钟的样本算速率：更早的样本会让"刚恢复推进"看起来仍然很慢。
        const recent = list.filter((e) => now - Number(e.ts) <= 5 * 60 * 1000);
        let daysPerMin = null;
        if (recent.length >= 2) {
          const first = Number(recent[0].ts);
          const rawOf = (e) => {
            const p = e.payload || {};
            const raw = Number(p.raw);
            if (Number.isFinite(raw)) return raw;
            // 没有 raw 就用 年/月/日 折算（OpenTTD 的日期从 1920-01-01 连续计数）
            const y = Number(p.year), m = Number(p.month), d = Number(p.day);
            if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) return (y - 1920) * 372 + (m - 1) * 31 + d;
            return null;
          };
          const r0 = rawOf(recent[0]);
          const r1 = rawOf(recent[recent.length - 1]);
          const span = (Number(recent[recent.length - 1].ts) - first) / 60000;
          if (r0 !== null && r1 !== null && span > 0) daysPerMin = Math.round(((r1 - r0) / span) * 10) / 10;
        }
        return { advancing: now - lastAt <= 90 * 1000, daysPerMin, lastAt, samples: recent.length };
      },

      /**
       * 车队 / 车站的**类型构成**（数据一直在 `stats.breakdown`，此前从未显示）。
       *
       * 只列非零类型：把 0 也画进堆叠条会让人以为"有一辆火车"。没有 breakdown 时
       * `parts` 为空而不是猜（总数仍如实显示）。
       */
      fleetMix() {
        const ids = Object.keys(this.companies || {});
        const labels = { train: "Train", truck: "Truck", bus: "Bus", aircraft: "Air", ship: "Ship" };
        const sum = (breakdown) => {
          const src = breakdown && typeof breakdown === "object" ? breakdown : {};
          const parts = Object.keys(labels)
            .map((k) => ({ label: labels[k], n: Number(src[k]) || 0 }))
            .filter((p) => p.n > 0)
            .sort((a, b) => b.n - a.n);
          const total = parts.reduce((a, p) => a + p.n, 0);
          return { parts: parts.map((p) => ({ ...p, pct: total > 0 ? Math.round((p.n / total) * 100) : null })), total };
        };
        let vehicles = { parts: [], total: 0 };
        let stations = { parts: [], total: 0 };
        for (const id of ids) {
          const c = this.companies[id] || {};
          const st = c.stats || {};
          const v = sum(st.breakdown);
          const s = sum(st.stationBreakdown);
          vehicles = {
            total: vehicles.total + (Number(st.vehicles) || v.total),
            parts: mergeParts(vehicles.parts, v.parts),
          };
          stations = {
            total: stations.total + (Number(st.stations) || s.total),
            parts: mergeParts(stations.parts, s.parts),
          };
        }
        const withPct = (x) => ({ ...x, parts: x.parts.map((p) => ({ ...p, pct: x.total > 0 ? Math.round((p.n / x.total) * 100) : null })) });
        return { vehicles: withPct(vehicles), stations: withPct(stations), companies: ids.length };
      },

      /**
       * 公司绩效（OpenTTD 的 0–255 评分）：去年 vs 去年前年。
       * 字段缺失 → null（不是 0 分）。
       */
      performance() {
        const ids = Object.keys(this.companies || {});
        let last = null;
        let prev = null;
        for (const id of ids) {
          const e = (this.companies[id] || {}).economy || {};
          const l = Number(e.performanceLastYear);
          const p = Number(e.performancePrevYear);
          if (Number.isFinite(l)) last = l;
          if (Number.isFinite(p)) prev = p;
        }
        // 首个财年结束前，游戏报的是**占位值**（companyValue 是 1，已记在 SPEC §10.95；
        // performance 在真机实测里先是 0、随后 1，同属占位族）—— 那是"尚无评分"，
        // 不是"0 分"也不是"1 分"。画成 0/255 是在编造事实。
        const placeholder = (v) => v !== null && v <= 1;
        if ((last === null || placeholder(last)) && (prev === null || placeholder(prev))) {
          return { last: null, prev: null, delta: null, max: 255, known: false };
        }
        const delta = last !== null && prev !== null ? last - prev : null;
        return { last, prev, delta, max: 255, known: true };
      },

      /**
       * 健康条瓦片（**永远返回数组**）。
       *
       * 为什么单独一个函数：`x-for="t in runHealth().tiles"` 会被 Alpine 守卫判为
       * "x-for 穿过可空表达式"（D45：x-for 独立求值，`runHealth()` 在数据到达前
       * 可能没有 tiles → 表达式错误）。所以模板只迭代这个永不为 null 的数组。
       */
      healthTiles() {
        const h = this.runHealth();
        return Array.isArray(h.tiles) ? h.tiles : [];
      },

      /** 构成行（带颜色，供堆叠条使用）。颜色取自 ucharts 的调色板，保持一致。 */
      mixRows() {
        const m = this.fleetMix();
        const colors = ["#f2a33c", "#5fb3ff", "#9adf7b", "#c39bff", "#ff8f8f"];
        const withColor = (x) => ({
          total: x.total,
          parts: x.parts.map((p, i) => ({ ...p, color: (U.pickColor ? U.pickColor(i) : colors[i % colors.length]) })),
        });
        return [
          { k: "Vehicles", ...withColor(m.vehicles) },
          { k: "Stations", ...withColor(m.stations) },
        ];
      },

      /**
       * 运行健康条：4 个瓦片（世界 / agent / 游戏日期 / 决策）+ 状态 + 下一步。
       *
       * 为什么是"条"而不是一句告警：2026-09-25 的教训是**一句通用文字无法行动**
       * （"进程活着但没进展"既可能是 agent 自己停了，也可能是模型慢、通道死）。
       * 瓦片让状态一眼可读，`action` 给出该做什么。
       */
      /**
       * 数据新鲜度（2026-09-25 用户："Fleet Detail 不会自动更新"）。
       *
       * 为什么单独一行：面板"数字没变"有两种可能——① 世界真的没变（事实），
       * ② 数据早就没在流（缺陷）。不给这个信号，用户只能靠猜，而猜错的方向是
       * "相信页面"。所以把"最后一帧数据多久前"明写出来。
       *
       * 纯函数：返回 `{text, tone}`。tone: ok(<15s) / warn(<60s) / bad(≥60s) / dim(未知)。
       */
      dataAge(nowMs) {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        const at = Number(this.lastFrameAt);
        if (!Number.isFinite(at) || at <= 0) {
          // 没收到过帧 = **不知道**，不是"0 秒前"（AGENTS 的 null≠0）
          return { text: this.link === "live" ? "no data frame yet" : "—", tone: "dim" };
        }
        const secs = Math.max(0, Math.round((now - at) / 1000));
        if (secs < 15) return { text: `data ${U.fmtAgo(at)}`, tone: "ok" };
        if (secs < 60) return { text: `data ${U.fmtAgo(at)}`, tone: "warn" };
        return { text: `no data for ${secs}s`, tone: "bad" };
      },

      runHealth(nowMs) {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        const r = this.run || {};
        const c = this.control || {};
        const rate = this.worldRate(now);
        const lastAgent = this.lastAgentActivityAt();
        const agentIdleMin = Number.isFinite(lastAgent) ? Math.max(0, Math.round((now - lastAgent) / 60000)) : null;
        const turns = (this.telemetry && this.telemetry.turns) || 0;
        const date = this.date;
        const dateText = date ? `${date.year}-${String(date.month || 1).padStart(2, "0")}-${String(date.day || 1).padStart(2, "0")}` : "—";
        const tiles = [
          {
            k: "World",
            v: rate.advancing ? (rate.daysPerMin === null ? "moving" : `${rate.daysPerMin}/min`) : "frozen",
            // 暂停导致的冻结是**已知原因**，用警告而不是告警色：把最亮的颜色
            // 留给"没有原因的不动"（2026-11-01 审计 A3）。
            state: rate.advancing
              ? rate.daysPerMin !== null && rate.daysPerMin < 0.5
                ? "warn"
                : "ok"
              : r.state === "paused" || c.pausedByAgent === true
                ? "warn"
                : "bad",
            hint: rate.advancing ? "game days per wall-clock minute (from date events)" : "no new game date in the last 90s",
          },
          {
            k: "Agent",
            v: agentIdleMin === null ? "—" : agentIdleMin < 1 ? "active" : `${agentIdleMin}m ago`,
            state: agentIdleMin === null ? "warn" : agentIdleMin <= 10 ? "ok" : "warn",
            hint: "time since the last assistant message or tool call",
          },
          { k: "Game date", v: dateText, state: rate.advancing ? "ok" : "bad", hint: "world calendar" },
          {
            k: "Decision",
            v: `${turns}`,
            state: rate.advancing && (agentIdleMin === null || agentIdleMin <= 10) ? "ok" : "warn",
            hint: "decisions made in this run",
          },
        ];
        // 状态与"下一步"复用 controlNote 的分因（同一判据，不写两套）。
        const note = this.controlNote(now);
        let state = "ok";
        if (r.state === "paused" || c.pausedByAgent === true) state = "blocked";
        else if (!this.channelAlive(now)) state = "bad";
        else if (!rate.advancing) state = agentIdleMin !== null && agentIdleMin <= 10 ? "warn" : "bad";
        else if (agentIdleMin !== null && agentIdleMin > 10) state = "warn";
        return { state, tiles, action: note, rate };
      },

      /** agent 最近一次活动（telemetry 的权威值；缺失时退回 step 时间戳）。 */
      lastAgentActivityAt() {
        const t = this.telemetry || {};
        if (Number.isFinite(Number(t.lastActivityAt)) && Number(t.lastActivityAt) > 0) return Number(t.lastActivityAt);
        const steps = Array.isArray(this.steps) ? this.steps : [];
        for (let i = steps.length - 1; i >= 0; i--) {
          const s = steps[i];
          if (s && Number.isFinite(Number(s.ts))) return Number(s.ts);
        }
        return null;
      },

      /**
       * 运行中但长时间没有决策 = 停滞（不是"还在忙"）。
       *
       * 阈值取 10 分钟：正常间隔是游戏日尺度（月/季），10 分钟墙钟远超任何正常节奏。
       * `nowMs` 可注入，便于单测（纯函数不给测试留后门就得靠等时间）。
       */
      stalled(nowMs) {
        const t = this.telemetry || {};
        const r = this.run || {};
        if (r.state !== "running") return false;
        const last = Number(t.lastActivityAt);
        if (!Number.isFinite(last) || last <= 0) return false;
        const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
        return now - last > 10 * 60 * 1000;
      },

      /**
       * 城镇行（人口降序）。位置/人口都是世界事实，**不含任何建议**
       * （harness 边界：给事实与因果，不给策略）。
       */
      /**
       * 城镇 id → 名字（2026-09-25 用户：线路端点只显示 `#4 → #8`）。
       *
       * 为什么：id 是给机器看的，复盘时第一个问题是"这是哪两座城"。`GSTown.GetName`
       * 已在真机验证存在，GS 现在把名字一起发上来；**没有名字时回退显示 id**，
       * 不编造名字（空串/缺失 → `#4`）。
       */
      townName(id) {
        const n = Number(id);
        if (!Number.isFinite(n)) return "—";
        const list = Array.isArray(this.towns) ? this.towns : [];
        const hit = list.find((t) => Number(t.id) === n);
        const name = hit && typeof hit.name === "string" ? hit.name.trim() : "";
        return name || `#${n}`;
      },

      townsRows() {
        const list = Array.isArray(this.towns) ? this.towns : [];
        return list
          .map((t, i) => {
            const pop = Number(t.population);
            return {
              key: String(t.id ?? i),
              id: t.id,
              name: typeof t.name === "string" && t.name.trim() !== "" ? t.name.trim() : `#${t.id}`,
              _population: Number.isFinite(pop) ? pop : 0,
              population: U.fmtInt(Number.isFinite(pop) ? pop : null),
              x: Number.isFinite(Number(t.x)) ? Number(t.x) : null,
              y: Number.isFinite(Number(t.y)) ? Number(t.y) : null,
              at: Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y)) ? `${t.x}, ${t.y}` : "—",
              // 主货种：原始计数 + 由前端派生的"运走比例"（口径：所有公司）。
              cargo: (Array.isArray(t.cargo) ? t.cargo : []).slice(0, 2).map((c) => {
                const pct = this.cargoSharePct(c.produced, c.transported);
                return { label: this.cargoName(c.label), pct: pct === null ? "—" : `${pct}%` };
              }),
            };
          })
          .sort((a, b) => b._population - a._population);
      },

      /**
       * 城镇汇总。`total` 是地图总数（null = 未知），`shownPopulation` 只对
       * **这一个样本**求和 —— 把"前 10 大的人口"说成"全图人口"就是编造事实。
       */
      townsSummary() {
        const rows = this.townsRows();
        return {
          available: this.townsAvailable === true,
          shown: rows.length,
          // 注意 `Number(null) === 0`：必须先判 null/undefined，否则"未知总数"
          // 会被渲染成 0 —— 那是在说"地图上一个城镇都没有"（编造事实）。
          total:
            this.townsTotal === null || this.townsTotal === undefined || !Number.isFinite(Number(this.townsTotal))
              ? null
              : Number(this.townsTotal),
          shownPopulation: rows.reduce((a, r) => a + r._population, 0),
        };
      },

      /**
       * 货种标签 → 人类可读名。
       *
       * 为什么用**标签**而不是 GS 的 `GSCargo.GetName`：后者是**本地化字符串**，
       * 官方明确说"不应作为玩家可见字符串使用"（PR #8544 讨论）。标签（PASS/COAL…）
       * 是稳定的机器键，映射放在可单测的这里，未知标签就原样显示（不编名字）。
       */
      cargoName(label) {
        // GS 的标签是**定长 4 字符**（`OIL_`、`GOOD`、`PASS`）——尾部下划线/空格
        // 是填充不是语义，直接显示会变成 "OIL_"（真机实测 2026-09-25）。
        const l = String(label || "").toUpperCase().replace(/[\s_]+$/, "");
        return (
          {
            PASS: "Passengers",
            MAIL: "Mail",
            COAL: "Coal",
            WOOD: "Wood",
            OIL: "Oil",
            "GOOD": "Goods",
            GRAI: "Grain",
            LVST: "Livestock",
            STEL: "Steel",
            VALU: "Valuables",
            FOOD: "Food",
            PAPR: "Paper",
            WATR: "Water",
            FRUT: "Fruit",
            MAIZ: "Maize",
            IORE: "Iron ore",
            RUBR: "Rubber",
            SUGP: "Sugar",
            TOYS: "Toys",
            BATT: "Batteries",
            CERE: "Cereals",
            ORE: "Ore",
            DIAM: "Diamonds",
            ENSP: "Engineering supplies",
            FMSP: "Farm supplies",
          }[l] || l
        );
      },

      /** 产业口径的"运走比例"：**所有公司**合计。produced=0 → null（显示 —，不是 0%）。 */
      cargoSharePct(produced, transported) {
        // D60：**先问缺失**——`Number(null)` 是 0，不问就又把 null 折成 0%（修复时踩中）。
        if (transported === null || transported === undefined) return null;
        const p = Number(produced);
        const t = Number(transported);
        // 缺失/-1 是「不适用」，不是 0%——负值绝不能被四舍五入成 0。
        if (t < 0) return null;
        if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(t)) return null;
        return Math.round((t / p) * 100);
      },

      /** 货种聚合行（产业口径）。share 是**派生**值，hint 写明口径。 */
      cargoRows() {
        return (Array.isArray(this.cargoTotals) ? this.cargoTotals : []).map((c) => {
          const pct = this.cargoSharePct(c.produced, c.transported);
          return {
            key: String(c.label),
            label: String(c.label),
            name: this.cargoName(c.label),
            produced: U.fmtInt(c.produced),
            transported: U.fmtInt(c.transported),
            share: pct === null ? "—" : `${pct}%`,
            sharePct: pct,
            shareHint: "share of the industry's last-month production that was transported — all companies, not just this one",
          };
        });
      },

      /** 产业样本行（按产量降序）。stock 为 null 时显示 —（该产业不接受该货）。 */
      industryRows() {
        const list = Array.isArray(this.industries) ? this.industries : [];
        return list
          .map((i) => ({
            key: String(i.id),
            id: i.id,
            name: i.name || this.cargoName(i.cargo),
            cargo: this.cargoName(i.cargo),
            produced: U.fmtInt(i.produced),
            transported: U.fmtInt(i.transported),
            stock: i.stock === null || i.stock === undefined ? "—" : U.fmtInt(i.stock),
            _produced: Number(i.produced) || 0,
          }))
          .sort((a, b) => b._produced - a._produced);
      },

      /** 取样说明（诚实：这是取样，不是全图）。 */
      industrySampleNote() {
        if (this.industryAvailable !== true) return "";
        const rows = this.industryRows();
        if (!rows.length) return "";
        const total = Number.isFinite(Number(this.industriesTotal)) ? U.fmtInt(this.industriesTotal) : "unknown";
        return `largest ${rows.length} of ${total} industries · sampled by production (not the whole map)`;
      },

      /** 与 `townsNote()` 同约定：空串 = 可显示；非空 = 为什么没有。 */
      industryNote() {
        if (this.industryAvailable !== true) {
          return "not readable in this run — industry and cargo data come from the Bridge GS, which only runs in agent mode (this run is watch)";
        }
        return "";
      },

      industryEmpty() {
        return "no industry report yet — the GS publishes its sample every few hundred ticks";
      },

      /** 公司口径：本公司实际交付（monitor 累计，只覆盖被监视的目的地）。 */
      ownCargoRows() {
        const c = this.companyCargo;
        if (!c || !Array.isArray(c.byCargo)) return [];
        return c.byCargo.map((x) => ({
          key: String(x.label),
          name: this.cargoName(x.label),
          label: String(x.label),
          amount: U.fmtInt(x.amount),
        }));
      },

      /** 本公司口径的说明：**必须**写出"这是子集"（被监视的目的地数量）。 */
      ownCargoNote() {
        if (this.companyCargoAvailable !== true) return "";
        const c = this.companyCargo || {};
        const m = c.monitored;
        if (!m) return "delivered by this company since this run started — destination coverage unknown";
        // 覆盖**全部**城镇与产业（GS 侧就是全量监视）——所以说"all"而不是"subset"；
        // 万一将来改成抽样，这里必须跟着改（措辞与事实要一致）。
        return `delivered by this company since this run started · all ${U.fmtInt(m.towns)} towns and ${U.fmtInt(m.industries)} industries monitored`;
      },

      /** 本公司交付合计（monitor 口径，会话累计）；未收到时 —（不是 0）。 */
      ownDeliveredTotal() {
        // 有通道时 **0 是真实测量值**（monitor 还没收到交付），必须显示 0；
        // 只有"没有这条通道"才显示 —。把它写成"空表 → —"就是又一次把 0 说成未知。
        if (this.companyCargoAvailable !== true) return "—";
        const sum = (this.companyCargo && this.companyCargo.byCargo ? this.companyCargo.byCargo : [])
          .reduce((a, x) => a + (Number(x.amount) || 0), 0);
        return U.fmtInt(sum);
      },

      /** 游戏口径的季度交付总量（精确值，用作交叉核对）；未收到时 —。 */
      ownQuarterText() {
        const c = this.companyCargo;
        const q = c ? c.quarterDelivered : null;
        return q === null || q === undefined || !Number.isFinite(Number(q)) ? "—" : U.fmtInt(q);
      },

      /** 与 `routesNote()` 同约定：空串 = 数据可用（显示表）；非空 = 为什么没有。 */
      townsNote() {
        if (this.townsAvailable !== true) {
          return "not readable in this run — towns come from the Bridge GS, which only runs in agent mode (this run is watch)";
        }
        return "";
      },

      /** 有通道但还没有样本时的说明。 */
      townsEmpty() {
        return "no town report yet — the GS publishes its sample every 200 ticks";
      },

      /** 表头右侧的取样说明（诚实：这是取样，不是全图）。 */
      townsSampleNote() {
        const s = this.townsSummary();
        if (s.available !== true || !s.shown) return "";
        const total = s.total === null ? "unknown" : U.fmtInt(s.total);
        return `largest ${s.shown} of ${total} towns · ${U.fmtInt(s.shownPopulation)} people in this sample (not the whole map)`;
      },

      /**
       * 线路区的四个数。
       *
       * 为什么 `vehicles` / `waiting` 要**去重**（2026-09-25 真机：同屏出现
       * "25 veh"（公司口径）与 "129"（线路求和）两个互相矛盾的数字）：
       * GS 的每条线路读数是"停在这条线**两端站**上的车 / 等在这两端的人"，而一个车站
       * 服务多条线路 —— 于是同一辆车、同一批乘客被每条用到该站的线路各数一次
       * （17 线 / 9 站 ⇒ 25 辆车 ≈ 25 × 5 = 125，与实测 129 同量级）。
       * 有车辆 id 就按 id 去重；等待量按**站号**去重（GS 逐站上报）。
       *
       * 口径必须写出来：这个数是"**在站台上被看见的**车"，不是车队规模（后者是公司口径
       * 的数字），在途的车两个口径都看不到。说不清口径，两个数就会继续互相打架。
       */
      routesSummary() {
        const rows = this.routeRows();
        const vehIds = new Set();
        const waitByStation = new Map();
        let idsKnown = false;
        for (const r of rows) {
          if (r._vehIds.length) idsKnown = true;
          for (const v of r._vehIds) vehIds.add(v);
          if (Number.isFinite(r._endsA) && r._endsA >= 0 && r._waitA !== null) waitByStation.set(r._endsA, r._waitA);
          if (Number.isFinite(r._endsB) && r._endsB >= 0 && r._endsB !== r._endsA && r._waitB !== null) {
            waitByStation.set(r._endsB, r._waitB);
          }
        }
        let waitSum = 0;
        for (const v of waitByStation.values()) waitSum += v;
        return {
          available: this.routesAvailable === true,
          count: rows.length,
          running: rows.filter((r) => !r.idle).length,
          // 车辆：能按 id 去重就去重；旧 GS（没有 id）退回求和并在界面上说明是"未去重"。
          vehicles: idsKnown ? vehIds.size : rows.reduce((a, r) => a + r._vehicles, 0),
          vehiclesDeduplicated: idsKnown,
          waiting: waitByStation.size ? waitSum : rows.reduce((a, r) => a + r._waiting, 0),
          waitingDeduplicated: waitByStation.size > 0,
          stops: waitByStation.size,
        };
      },

      /**
       * 这一块为什么是空的 / 为什么没有数据。
       *
       * `routesAvailable === false` **不是** "0 条线路"：watch 模式没有 GS 通道，
       * 这个事实根本没有被采集。写成"0 routes"是在编造关于世界的事实。
       */
      routesNote() {
        if (this.routesAvailable !== true) {
          return "Route data unavailable — this run has no GS channel (observe-only mode), so routes are not collected.";
        }
        if (this.routeRows().length === 0) {
          return "No routes yet — the agent has not built one in this game.";
        }
        return "";
      },

      /**
       * 线路**类型**：今天只有一种建造工具（`build_bus_route`），所以每条线路都是公路。
       *
       * 这是**可推断的**事实，不是线路自带的字段——GS 目前不上报类型。所以如实标注，
       * 而不是做一个看起来权威的 "Rail/Air" 列（那会是编造）。
       */
      routeTypeNote() {
        return "road only — build_bus_route is the only route builder implemented (no rail/air yet)";
      },

      /* ----------------------------- drill-down ----------------------------- */

      /** 卡片 → 详情载荷 id；`null` = 没有载荷，**不做成可点**（假按钮 = bug）。 */
      kpiDrawer(kind) {
        return { cash: 1, income: 1, fleet: 1, routes: 1 }[String(kind || "")] ? String(kind) : null;
      },

      /** 抽屉是否开着。 */
      drawerOpen() {
        return this.drawer !== null;
      },

      openDrawer(id) {
        this.drawer = this.kpiDrawer(id);
      },

      closeDrawer() {
        this.drawer = null;
      },

      drawerTitle() {
        return {
          fleet: "Fleet — which routes the vehicles are on",
          cash: "Cash history",
          income: "Income history",
          routes: "Routes",
        }[this.drawer] || "";
      },

      /**
       * 抽屉空态文案：`fleet` 与 `routes` 是两个不同的问题，
       * 共用一句 "No route has vehicles on it." 会让"线路表"分支说出错的事实。
       */
      drawerEmptyText() {
        return this.drawer === "fleet" ? "No route has vehicles on it." : "No routes reported yet.";
      },

      /** 抽屉是否渲染"线路表"分支（另一个分支是历史时间序列）。 */
      drawerShowsRoutes() {
        return this.drawer === "fleet" || this.drawer === "routes";
      },

      /**
       * FLEET 归因分解（P1-3）：公司总数 → 线路登记（去重）→ 在途/在库，差额**具名**。
       *
       * 数据是服务端算好的恒等式（route-stats.ts `fleetDecomposition`）：
       *   owned + unattributed === companyTotal
       * 这里只做显示：null 渲染 "—"（未计量，不是 0）。永远返回数组（D45）。
       */
      fleetAttributionRows() {
        const f = this.fleet;
        if (!f || typeof f !== "object") return [];
        const d = (v) => (v === null || v === undefined ? "—" : U.fmtInt(v));
        return [
          { k: "Company total", v: d(f.companyTotal), note: "engine count" },
          { k: "Owned by routes", v: d(f.owned), note: "deduped by id" },
          { k: "— on the road", v: d(f.onRoad), note: "" },
          { k: "— in depot", v: d(f.inDepot), note: "" },
          { k: "Unattributed", v: d(f.unattributed), note: "named gap, not dropped" },
        ];
      },

      /** 抽屉里的线路行：Fleet 只看**有车**的线（"车都在哪"）。 */
      drawerRouteRows() {
        const rows = this.routesSorted();
        return this.drawer === "fleet" ? rows.filter((r) => r._vehicles > 0) : rows;
      },

      /** 抽屉里的历史行（现金 / 收入）：最近 N 个采样点，最新在上。 */
      drawerHistoryRows() {
        if (this.drawerShowsRoutes() || this.drawer === null) return [];
        const metric = this.drawer === "cash" ? "money" : "income";
        const win = this.primaryHistory().slice(-30);
        return win
          .map((h, i) => {
            const v = Number(h[metric]);
            // 变化量取自**同一窗口内的前一个点**（窗口外的点不在表里，Δ 会指向看不见的行）。
            const prev = i > 0 ? Number(win[i - 1][metric]) : NaN;
            const delta = Number.isFinite(v) && Number.isFinite(prev) ? v - prev : null;
            return {
              key: `${h.at}-${i}`,
              date: h.year == null ? "—" : `${h.year}-${String(h.month ?? 1).padStart(2, "0")}`,
              value: Number.isFinite(v) ? U.fmtMoney(v) : "—",
              delta: delta === null ? "" : (delta > 0 ? "+" : "") + U.fmtMoney(delta),
              deltaCls: delta === null ? "dim" : delta > 0 ? "pos" : delta < 0 ? "neg" : "dim",
              loan: U.fmtMoney(h.loan),
            };
          })
          .reverse();
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
        // 有 brain 但 kind 不是 real ⇒ 这一局是**脚本演示**（`--offline-demo`）：
        // 决策真的在发生，只是来自固定脚本。以前这里统一说"只在观察内置 AI"，
        // 对演示局是假的——面板空的原因是"没有模型调用"，不是"没有 agent"。
        if (brain && brain.kind) {
          return {
            show: true,
            kind: "",
            title: "This run is a scripted demo",
            body:
              "Decisions here come from a fixed script, not from a model, so token usage and " +
              "reasoning stay empty on purpose. Start a run with a real LLM to measure one.",
            canStart: this.runControl && runState === "idle",
            hint: this.runControl ? "" : "Restart with `pnpm run cli --serve` to control runs from here.",
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
       * 图表高度：**固定常数**，与视口、宽度、内容都无关。
       *
       * 为什么改成固定（2026-09-23，用户第三次报告"纵向反复伸缩"之后）：
       * 曾经写成"取视口高度的 30%"，理由是"矮窗口别把图压扁"。但**图表高度一旦参与
       * 任何按需计算，就多了一条反馈通道**：高度 → 文档高 → 滚动条 → 宽度 → 布局 → 高度。
       * 用户的原话是"难道不应该是固定高度吗"——对，固定高度让这条通道**在结构上不存在**。
       * 上限仍是 `preferred`（默认 260），只做夹取，不读环境。
       */
      chartHeight(preferred) {
        const want = Number(preferred) || 260;
        return Math.max(160, Math.min(260, want));
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
          ["Cost", U.fmtCostKnown(u.costTotal, t && t.brain ? t.brain.costKnown : undefined)],
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
            // A turn's cost is unknown for the same reason the run's is: no price table.
            cost: U.fmtCostKnown(u.costTotal, t && t.brain ? t.brain.costKnown : undefined),
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


  /**
   * Where the decisions sit on the cash curve.
   *
   * The curve's x axis is the **sample index** (server-side history, oldest →
   * newest); each decision carries the **game date** it was taken on. So a
   * decision is marked on the last sample that is not newer than it.
   *
   * Why not "the sample nearest to it": a decision happens between two samples,
   * and the honest placement is "the curve as of that moment" - the last sample
   * that already contains it.
   *
   * A decision whose date is unknown, or that predates the whole history, gets
   * **no marker** (not a marker at x=0 - that would say the decision happened
   * before the run started).
   */
  function decisionMarkers(history, rows) {
    const hist = Array.isArray(history) ? history : [];
    const list = Array.isArray(rows) ? rows : [];
    if (!hist.length || !list.length) return [];
    const out = [];
    for (const row of list) {
      const date = row && typeof row.gameDate === "string" ? row.gameDate : "";
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      if (!m) continue;
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      let idx = -1;
      for (let i = 0; i < hist.length; i++) {
        const h = hist[i] || {};
        if (h.year == null || h.month == null) continue;
        // "not newer than the decision" = the sample is on or before that day.
        const sample = h.year * 10000 + h.month * 100 + (h.day || 1);
        const day = y * 10000 + mo * 100 + d;
        if (sample <= day) idx = i;
        else break;
      }
      if (idx < 0) continue;
      out.push({
        x: idx,
        label: row.trigger ? String(row.trigger) : "decision",
        turn: row.turn == null ? null : Number(row.turn),
      });
    }
    return out;
  }

  window.LiveView = {
    decisionMarkers: decisionMarkers,
    upsertStageView: upsertStageView,
    create: create,
    CASH_METRICS: CASH_METRICS,
    TOKEN_METRICS: TOKEN_METRICS,
    TOKEN_SERIES: TOKEN_SERIES,
    ROUTE_COLUMNS: ROUTE_COLUMNS,
    MAX_EVENTS_SHOWN: MAX_EVENTS_SHOWN,
    MAX_STEPS_SHOWN: MAX_STEPS_SHOWN,
  };
})();
