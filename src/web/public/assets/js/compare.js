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

        /* --------------------------- the plan (Issue #48) ------------------- */
        /** The models the plan will run. */
        planModels: [],
        /** The worlds the plan will run on ("4242, 4243"). */
        planSeeds: "",
        /** The horizon every cell uses (empty = the process default). */
        planGameDays: "",
        /** The token cap every cell uses (empty = no cap). */
        planTokenLimit: "",
        /** The cost cap every cell uses (empty = no cap). */
        planCostLimit: "",
        /** The server's plan (null until it answered). */
        plan: null,
        /** The plan's problems (the server's own wording). */
        planProblemsList: [],
        /** The queue's state (which cell runs now). */
        planQueueState: { status: "idle", text: "", cells: [] },
        /** True while a plan request is in flight. */
        planLoading: false,
        /** The plan poll timer (the page watches the queue while it runs). */
        planTimer: null,

        /* ------------------------------- init ------------------------------- */
        async init() {
          U.renderChrome();
          await this.load();
          await this.loadPlanState();
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

        /* --------------------------- the plan (Issue #48) ------------------- */

        /** The models the plan may offer: the ones the ledger knows. */
        planModelNames() {
          return window.CompareView.modelNames(this.payload);
        },

        /** The server's plan summary rows (run count, caps, cost). */
        planSummary() {
          return window.CompareView.planSummary(this.plan);
        },

        /** The plan's cells (one row per run it starts). */
        planCells() {
          return window.CompareView.planCells(this.plan);
        },

        /** The plan's problems (code + message + hint, from the server). */
        planProblems() {
          return window.CompareView.planProblems({ problems: this.planProblemsList });
        },

        /** The queue's state. */
        planQueue() {
          return window.CompareView.planQueueState(this.planQueueState);
        },

        /** The seeds the user typed, as numbers (the server parses them). */
        planSeedList() {
          return String(this.planSeeds || "")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s !== "");
        },

        /** What the plan request carries (the page forwards, it does not judge). */
        planRequest() {
          const body = {
            models: this.planModels,
            seeds: this.planSeedList(),
          };
          if (String(this.planGameDays).trim() !== "") body.gameDays = this.planGameDays;
          if (String(this.planTokenLimit).trim() !== "") body.tokenLimit = this.planTokenLimit;
          if (String(this.planCostLimit).trim() !== "") body.costLimit = this.planCostLimit;
          return body;
        },

        /** Can the plan be launched? (the server still has the last word) */
        planCanLaunch() {
          return (
            this.planModels.length > 0 &&
            this.planSeedList().length > 0 &&
            this.planProblemsList.length === 0 &&
            this.planQueueState.status !== "running"
          );
        },

        /** Why the plan cannot be launched yet (a sentence, not a red alarm). */
        planWhyNot() {
          if (this.planModels.length === 0) return "pick at least one model";
          if (this.planSeedList().length === 0) return "add at least one seed";
          if (this.planQueueState.status === "running") return "a comparison is already running";
          return "preview the plan first";
        },

        /** Ask the server what the plan would run. */
        async previewPlan() {
          this.planLoading = true;
          try {
            const r = await fetch("/api/compare/plan", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(this.planRequest()),
            });
            const out = await r.json().catch(() => ({}));
            this.plan = out.plan || null;
            this.planProblemsList = Array.isArray(out.problems) ? out.problems : [];
          } catch (e) {
            this.plan = null;
            this.planProblemsList = [{ code: "plan_failed", message: `Plan failed: ${e}`, hint: "" }];
          } finally {
            this.planLoading = false;
          }
        },

        /** Launch the plan (after the user confirms the cells). */
        async launchPlan() {
          if (!this.plan) await this.previewPlan();
          if (!this.plan) return;
          const cells = this.planCells();
          const ok = await U.confirmDialog({
            title: `Run ${cells.length} game(s)?`,
            body:
              cells.map((c, i) => `${i + 1}. ${c.model} — seed ${c.seed}`).join("\n") +
              "\n\nEach game is a full run; they run one after another.",
            confirm: "Run the plan",
          });
          if (!ok) return;
          this.planLoading = true;
          try {
            const r = await fetch("/api/compare/launch", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(this.planRequest()),
            });
            const out = await r.json().catch(() => ({}));
            if (!r.ok) {
              this.planProblemsList = Array.isArray(out.problems)
                ? out.problems
                : [{ code: "launch_failed", message: String(out.error || `HTTP ${r.status}`), hint: "" }];
              return;
            }
            this.planProblemsList = [];
            this.planQueueState = out.state || this.planQueueState;
            this.startPlanPolling();
          } catch (e) {
            this.planProblemsList = [{ code: "launch_failed", message: `Launch failed: ${e}`, hint: "" }];
          } finally {
            this.planLoading = false;
          }
        },

        /** Read the queue's state (the server owns it). */
        async loadPlanState() {
          try {
            const r = await fetch("/api/compare/plan");
            if (!r.ok) return;
            this.planQueueState = await r.json();
            if (this.planQueueState.status === "running") this.startPlanPolling();
          } catch {
            /* the plan feature may not be wired */
          }
        },

        /** Watch the queue while it runs. */
        startPlanPolling() {
          if (this.planTimer) return;
          this.planTimer = setInterval(async () => {
            await this.loadPlanState();
            if (this.planQueueState.status !== "running") {
              clearInterval(this.planTimer);
              this.planTimer = null;
              // The runs are in the ledger now: refresh the comparison.
              await this.load();
            }
          }, 2000);
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

        /** Different scaffold / observation surface among the compared runs. */
        surfaceDiff() {
          return window.CompareView.surfaceDiff(this.payload);
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
