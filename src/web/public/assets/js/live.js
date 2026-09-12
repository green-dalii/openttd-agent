/* Live page — Alpine component (WS wiring + imperative widgets).
 *
 * 职责: 只做三件事 ——
 *   1) 接 WebSocket 帧，把数据灌进 view model（`live-view.js` 的纯逻辑）
 *   2) 挂载必须命令式创建的部件：uPlot 图表、分段开关、分段筛选器
 *   3) 暴露模板用到的少量辅助（阶段图 URL/缩放/标记、事件原始 JSON 开关）
 *   所有"这是什么、该显示什么"的判断都在 live-view.js 里（可单测）。
 *
 * 为什么这样分层（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.4 阶段 4）:
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

        /* ------------------------------- init ------------------------------- */
        init() {
          U.renderNavInto("nav", "/");
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

          this.connect();
          this.loadRun();
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
              this.recent = s.recent || [];
              this.totalEvents = s.totalEvents;
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
              this.stageViews = [...this.stageViews, v].slice(-24);
              this.$nextTick(() => this.drawStageFallbacks());
            },
            onStageImage: (info) => {
              // A real captured minimap arrived for one stage; swap it in.
              const i = Number(info && info.index);
              const hit = this.stageViews.find((x) => x.index === i);
              if (hit) hit.image = info.file;
            },
          };
          return U.connectWs(handlers);
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
          this.$nextTick(() => { this.afterSteps(); });
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
            C.line(el, { series, labels, format: U.fmtMoney, area: series.length === 1, height: 260 });
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
            C.stackedBars(el, { items, series, format: this.tokenMetric === "cost" ? U.fmtCost : U.fmtTok, height: 220, maxBars: 24 });
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
        stageMarks(v) {
          return window.StageViewUI ? window.StageViewUI.overlayMarks(v) : [];
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
        hasHistory(metric) {
          return Boolean(metric) && this.cashSeries().some((s) => s.data.length > 1);
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
          return isCost
            ? `${U.fmtCost(total)} across ${rows.length} turns`
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
