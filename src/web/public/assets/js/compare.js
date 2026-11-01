/* Compare page — the Alpine component (IO only).
 *
 * 职责: 取一次 `/api/compare`，把回答**原样**交给 view module 画。
 * 铁律: 组件**不做任何判断**（不算轴、不算判定、不改文案）——那些是服务端的规则
 *   （scorecard.ts / bench-stats.ts）。组件只发请求、收回答、传给 view。
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.2；docs/DASHBOARD-API.md §3.9。
 */
"use strict";
(function () {
  const U = window.UI;

  document.addEventListener("alpine:init", function () {
    window.Alpine.data("compare", function () {
      return {
        /* ------------------------------ state ------------------------------ */
        /** The server's answer (the whole payload). */
        payload: null,
        loading: false,
        error: "",
        /** The two models the user picked for the paired comparison. */
        picked: [],

        /* ------------------------------- init ------------------------------- */
        async init() {
          U.renderChrome();
          await this.load();
        },

        /**
         * Ask the server for the comparison.
         *
         * The two picked models are sent as `models` so the server computes the
         * paired verdict for **that** pair — the page never pairs anything itself.
         */
        async load() {
          this.loading = true;
          this.error = "";
          try {
            const params = new URLSearchParams();
            if (this.picked.length === 2) params.set("models", this.picked.join(","));
            const qs = params.toString();
            const r = await fetch(`/api/compare${qs ? "?" + qs : ""}`);
            if (!r.ok) {
              const out = await r.json().catch(() => ({}));
              this.error = String(out.error || `HTTP ${r.status}`);
              this.payload = null;
              return;
            }
            this.payload = await r.json();
          } catch (e) {
            this.error = `Compare failed: ${e}`;
            this.payload = null;
          } finally {
            this.loading = false;
          }
        },

        /** Compare the two picked models (the server does the pairing). */
        async comparePicked() {
          if (this.picked.length !== 2) return;
          await this.load();
        },

        /* ------------------------------ view ------------------------------- */
        /** The model rows (four axes each). */
        modelRows() {
          return window.CompareView.modelRows(this.payload);
        },

        /** The exclusion counts by reason. */
        exclusionRows() {
          return window.CompareView.exclusionRows(this.payload);
        },

        /** The server's paired verdict (null when none). */
        comparison() {
          return window.CompareView.comparison(this.payload);
        },

        /** The runs (the drill-down list). */
        runRows() {
          return window.CompareView.runRows(this.payload);
        },

        /** The models the user may pick from. */
        modelNames() {
          return window.CompareView.modelNames(this.payload);
        },

        /** The four axes as charts (one per axis, one bar per model). */
        axisCharts() {
          return window.CompareView.axisCharts(this.payload);
        },

        /** The ledger collisions the server reported (rows it had to drop). */
        collisionRows() {
          return window.CompareView.collisionRows(this.payload);
        },

        /** Is there anything to compare? */
        hasRuns() {
          return this.runRows().length > 0;
        },

        /** How many models the Outcomes panel lists. */
        outcomeModelCount() {
          return this.modelRows().filter((r) => r.outcomes.length).length;
        },
      };
    });
  });
})();
