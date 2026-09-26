/* Sessions page — Alpine component (data loading + imperative widgets).
 *
 * 职责: 只做三件事 ——
 *   1) 取数据（`/api/sessions`、`/api/sessions/:id`）并塞进 view model
 *   2) 挂载必须命令式创建的部件（环形图 canvas、分段筛选器）
 *   3) 暴露模板用到的少量派生函数
 *   其余一切展示逻辑在 `sessions-view.js` 的纯函数里（可单测）。
 *
 * 为什么这样分层（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.4 阶段 4）:
 *   Alpine 负责"状态 → DOM"，但 canvas 绘制与既有分段控件是命令式的。
 *   把这些副作用集中在 `init()` / `drawDonut()`，规则仍留在可测的纯函数里。
 *
 * 事实来源: docs/DASHBOARD-UI.md §5.3、docs/DASHBOARD-API.md §2.5/§3.3。
 * 禁止: 本页只读 —— 不发送任何控制指令；不重写 view model 的业务判断。
 */
"use strict";
(function () {
  const U = window.UI;
  const C = window.Charts;

  document.addEventListener("alpine:init", function () {
    window.Alpine.data("sessions", function () {
      // The pure model owns every derivation; this object only adds IO.
      const model = window.SessionsView.create({
        sessions: [],
        data: null,
        compareData: null,
        onlyDone: U.getPref("sessions.onlyDone", false),
      });

      // Spread (not Object.assign) so the model's method types survive: a
      // plain assign widens the object to the literal below and `tsc` then
      // cannot see `data`/`totals`/`$refs` on `this`.
      return {
        ...model,
        /* ------------------------------ state ------------------------------ */
        selected: null,
        loadingDetail: false,
        /** “刚复制过”的短暂反馈（'' = 无）。 */
        copied: "",
        detailError: "",
        compareOpen: false,
        evSearch: "",

        /* ------------------------------- init ------------------------------- */
        async init() {
          // 页头（标题+导航）只有这一个来源：common.js 的 renderChrome()。
          // 它由 common.js 定义，所以不需要"桥没加载"的回退分支（那会让 #nav
          // 以一个 HTML 里已不存在的元素为依赖，被 web-assets 守卫抓住）。
          U.renderChrome();
          await this.load();
          // The segmented control is created imperatively (it predates Alpine and
          // is shared with the Live page), so it is mounted once here.
          this.$nextTick(() => {
            if (this.$refs.stepFilter) {
              U.segmented(this.$refs.stepFilter, {
                options: [
                  { id: "all", label: "All" },
                  { id: "message", label: "LLM" },
                  { id: "tool", label: "Tools" },
                  { id: "failed", label: "Failures" },
                ],
                value: () => this.stepFilter,
                onChange: (id) => { this.stepFilter = id; },
              });
            }
          });
        },

        /* ------------------------------ loading ------------------------------ */
        async load() {
          try {
            const r = await fetch("/api/sessions");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            this.sessions = (await r.json()).sessions || [];
            // 默认打开**最新的一局**（2026-09-25 用户：/sessions 信息太少）。
            // 这个页面是"回放浏览器"：进来却右半屏空着、让人先点一下才能看到任何东西，
            // 等于把最该先被看见的那一局藏起来了。最新一局就是用户刚跑完/最关心的一局。
            if (!this.selected && this.sessions.length) {
              const newest = this.sessions[0];
              if (newest && newest.id) await this.open(newest.id);
            }
          } catch (e) {
            this.sessions = [];
            this.detailError = `Could not list runs: ${e}`;
          }
        },

        async open(id) {
          this.selected = id;
          this.compareWith = null;
          this.compareData = null;
          this.compareOpen = false;
          this.loadingDetail = true;
          this.detailError = "";
          try {
            const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            this.data = await r.json();
          } catch (e) {
            this.data = null;
            this.detailError = `Could not load: ${e}`;
          } finally {
            this.loadingDetail = false;
          }
        },

        /* ---------------------------- compare ---------------------------- */
        canCompare() {
          return Boolean(this.selected) &&
            this.sessions.filter((s) => s.id !== this.selected).length > 0;
        },

        startCompare() {
          const others = this.sessions.filter((s) => s.id !== this.selected);
          if (!others.length) { U.toast("Only one run archived so far.", "warn"); return; }
          this.compareOpen = true;
          this.$nextTick(() => {
            if (!this.$refs.comparePick) return;
            U.combobox(this.$refs.comparePick, {
              placeholder: "Pick a run to compare against…",
              options: () => others.map((s) => ({
                id: s.id, name: s.id, search: `${s.id} ${s.mode} ${s.status}`,
                sub: `${s.mode} · seed ${s.seed} · ${U.fmtTok((s.totals || {}).usage?.totalTokens || 0)} tok`,
              })),
              value: () => this.compareWith,
              onChange: (id) => this.compareWith = id,
            });
            U.toast("Pick the run to compare against.", "info", 2500);
          });
        },

        /* --------------------------- derived bits --------------------------- */
        meta() { return (this.data && this.data.meta) || {}; },
        compareMeta() { return (this.compareData && this.compareData.meta) || {}; },
        metaOutcome() { return this.meta().outcome || {}; },
        metaTotals() { return this.meta().totals || {}; },
        metaUsage() { return this.metaTotals().usage || {}; },
        checkpoints() { return (this.meta().checkpoints || []).slice().reverse(); },
        archiveEvents() { return (this.data && this.data.events) || []; },
        stepsAll() { return ((this.data && this.data.telemetry) || {}).steps || []; },

        /** Success-rate tooltip; only meaningful once something completed. */
        successTitle() {
          const t = this.totals();
          if (!t.done) return "No completed runs yet";
          const built = this.sessions.filter(
            (s) => s.status === "completed" && (s.outcome || {}).constructionDone === true,
          ).length;
          return `${built} of ${t.done} completed runs reached construction-done`;
        },

        /** 存档信息（服务端给：路径 + 是否已落盘）；null = 服务端没给这条信息。 */
        savegameInfo() { return (this.data && this.data.savegame) || null; },
        savegamePath() { const sg = this.savegameInfo(); return sg && sg.path ? sg.path : "—"; },
        /** 列表项的索引事实（模块级纯函数；不为每行新建 model）。 */
        runFacts(session) { return window.SessionsView.runFacts(session); },
        /**
         * 存档状态一句话。**"还没写"不等于"路径不存在"**：
         * 路径照给（用户可以先去看目录），只是文件还没落盘。
         */
        savegameLine() {
          const sg = this.savegameInfo();
          if (!sg) return "the server did not report a savegame for this run";
          if (!sg.exists) return "not written yet — the run saves when it ends (or from the live page's controls)";
          return `${U.fmtInt(sg.bytes)} bytes · written ${U.fmtAgo(sg.mtimeMs)}`;
        },
        async copySavegame() {
          const sg = this.savegameInfo();
          if (!sg || !sg.path) return;
          try {
            await navigator.clipboard.writeText(sg.path);
            this.copied = "savegame";
            setTimeout(() => { if (this.copied === "savegame") this.copied = ""; }, 1500);
          } catch {
            U.toast("Could not copy — select the path and copy manually.", "warn", 3000);
          }
        },

        /**
         * 结局/条件的**诚实表**：只列这一局真记下来的字段，缺的显示 "—"。
         * 为什么集中在这里：这些字段（delivered/gsErrors/horizon/freeze…）
         * 曾经只散落在离线脚本里，页面上看不到 —— 于是"人工审核一局"必须打开 JSONL。
         */
        outcomeRows() {
          const o = this.metaOutcome();
          const m = this.meta();
          // 暂停收场优先显示：这类局不是"没学会"，而是**被自己按停的**（SPEC §10.101），
          // 人工审核与离线统计都必须能一眼把它挑出来。
          if (o.blockedByPause === true) {
            return [
              { k: "Ended while paused", v: `yes — paused by the ${o.pausedBy === "agent" ? "agent itself (set_pause)" : o.pausedBy || "someone"}${o.pausedAt ? " at " + new Date(o.pausedAt).toISOString().slice(0, 16).replace("T", " ") : ""}` },
              { k: "Status", v: String(m.status || "—") },
              { k: "Treat as", v: "NOT a learning result — filter it out of averages" },
            ];
          }
          // W2（SPEC §10.102）：世界冻住 —— 没有人停它，是世界自己不动了。
          // 与上面**原因不同**，所以分开写：审核者需要能一眼分清这两类局。
          if (o.worldFrozen === true) {
            const secs = typeof o.worldFrozenMs === "number" ? Math.round(o.worldFrozenMs / 1000) : null;
            return [
              { k: "Ended with the world frozen", v: `yes — no game-day advance for ${secs === null ? "an unrecorded span" : secs + " s"} while nothing held it` },
              { k: "Status", v: String(m.status || "—") },
              { k: "Treat as", v: "NOT a learning result — the environment stopped, not the agent" },
            ];
          }
          const f = m.freeze || null;
          const num = (v) => (v === null || v === undefined || v === "" ? "—" : U.fmtInt(v));
          const money = (v) => (v === null || v === undefined ? "—" : U.fmtMoney(v));
          const rows = [
            { k: "Construction done", v: o.constructionDone === true ? "yes" : o.constructionDone === false ? "no" : "—" },
            { k: "Delivered cargo (all time)", v: num(o.delivered) },
            { k: "Delivered in run", v: num(o.deliveredRun) + (o.deliveredRunComplete === true ? " (settled)" : o.deliveredRunComplete === false ? " (not settled)" : "") },
            { k: "Income (last year)", v: money(o.income) },
            { k: "Last phase", v: o.phase || "—" },
            { k: "Road only?", v: o.scenario ? `${o.scenario}${o.scenarioReason ? ` · ${o.scenarioReason}` : ""}` : "—" },
            { k: "Horizon", v: o.simulatedDays === undefined || o.simulatedDays === null ? "—" : `${U.fmtInt(o.simulatedDays)} game days${o.horizonDays ? ` of ${U.fmtInt(o.horizonDays)}` : ""}${o.reachedHorizon === false ? " · NOT reached" : ""}` },
            { k: "GS errors", v: num(o.gsErrors) },
            { k: "Tool-budget blocks", v: num(o.toolBudgetBlocks) },
            { k: "Arm", v: m.arm || "—" },
            { k: "Freeze (verified)", v: f ? `${U.fmtInt(f.confirmed)} confirmed · ${U.fmtInt(f.unconfirmed)} unconfirmed · ${U.fmtInt(f.failures)} failed` : "—" },
          ];
          // 全部为 "—" 的行没有信息量，删掉（页面不该用一排破折号假装有内容）。
          return rows.filter((r) => r.v !== "—" && r.v !== " (not settled)" && r.v !== " (settled)");
        },

        brainText() {
          const llm = this.meta().llm;
          return llm ? `${llm.kind} · ${llm.providerId || "—"} / ${llm.model || "—"}` : "—";
        },

        stepTitle(s) {
          return s.kind === "tool" ? `${s.tool} — ${s.summary || ""}` : (s.model || "assistant");
        },

        /** One-line summary for a list row (kept here: it is presentation, not rule). */
        runSummary(s) {
          const t = s.totals || {};
          const o = s.outcome || {};
          const u = t.usage || {};
          const fail = t.toolFailures
            ? ` (${U.fmtInt(t.toolFailures)} failed)` : "";
          return `${U.fmtMoney(o.money)} · ${U.fmtInt(o.vehicles)} veh · ${U.fmtInt(o.stations)} stn · ` +
            `${U.fmtInt(t.decisions)} decisions · ${U.fmtInt(t.toolCalls)} tools${fail} · ` +
            `${U.fmtTok(u.totalTokens)} tok · ${U.fmtCost(u.costTotal)}`;
        },

        /** Events matching the search box, newest first, capped for the DOM. */
        shownEvents() {
          const q = this.evSearch.trim();
          const all = this.archiveEvents();
          const filtered = q ? all.filter((e) => U.eventMatches(e, q)) : all;
          return filtered.slice(-120).reverse();
        },

        /* ------------------------------ widgets ------------------------------ */
        /**
         * The donut is a canvas: Alpine cannot express it, so it is drawn
         * imperatively via `x-effect` whenever the slices change.
         *
         * 关键: 响应式读取必须发生在 **effect 同步作用域内**。
         *   曾经把 `tokenSlices()` 写在 `$nextTick` 回调里，结果是
         *   Alpine 追踪不到依赖 → 数据异步到达后 effect 不会重跑 →
         *   **环形图永远不画**（真机实测 canvas painted = 0，而图例正常）。
         *   所以这里先**同步**把要画的数据读出来，再排队绘制。
         */
        drawDonut() {
          const slices = this.tokenSlices(); // reactive read: must stay synchronous
          const total = this.metaUsage().totalTokens;
          const cv = this.$refs.donut; // also reactive: x-ref resolves before x-effect
          if (!cv || !slices.length) return;
          this.$nextTick(() => {
            if (!this.$refs.donut) return;
            C.donut(cv, {
              slices,
              center: { value: U.fmtTok(total), label: "tokens" },
              height: 200,
            });
          });
        },
      };
    });
  });
})();
