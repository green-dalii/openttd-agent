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

        init() {
          U.renderNavInto("nav", "/evolution");
          const ver = document.getElementById("app-version");
          if (ver) ver.textContent = window.APP_VERSION ? ` v${window.APP_VERSION}` : "";
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
