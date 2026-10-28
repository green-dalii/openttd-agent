/* Live page — Alpine component (WS wiring + imperative widgets).
 *
 * 职责: 只做三件事 ——
 *   1) 接 WebSocket 帧，把数据灌进 view model（`live-view.js` 的纯逻辑）
 *   2) 挂载必须命令式创建的部件：uPlot 图表、分段开关、分段筛选器
 *   3) 暴露模板用到的少量辅助（阶段图 URL/缩放/标记、事件原始 JSON 开关）
 *   所有"这是什么、该显示什么"的判断都在 live-view.js 里（可单测）。
 *
 * 为什么这样分层（docs/FRONTEND.md §3.4 阶段 4）:
 *   迁移到 Alpine 的风险不是"指令写错"，而是**把业务规则弄丢**。
 *   规则留在纯函数里，这一层退化为机械翻译，规则就不会悄悄消失。
 *
 * 事实来源: docs/DASHBOARD-UI.md §5.1、docs/DASHBOARD-API.md §4（WS 帧）。
 * 禁止: 在此写展示规则（放 live-view.js）；不让图表/列表抢走页面滚动
 *   （见 UI.scrollToEnd — `scrollIntoView` 会滚动整个文档）。
 */
"use strict";
(function () {
  const U = window.UI;
  const C = window.Charts;

  /** Bounded feeds (mirrors live-view.js; the arrays are trimmed here on ingest). */
  const MAX_EVENTS = 600;
  const MAX_STEPS = 400;

  document.addEventListener("alpine:init", function () {
    window.Alpine.data("live", function () {
      // The pure model owns every derivation; this object adds IO and widgets.
      const model = window.LiveView.create();

      return {
        ...model,

        /* ------------------------------ state ------------------------------ */
        linkOk: false,
        evPaused: false,
        /** The causal timeline's page (rows + total + load state). */
        timeline: { rows: [], total: 0, offset: 0, loading: false, error: "" },
        /** The decision count the current timeline page was loaded for. */
        timelineDecisions: null,

        /* ------------------------------- init ------------------------------- */
        init() {
          U.renderChrome();
          // Persisted view preferences.
          this.cashMetric = U.getPref("cash.metric", "money");
          this.tokenMetric = U.getPref("token.metric", "total");
          this.follow = U.getPref("steps.follow", true);
          this.evHidden = new Set(U.getPref("ev.hidden", []));

          this.$nextTick(() => {
            // Segmented controls are created imperatively (shared with other pages).
            if (this.$refs.cashMetric) {
              U.segmented(this.$refs.cashMetric, {
                options: window.LiveView.CASH_METRICS,
                value: () => this.cashMetric,
                onChange: (id) => { this.cashMetric = id; U.setPref("cash.metric", id); this.drawCash(); },
              });
            }
            if (this.$refs.tokenMetric) {
              U.segmented(this.$refs.tokenMetric, {
                options: window.LiveView.TOKEN_METRICS,
                value: () => this.tokenMetric,
                onChange: (id) => { this.tokenMetric = id; U.setPref("token.metric", id); this.drawTokens(); },
              });
            }
            if (this.$refs.stepFilter) {
              U.segmented(this.$refs.stepFilter, {
                options: [
                  { id: "all", label: "All" },
                  { id: "message", label: "LLM" },
                  { id: "tool", label: "Tools" },
                  { id: "failed", label: "Failures" },
                ],
                value: () => this.stepFilter,
                onChange: (id) => { this.stepFilter = id; this.afterSteps(); },
              });
            }
          });

          this.bindDrawerKeys();
          this.connect();
          this.loadRun();
          this.loadCapabilities();
          // Elapsed time must tick without a busy repaint loop.
          this.elapsedTimer = setInterval(() => { if (this.startedAt) this.elapsed = U.fmtDuration(Date.now() - this.startedAt); }, 5000);
        },

        /* ------------------------------- run ------------------------------- */
        async loadRun() {
          try {
            const r = await fetch("/api/run");
            if (r.ok) {
              this.runControl = true;
              this.run = await r.json();
            }
          } catch {
            /* run control disabled */
          }
        },

        /**
         * Fetch the static action surface once (AB-1, SPEC §10.91).
         *
         * 404 is expected and means the dashboard is not running in a mode that
         * exposes actions (e.g. `--watch` before any agent). The panel stays
         * hidden because `actionSurface()` returns null on null input; we never
         * want a "0 actions" empty list pretending to be the truth.
         */
        async loadCapabilities() {
          try {
            const r = await fetch("/api/capabilities");
            if (!r.ok) return; // 404 = capability hook absent, panel stays hidden
            const body = await r.json();
            // The endpoint serves `{ actions: [...], generatedFrom }` (docs §3.6).
            // We carry the full payload so the page can render `generatedFrom`
            // provenance if we ever need to; live-view.js's actionSurface() only
            // reads `actions`.
            this.actionCatalog = body;
          } catch {
            /* offline or hook disabled — leave actionCatalog null, panel hidden */
          }
        },

        async post(path, payload) {
          try {
            const r = await fetch(path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload || {}),
            });
            const reply = await r.json().catch(() => ({}));
            if (!r.ok) { U.toast(reply.error || `HTTP ${r.status}`, "err", 7000); return false; }
            this.run = reply;
            return true;
          } catch (e) {
            U.toast("Request failed: " + e, "err");
            return false;
          }
        },

        startRun(mode) { return this.post("/api/run/start", { mode }); },
        pauseResume() { return this.post(this.runState() === "paused" ? "/api/run/resume" : "/api/run/pause"); },
        async stopRun() {
          const ok = await U.confirmDialog({
            title: "Stop the run?",
            body: "The game will shut down and the session is finalised as aborted. Recorded data is kept.",
            confirm: "Stop run",
          });
          if (ok) await this.post("/api/run/stop");
        },

        /* -------------------------------- ws -------------------------------- */
        connect() {
          const handlers = {
            // connectWs reports the link state itself; no polling needed.
            onLink: (text, cls) => { this.link = text; this.linkOk = cls === "ok"; },
            onSnapshot: (s) => {
              this.date = s.date;
              this.companies = s.companies || {};
              // 内容没变就**保持同一个数组引用**：换引用会让 Alpine 每帧重渲染整张表
              // （实测 13k DOM 变更/秒），而由此产生的 docH 抖动会被滚动锚定
              // 原样转嫁到用户的滚动位置上。见 LiveView.sameEventList 的注释。
              if (!this.sameEventList(s.recent, this.recent)) {
                this.recent = s.recent || [];
              }
              this.totalEvents = s.totalEvents;
              // 线路事实（2026-09-23）：后端一直有 GS 读数，只是此前**从没发到页面**。
              // `routesAvailable` 必须单独记住：false = 这个 run 没有 GS 通道，
              // 页面要显示"不可得"而不是"0 条线路"（编造事实）。
              if (Array.isArray(s.routes)) this.routes = s.routes;
              this.routesAvailable = s.routesAvailable === true;
              // 城镇：GS 一直在发 `town_list`，但后端快照此前**从没带上它**
              // （`toWireSnapshot` 丢字段），所以页面永远是空的（2026-09-25 修复）。
              if (Array.isArray(s.towns)) this.towns = s.towns;
              // 同样要防 `Number(null) === 0`：未知总数保持 null（显示「—」）。
              this.townsTotal =
                s.townsTotal === null || s.townsTotal === undefined || !Number.isFinite(Number(s.townsTotal))
                  ? null
                  : Number(s.townsTotal);
              this.townsAvailable = s.townsAvailable === true;
              // 产业/货种（P1）：GS 原始计数；比率由 view model 派生。
              if (Array.isArray(s.industries)) this.industries = s.industries;
              this.industriesTotal = s.industriesTotal === null || s.industriesTotal === undefined ? null : Number(s.industriesTotal);
              if (Array.isArray(s.cargoTotals)) this.cargoTotals = s.cargoTotals;
              this.industryAvailable = s.industryAvailable === true;
              // 公司口径（P2）；null = 未收到（不是零运量）。
              this.companyCargo = s.companyCargo || null;
              // P1-3：FLEET 归因分解（服务端算好的恒等式）。null = 未计量。
              this.fleet = s.fleet || null;
              this.companyCargoAvailable = s.companyCargoAvailable === true;
              // 暂停归因（后端记录的事实）："谁让它停的"必须以它为准，
              // 不能只看 run.state（agent 自己停时它可能还是 running）。
              this.control = s.control || null;
              // 执行器异常的**完整**文本（2026-09-25）：公司名是执行器唯一已验证的通道、
              // 上限 31 字符，所以它分块上报、由 harness 拼回后放在快照里。
              // `null` = 这个 run 没有执行器错误（不是“空消息”）。
              this.executorError = s.executorError || null;
              // These three were sent by the server all along but never consumed,
              // so a page loaded mid-run saw no stages and no memory (MEMORY.md A1:
              // "no error" only holds if the code actually ran).
              if (Array.isArray(s.checkpoints)) this.stages = s.checkpoints;
              if (Array.isArray(s.stages)) {
                // Upsert, never assign: live frames may have already arrived.
                for (const v of s.stages) {
                  this.stageViews = window.LiveView.upsertStageView(this.stageViews, v);
                }
              }
              if (s.memory) this.memory = s.memory;
            },
            onEvent: (ev) => {
              if (this.evPaused) return;
              this.recent = [...this.recent, ev].slice(-MAX_EVENTS);
              this.fold(ev);
            },
            onTelemetry: (t) => this.applyTelemetry(t, true),
            onStep: (s) => { this.pushStep(s); this.afterSteps(); },
            onCheckpoint: (cp) => { this.stages = [...this.stages, cp]; },
            onRun: (r) => { this.run = r; },

            onStage: (v) => {
              // Upsert by archive index, never append: a re-delivered frame used to
              // create a second entry with the same `index`, and since `index` is the
              // Alpine x-for :key, duplicate keys made the whole stage list render
              // ZERO nodes (measured: 2 same-key items -> 0 `.snap`). See MEMORY.md B2.
              this.stageViews = window.LiveView.upsertStageView(this.stageViews, v);
              this.$nextTick(() => this.drawStageFallbacks());
            },
            onStageImage: (info) => {
              // A real captured minimap arrived for one stage; swap it in.
              const i = Number(info && info.index);
              this.stageViews = window.LiveView.upsertStageView(this.stageViews, {
                index: i,
                image: info && info.file,
              });
            },
            onFrame: (at) => {
              this.lastFrameAt = at;
            },
          };
          const ws = U.connectWs(handlers);
          // 断线重连后 lastFrameAt 由 onFrame 续上；这里也定期问一次 socket，
          // 这样"页面开着但一帧都没来过"能被显示出来（而不是永远停在 '—'）。
          this._dataAgeTimer = setInterval(() => {
            const at = ws.lastFrameAt();
            if (at !== null) this.lastFrameAt = at;
          }, 2000);
          return ws;
        },

        /** Fold one event into the local company/date mirror (live view only). */
        fold(ev) {
          const p = ev.payload || {};
          if (ev.kind === "date") this.date = p;
          else if (ev.kind === "company_new") {
            this.companies[p.id] = this.companies[p.id] || { info: null, economy: null, stats: null, history: [] };
          } else if (ev.kind === "company_info") {
            const c = (this.companies[p.id] = this.companies[p.id] || { economy: null, stats: null, history: [] });
            c.info = p;
          } else if (ev.kind === "company_stats") {
            const c = (this.companies[p.id] = this.companies[p.id] || { info: null, economy: null, history: [] });
            c.stats = p;
          } else if (ev.kind === "company_economy") {
            const c = (this.companies[p.id] = this.companies[p.id] || { info: null, stats: null, history: [] });
            c.economy = p;
            if (p.money !== undefined) {
              // Mirror the server's point shape so seeding and live appends agree.
              c.history = [...(c.history || []), {
                at: ev.ts,
                year: this.date ? this.date.year : null,
                month: this.date ? this.date.month : null,
                money: Number(p.money),
                loan: Number(p.loan || 0),
                income: Number(p.income || 0),
              }].slice(-400);
            }
          }
        },

        applyTelemetry(t, replace) {
          this.telemetry = t;
          if (Array.isArray(t.steps)) {
            this.steps = replace ? t.steps.slice() : this.mergeSteps(this.steps, t.steps);
          }
          this.thinking = Array.isArray(t.recentThinking) ? t.recentThinking : [];
          // A new decision = a new timeline row: refresh when the decision
          // count moves. The timeline is read from the session's audit trail
          // (the server owns the rules), so it is fetched, not derived here.
          // The count lives under `totals` (the snapshot's own shape) — reading
          // `t.decisions` silently yields undefined, and then the timeline
          // never loads at all.
          const decisions = Number(t && t.totals && t.totals.decisions);
          if (Number.isFinite(decisions) && decisions !== this.timelineDecisions) {
            this.timelineDecisions = decisions;
            void this.loadTimeline();
          }
          this.$nextTick(() => { this.afterSteps(); });
        },

        /* -------------------------- causal timeline ------------------------- */
        /**
         * Load the next page of the causal timeline (B3).
         *
         * The rows come from the server (`/api/sessions/:id/timeline`): the
         * page does not join the evidence itself — which tool belongs to which
         * decision, what the effect was — that is the server's rule.
         */
        async loadTimeline(opts) {
          const sid = this.timelineSessionId();
          if (!sid) {
            this.timeline = { rows: [], total: 0, offset: 0, loading: false, error: "" };
            return;
          }
          const offset = opts && typeof opts.offset === "number" ? opts.offset : 0;
          const limit = opts && typeof opts.limit === "number" ? opts.limit : 20;
          this.timeline = { ...this.timeline, loading: true, error: "" };
          try {
            const r = await fetch(
              `/api/sessions/${encodeURIComponent(sid)}/timeline?limit=${limit}&offset=${offset}`,
            );
            if (!r.ok) {
              const out = await r.json().catch(() => ({}));
              this.timeline = { rows: [], total: 0, offset: 0, loading: false, error: String(out.error || `HTTP ${r.status}`) };
              return;
            }
            const page = await r.json();
            const rows = window.TimelineView.rows(page);
            // Older rows are appended BELOW the newer ones (the page shows the
            // newest at the top); the server already ordered them newest-first.
            const merged = offset > 0 ? [...this.timeline.rows, ...rows] : rows;
            this.timeline = { rows: merged, total: Number(page.total) || 0, offset, loading: false, error: "" };
          } catch (e) {
            this.timeline = { rows: [], total: 0, offset: 0, loading: false, error: `Timeline failed: ${e}` };
          }
        },

        /** Load the next (older) page — "older ones load on demand". */
        loadOlderTimeline() {
          return this.loadTimeline({ offset: this.timeline.rows.length, limit: 20 });
        },

        /** The session the timeline belongs to (the run being watched). */
        timelineSessionId() {
          return (this.telemetry && this.telemetry.sessionId) || this.sessionId || "";
        },

        /** The rows the page draws (newest first, as the server ordered them). */
        timelineRows() {
          return window.TimelineView.rows(this.timeline);
        },

        /** Is there an older page waiting? */
        timelineHasMore() {
          return window.TimelineView.hasMore(this.timeline, this.timeline.rows.length);
        },

        /** The tools of one row. */
        timelineTools(row) {
          return window.TimelineView.tools(row);
        },

        /** The jobs (and phases) of one row. */
        timelineJobs(row) {
          return window.TimelineView.jobs(row);
        },

        /** The effect readings of one row (null = no later reading yet). */
        timelineEffect(row) {
          return window.TimelineView.effect(row);
        },

        /** The headline of one row. */
        timelineHeadline(row) {
          return window.TimelineView.headline(row);
        },

        /** The one-line summary of one row. */
        timelineSummary(row) {
          return window.TimelineView.summary(row);
        },

        /**
         * The goal of the most recent decision (band ①: "what is it doing").
         *
         * It comes from the timeline's newest row — the same fact the row
         * shows, not a second copy from another source.
         */
        timelineGoal() {
          const rows = this.timelineRows();
          if (!rows.length) return "";
          const head = window.TimelineView.headline(rows[0]);
          return head.goal || "";
        },

        /** Telemetry snapshots repeat the tail of the step list; keep one of each. */
        mergeSteps(local, incoming) {
          const seen = new Set(local.map((s) => s && s.id));
          const merged = local.slice();
          for (const s of incoming) {
            if (s && !seen.has(s.id)) { merged.push(s); seen.add(s.id); }
          }
          return merged.slice(-MAX_STEPS);
        },

        pushStep(step) {
          if (!step || typeof step !== "object") return;
          if (this.steps.some((s) => s && s.id === step.id)) return;
          this.steps = [...this.steps, step].slice(-MAX_STEPS);
        },

        /** Follow the newest step INSIDE the list; never move the page. */
        afterSteps() {
          this.$nextTick(() => {
            if (this.follow && this.$refs.stepList) U.scrollToEnd(this.$refs.stepList);
          });
        },

        /* ------------------------ executor error ------------------------ */
        /**
         * 执行器异常的完整文本；没有错误时返回 ""。
         *
         * 为什么存在（2026-09-25 真机）：公司名（执行器唯一已验证的通道，SPEC §10.10）
         * 上限 31 字符，而错误在生产端被截到 24 字符——页面只显示
         * `EX exc:can't execute over an un…`，“为什么卡住”当场不可诊断。现在执行器分块
         * 上报，harness 拼回完整文本并发在快照的 `executorError` 里。
         * 防御：字段缺失/半成形一律当作“没有错误”，绝不抛（这是可选的线上字段）。
         */
        executorErrorText() {
          const e = this.executorError;
          if (!e || typeof e !== "object") return "";
          const msg = typeof e.message === "string" ? e.message.trim() : "";
          if (!msg) return "";
          return e.truncated === true ? msg + " …truncated" : msg;
        },

        /**
         * 运行面板里“为什么没有进展”的那句话。
         *
         * live-view.js 拥有暂停/停滞的判据（纯函数、有单测）；这里只**追加**执行器
         * 自己抛出的异常——它是“循环不动”的第二个独立成因，与暂停归因并列显示，
         * 不能混进 live-view.js 的判定树（那会让两个成因互相掩盖）。
         */
        controlNote(nowMs) {
          const base = model.controlNote.call(this, nowMs);
          const err = this.executorErrorText();
          if (!err) return base;
          const at = Number(this.executorError && this.executorError.at);
          // fmtAgo 自带单位与 "ago"（"2 minutes ago"），再拼一次就成了
          // "2 minutes ago ago"（真机截图里出现过）。
          const when = Number.isFinite(at) && at > 0 ? " (" + U.fmtAgo(at) + ")" : "";
          const line = "The executor raised an error" + when + ": " + err;
          return base ? base + " " + line : line;
        },

        /* ----------------------------- drawer ----------------------------- */
        /**
         * 详情抽屉：点卡片展开"这张卡片背后的明细"。
         *
         * 为什么需要（用户："比如点击车辆卡片具体展示详细信息"）：KPI 是**结论**，
         * 运营者看到"Fleet 9 veh"之后的下一个问题是"在哪条线上"——那需要一个能展开的载荷。
         * 规则：**没有载荷的卡片不做成可点**（假按钮 = bug，见 MEMORY B8）。
         */
        openDrawer(id) {
          this.drawer = this.kpiDrawer(id);
        },

        /** Esc 关闭：抽屉必须有一条键盘出路。 */
        bindDrawerKeys() {
          window.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && this.drawer !== null) this.drawer = null;
          });
        },

        /* ---------------------------- widgets ---------------------------- */
        /**
         * Draw the cash curve.
         *
         * 关键: 响应式读取必须发生在 effect 的同步作用域内，否则 Alpine 追踪不到
         * 依赖、数据异步到达后不会重画（真机上表现为"图表一直空着"）。
         * 所以这里先把要画的数据读出来，再排队绘制。
         */
        drawCash() {
          const series = this.cashSeries();
          const labels = this.cashLabels();
          const el = this.$refs.cashChart;
          if (!el) return;
          this.$nextTick(() => {
            if (!this.$refs.cashChart) return;
            C.line(el, {
              series, labels, area: series.length === 1, height: this.chartHeight(260), // 固定高度
              // 区间读数的单位与标签：x 是**采样序号**，标签是月；读数给日精度，
              // 因为"我现在看的是哪一段"需要比轴标签更细的一层（单位写 points，
              // 不写 days —— 两个采样点可以同一天，叫"天"就是编造单位）。
              rangeUnit: "points",
              rangeLabel: (i) => this.cashRangeLabel(i),
              // `key` 标识"这张图画的是什么"：切换指标时 format 都是函数，
              // ucharts 的复用判断只能靠这个键，否则会把 cost 画成 money。
              key: "cash:" + this.cashMetric,
            });
          });
        },

        /** Draw the per-turn composition chart (same synchronous-read rule). */
        drawTokens() {
          const items = this.tokenItems();
          const series = this.tokenSeries();
          const el = this.$refs.tokenChart;
          if (!el) return;
          this.$nextTick(() => {
            if (!this.$refs.tokenChart) return;
            // Stacked AREA, not bars: the question is composition over turns, and an
            // area makes the split readable as a continuous band rather than a row of
            // separated columns (docs/DASHBOARD-UI.md §6c).
            C.stackedArea(el, {
              items,
              series,
              format: this.tokenMetric === "cost" ? U.fmtCost : U.fmtTok,
              height: this.chartHeight(220),
              maxBars: 24,
              key: "tokens:" + this.tokenMetric,
            });
          });
        },

        /** Stages without a captured PNG fall back to the schematic diagram. */
        drawStageFallbacks() {
          const box = document.querySelector(".stage-snaps");
          if (!box) return;
          for (const cv of box.querySelectorAll("canvas.snap-fallback")) {
            const key = cv.getAttribute("data-stage");
            const view = this.stageViews.find((v) => this.stageKey(v) === key);
            if (view && window.Charts && window.Charts.stageMap) window.Charts.stageMap(cv, view);
          }
        },

        /* --------------------- stage view helpers --------------------- */
        stageKey(v) {
          return `${v.gameDate || ""}-${v.phase || ""}-${v.index ?? ""}`;
        },
        stageImageUrl(v) {
          if (!v.image) return "";
          const sid = (this.telemetry && this.telemetry.sessionId) || this.sessionId;
          if (!sid) return "";
          return `/api/sessions/${encodeURIComponent(sid)}/stages/${encodeURIComponent(v.image)}`;
        },
        stageBackdrop(v) {
          const url = this.stageImageUrl(v);
          if (!url || !window.StageViewUI) return "";
          return window.StageViewUI.backdropStyle(url, v.focus);
        },
        // Marks are injected as an SVG markup string via x-html. A <template> inside
        // <svg> is SVG-namespaced with no `.content`, which breaks Alpine's x-for
        // ("reading 'children'") and never binds the loop variable. See MEMORY.md B2.
        stageOverlay(v) {
          return window.StageViewUI ? window.StageViewUI.overlaySvg(v) : "";
        },
        stageZoom(v) {
          return v.focus ? `${v.focus.scale.toFixed(1)}×` : "full";
        },
        stageFleet(v) {
          const veh = (v.companies || []).reduce((a, c) => a + (c.vehicles || 0), 0);
          const stn = (v.companies || []).reduce((a, c) => a + (c.stations || 0), 0);
          return `${U.fmtInt(veh)} veh · ${U.fmtInt(stn)} stn`;
        },
        stageMoney(v) {
          return U.fmtMoney(v.companies && v.companies[0] ? v.companies[0].money : 0);
        },
        get legendOurs() { return window.StageViewUI ? window.StageViewUI.LEGEND.ours : []; },
        get legendBase() { return window.StageViewUI ? window.StageViewUI.LEGEND.base : []; },

        /* --------------------------- small bits --------------------------- */
        /** Whether a metric has enough history to draw its KPI sparkline. */
        hasHistory(metric) {
          return this.hasSpark(metric);
        },
        /**
         * Paint the KPI sparklines.
         *
         * Reads the series **synchronously** (not inside $nextTick), so Alpine's
         * x-effect can actually track the dependency and re-run when new history
         * arrives. Reading across an async boundary is invisible to the tracker and
         * leaves a permanently blank canvas (MEMORY.md B3).
         */
        drawSparks() {
          const el = this.$refs.kpiBox;
          if (!el || !window.UI) return;
          U.paintSparks(el, this.sparkSpecs());
        },
        brainIsReal() {
          const b = this.telemetry && this.telemetry.brain;
          return Boolean(b && b.kind === "real");
        },
        latestPhase() {
          const last = this.stages.length ? this.stages[this.stages.length - 1] : null;
          return (last && last.note ? String(last.note).split(":")[0].slice(0, 40) : "—");
        },
        tokenSummary() {
          const rows = this.turnRows();
          if (!rows.length) return "";
          const isCost = this.tokenMetric === "cost";
          const total = rows.reduce((a, r) => a + Number(this.rawTurnTotal(r.turn, isCost)), 0);
          const costKnown = this.telemetry && this.telemetry.brain ? this.telemetry.brain.costKnown : undefined;
          return isCost
            ? `${U.fmtCostKnown(total, costKnown)} across ${rows.length} turns`
            : `${rows.length} turn${rows.length === 1 ? "" : "s"} · ${U.fmtTok(total)} total`;
        },
        /** Raw per-turn value for the summary line. */
        rawTurnTotal(turn, isCost) {
          const t = this.telemetry;
          const row = ((t && t.usage && t.usage.byTurn) || []).find((r) => r.turn === turn);
          if (!row || !row.usage) return 0;
          return isCost ? Number(row.usage.costTotal) || 0 : Number(row.usage.totalTokens) || 0;
        },
        setPref(key, value) { U.setPref(key, value); },
        /** Flip an event category and remember the choice (model owns the set). */
        toggleCategory(cat) {
          this.evHidden = this.toggleCategorySet(cat);
          U.setPref("ev.hidden", [...this.evHidden]);
        },
        toggleRaw(ev) {
          const pre = ev.currentTarget.parentElement.querySelector(".raw");
          if (pre) pre.hidden = !pre.hidden;
        },
        togglePause() { this.evPaused = !this.evPaused; },
        get elapsed() { return this.startedAt ? U.fmtDuration(Date.now() - this.startedAt) : "—"; },
      };
    });
  });
})();
