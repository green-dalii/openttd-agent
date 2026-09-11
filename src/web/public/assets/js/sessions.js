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
        detailError: "",
        compareOpen: false,
        evSearch: "",

        /* ------------------------------- init ------------------------------- */
        async init() {
          // Optional: added by alpine-bridge.js. Fall back to plain renderNav
          // so a failed bridge cannot leave the page without navigation.
          if (U.renderNavInto) U.renderNavInto("nav", "/sessions");
          else U.$("nav").innerHTML = U.renderNav("/sessions");
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
