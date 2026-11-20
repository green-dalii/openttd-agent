/**
 * Evolution page component — IO + imperative widgets for the memory view.
 *
 * 职责: 拉取 `/api/evolution`、驱动开关、挂载图表。所有推导在
 *   `evolution-view.js`（纯，可单测）；所有**规则判定**在服务端
 *   (`src/evolution/web-view.ts`)。
 * 事实来源: docs/DASHBOARD-API.md §3.5、docs/EVOLUTION.md、SPEC §6.1 #4。
 * 禁止: 在此实现 promotion 门槛或"样本是否足够"的判定（服务端唯一）。
 */

(function () {
  const U = window.UI;
  const C = window.Charts;

  document.addEventListener("alpine:init", function () {
    window.Alpine.data("evolution", function () {
      const model = window.EvolutionView.create();

      return {
        ...model,

        /** Which axis the capability chart draws (one at a time). */
        capabilityMetric: "delivered",
        capabilityDenom: "line",

        init() {
          U.renderChrome();
          this.load();
        },

        /** Fetch the whole view. The server returns everything annotated. */
        async load() {
          this.loading = true;
          this.error = null;
          try {
            const r = await fetch("/api/evolution", { headers: { accept: "application/json" } });
            if (!r.ok) throw new Error(r.status === 404 ? "evolution API is disabled" : `HTTP ${r.status}`);
            this.data = await r.json();
          } catch (e) {
            this.error = `Could not load the memory view: ${e instanceof Error ? e.message : String(e)}`;
          } finally {
            this.loading = false;
          }
        },

        /**
         * Toggle a card's human confirmation flag.
         *
         * SPEC §5.3: this is the only write in the whole memory system, and it is
         * performed by a person. On success we reload rather than mutating the
         * local copy, so the page can never claim a state the server did not
         * actually persist.
         */
        async toggle(id, enabled) {
          this.busy = id;
          try {
            const r = await fetch(`/api/evolution/strategies/${encodeURIComponent(id)}/enabled`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            await this.load();
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (U.toast) U.toast(`Could not update the strategy: ${msg}`, "error");
          } finally {
            this.busy = null;
          }
        },

        /** Cash per finished game. Reads synchronously so the effect can track it. */
        /**
         * 运营利润/日 的折线（独立的一张图）。
         *
         * 为什么不用现金那张图：单位不同（£/天 vs £）⇒ 共用一把尺子会让
         * "哪条更高"变成单位换算的假象。缺读数是 null（图上是断点），不是 0。
         */
        drawOperating() {
          const series = this.operatingSeries();
          const labels = this.operatingLabels();
          const el = this.$refs.evoOpChart;
          if (!el) return;
          this.$nextTick(() => {
            if (!this.$refs.evoOpChart) return;
            C.line(el, {
              series,
              labels,
              format: U.fmtMoney,
              area: false,
              height: 200,
            });
          });
        },

        /**
         * The capability chart: what one line (or one vehicle) delivered and
         * earned.
         *
         * The state (`capabilityMetric` / `capabilityDenom`) lives here so the
         * template's buttons can change it; `x-effect` re-runs the draw when
         * they change. One axis at a time - the units differ.
         */
        drawCapability() {
          const series = this.capabilitySeries(this.capabilityMetric, this.capabilityDenom);
          const labels = this.capabilityLabels();
          const el = this.$refs.evoCapChart;
          if (!el) return;
          this.$nextTick(() => {
            if (!this.$refs.evoCapChart) return;
            C.line(el, {
              series,
              labels,
              // A count and a money rate are different units ⇒ different format.
              format: this.capabilityMetric === "operating" ? U.fmtMoney : U.fmtInt,
              area: false,
              height: 200,
            });
          });
        },

        drawCurve() {
          // Read the reactive data BEFORE the async boundary, or Alpine cannot see
          // the dependency and the effect never re-runs (MEMORY.md B3).
          const series = this.moneySeries();
          const labels = this.moneyLabels();
          const el = this.$refs.evoChart;
          if (!el) return;
          this.$nextTick(() => {
            if (!this.$refs.evoChart) return;
            C.line(el, {
              series,
              labels,
              format: U.fmtMoney,
              area: series.length === 1,
              height: 240,
            });
          });
        },
      };
    });
  });
})();
