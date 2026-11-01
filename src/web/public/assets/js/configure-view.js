/* Configure page — the run knobs and the next-run preview (pure logic).
 *
 * 职责: 把"这一局用什么旋钮"与"下一次会用什么"这两件事的**推导**集中为可测逻辑：
 *   表单里的值怎么变成请求体、预览表每一行显示什么、非法旋钮时用户看到什么。
 *   模板只做声明式渲染。
 *
 * 铁律（AGENTS §5.2 / docs/FRONTEND.md）:
 *   - **前端不归一化、不校验**：表单里的值原样发给服务端，由服务端解析与判定。
 *     页面抄一份规则就会和服务器漂移（"页面说 12、服务器收到 12"）。
 *   - **显示的一切来自服务端**：预览的每一行都来自 `/api/run/preview` 的回答，
 *     页面不自己算 manifest。
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.4；docs/DASHBOARD-API.md §3.2。
 */
"use strict";
(function () {
  const U = window.UI;

  /** The knob fields the form offers (the names are the server's). */
  const KNOB_FIELDS = [
    { key: "seed", label: "Seed", hint: "blank = the server's seed" },
    { key: "gameDays", label: "Game days", hint: "blank = no horizon" },
    { key: "scenario", label: "Scenario", options: ["freeform", "prebuilt"] },
    { key: "memoryArm", label: "Memory arm", options: ["treatment", "control"] },
    { key: "thinkingLevel", label: "Thinking", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { key: "toolBudget", label: "Tool budget", hint: "tool calls per decision" },
    { key: "tokenLimit", label: "Token cap", hint: "blank = no cap" },
    { key: "costLimit", label: "Cost cap", hint: "blank = no cap (USD)" },
    { key: "backend", label: "Backend", options: ["agent", "harness"] },
  ];

  /**
   * The label of the "keep the server's setting" option.
   *
   * Every field starts blank — including the **selects**. Otherwise a select
   * would always carry a value, and "the page did not touch this knob" would
   * be indistinguishable from "the page set it to the default" — the process's
   * own setting would be silently overridden by a form default.
   */
  const BLANK_LABEL = "(server default)";

  function create() {
    return {
      /* ------------------------------ state ------------------------------ */
      /** The form's values, exactly as typed (strings). */
      knobs: {
        seed: "",
        gameDays: "",
        scenario: "",
        memoryArm: "",
        thinkingLevel: "",
        toolBudget: "",
        tokenLimit: "",
        costLimit: "",
        backend: "",
      },
      /** The server's answer: what the next run would use. */
      preview: null,
      /** Structured reasons the server gave (code + message + hint). */
      problems: [],
      /**
       * 这个选择还**不能**预览：服务端说"还没选模型"（不是错误）。
       *
       * 为什么要单独一个字段（2026-11-01 审计 A13）：初装时预览接口曾返回
       * `unknown_provider`，页面立刻红着报错——用户一个字段都没碰。
       * 空选择是状态，配错才是问题；服务端用 `needs` 区分，页面照抄。
       */
      needs: null,
      previewError: "",
      previewing: false,
      /**
       * The request sequence number of the LAST preview request.
       *
       * Why: the panel answers "what the next run will use". If two requests
       * overlap (the user keeps typing), the slower one can land LAST and
       * overwrite the newer answer with an older one — the panel would then
       * describe a run the user is no longer about to make. A response that is
       * not the newest is dropped.
       */
      previewSeq: 0,
      /** The debounce handle for the auto-refresh (null = none pending). */
      previewTimer: null,
      /** How long the page waits after the last edit before asking again (ms). */
      previewDebounceMs: 250,
      /** True while the Start request is in flight. */
      runBusy: false,
      /** What the last Start attempt said. */
      runMsg: { text: "", kind: "" },

      /* ------------------------------ fields ----------------------------- */
      /** The knob fields the form renders (labels + hints come from here). */
      knobFields() {
        return KNOB_FIELDS;
      },

      /** The label of the "keep the server's setting" option (one place). */
      blankLabel() {
        return BLANK_LABEL;
      },

      /**
       * The request body for the preview and for Start.
       *
       * The values go out **as typed**: an empty field is omitted (so the
       * server keeps the process default), and everything else is sent as the
       * string the user typed. The server parses and validates.
       */
      knobBody() {
        const knobs = {};
        for (const field of KNOB_FIELDS) {
          const value = this.knobs[field.key];
          if (value === undefined || value === null) continue;
          const text = String(value).trim();
          if (text === "") continue;
          knobs[field.key] = text;
        }
        return { knobs };
      },

      /* ------------------------------ preview ---------------------------- */
      /**
       * Ask the server again after the knobs changed.
       *
       * Why the page asks on its own: the preview panel says "what the next
       * run will use". If the knobs change and the panel keeps the old
       * numbers, it **lies** — it describes a run the user is no longer about
       * to make. Debounced, because typing is many events and each one must
       * not become a request.
       */
      schedulePreview() {
        if (this.previewTimer) clearTimeout(this.previewTimer);
        this.previewTimer = setTimeout(() => {
          this.previewTimer = null;
          void this.refreshPreview();
		}, this.previewDebounceMs);
      },

      /**
       * The rows of the "next run" table.
       *
       * Everything here comes from the server's answer — the page never
       * recomputes a manifest (a page-side copy would drift from the run).
       */
      previewRows() {
        const p = this.preview;
        if (!p) return [];
        const rows = [
          ["Model", `${p.providerId || "—"} / ${p.model || "—"}`],
          ["API", p.api || "—"],
          ["Context", U.fmtTok(p.contextWindow) + " in / " + U.fmtTok(p.maxTokens) + " out"],
          ["Price", p.costKnown ? "known" : "unknown (not measured)"],
          ["Seed", p.seed === null || p.seed === undefined ? "—" : String(p.seed)],
          ["Game days", p.gameDays === null || p.gameDays === undefined ? "no horizon" : String(p.gameDays)],
          ["Scenario", p.scenario || "—"],
          ["Memory arm", p.memoryArm || "—"],
          ["Thinking", p.thinkingLevel || "—"],
          ["Tool budget", U.fmtInt(p.toolBudget)],
          ["Token cap", p.tokenLimit === null || p.tokenLimit === undefined ? "no cap" : U.fmtInt(p.tokenLimit)],
          ["Cost cap", p.costLimit === null || p.costLimit === undefined ? "no cap" : `$${p.costLimit}`],
          ["Backend", p.backend || "—"],
          ["Scaffold", (p.scaffoldHash || "").slice(0, 8)],
        ];
        return rows;
      },

      /**
       * What the page says about the preview.
       *
       * Three states, all of them explained: no preview yet, a preview, or a
       * refusal with the server's reasons. A silent empty panel reads as
       * "the app is broken" (MEMORY B8: 沉默的禁用按钮等于一个 bug).
       */
      previewStatus() {
        if (this.previewing) return { kind: "idle", text: "Resolving what the next run would use…" };
        // "还没选模型"先于任何错误显示：它是下一步动作，不是失败。
        if (this.needs) {
          return {
            kind: "idle",
            text: `${this.needs.message || ""} ${this.needs.hint || ""}`.trim(),
          };
        }
        if (this.problems.length) {
          return { kind: "err", text: this.problems.map((p) => p.message).join(" · ") };
        }
        if (this.previewError) return { kind: "err", text: this.previewError };
        if (this.preview) return { kind: "ok", text: "Applies to the next run." };
        return { kind: "idle", text: "No preview yet." };
      },

      /**
       * 顶部摘要卡：**下一局会用什么**（审计 A13，页面唯一的主角）。
       *
       * 四个值全部来自服务端的预览（`/api/run/preview`），页面不重算：
       *   Model / Caps / Price / Backend。
       * 还没有预览时写 "not configured" / "not measured"，不写 0 也不写猜测。
       */
      summaryTiles() {
        const p = this.preview;
        if (!p) {
          return [
            { k: "Model", v: "not configured", hint: "pick a provider and a model below" },
            { k: "Caps", v: "not measured", hint: "the next run's limits are unknown until a model is chosen" },
            { k: "Price", v: "not measured", hint: "whether the spend is measurable depends on the model" },
            // backend 是旋钮（与模型无关），但它的**生效值**只有服务端解析得出；
            // 没有预览时不编一个默认值，写 "—"（未知 ≠ agent）。
            { k: "Backend", v: "—", hint: "the server resolves this with the run" },
          ];
        }
        const caps = [];
        if (p.tokenLimit === null || p.tokenLimit === undefined) caps.push("no token cap");
        else caps.push(`${U.fmtTok(p.tokenLimit)} token cap`);
        if (p.costLimit === null || p.costLimit === undefined) caps.push("no cost cap");
        else caps.push(`$${p.costLimit} cost cap`);
        return [
          {
            k: "Model",
            v: `${p.providerId || "—"} / ${p.model || "—"}`,
            hint: p.api || "",
          },
          { k: "Caps", v: caps.join(" · "), hint: "" },
          {
            k: "Price",
            v: p.costKnown === false ? "unknown" : "known",
            hint: p.costKnown === false ? "no price table: a cost cap cannot be enforced" : "",
          },
          {
            k: "Backend",
            v: p.backend || "—",
            hint: p.scaffoldHash ? `scaffold ${String(p.scaffoldHash).slice(0, 8)}` : "",
          },
        ];
      },

      /** 空选择时 Start 的真实原因（禁用按钮必须说得出理由，MEMORY B8）。 */
      startBlockedReason() {
        return this.needs ? this.needs.hint || this.needs.message || "" : "";
      },

      /** 能不能点 Start（服务端说还没选模型时就别假装能跑）。 */
      canStart() {
        return !this.runBusy && !this.needs;
      },

      /** The actionable hints the server gave (one per problem). */
      problemHints() {
        return this.problems.map((p) => ({
          code: p.code || "",
          message: p.message || "",
          hint: p.hint || "",
        }));
      },

      /* ------------------------------ actions ---------------------------- */
      /**
       * Ask the server what the next run would use.
       *
       * The answer is rendered as-is; the page does not compute it.
       */
      async refreshPreview() {
        this.previewing = true;
        this.previewError = "";
        const seq = ++this.previewSeq;
        try {
          const r = await fetch("/api/run/preview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(this.knobBody()),
          });
          const out = await r.json().catch(() => ({}));
          // A slower, older request must not overwrite a newer answer.
          if (seq !== this.previewSeq) return;
          if (!r.ok) {
            // A refusal carries `problems[]`; anything else is a plain error.
            this.problems = Array.isArray(out.problems) ? out.problems : [];
            this.needs = null;
            this.preview = null;
            this.previewError = this.problems.length ? "" : String(out.error || `HTTP ${r.status}`);
            return;
          }
          this.problems = Array.isArray(out.problems) ? out.problems : [];
          this.needs = out.needs && typeof out.needs === "object" ? out.needs : null;
          this.preview = out.preview || null;
        } catch (e) {
          if (seq !== this.previewSeq) return;
          this.preview = null;
          this.previewError = `Preview failed: ${e}`;
        } finally {
          if (seq === this.previewSeq) this.previewing = false;
        }
      },

      /**
       * Start a run **with these knobs**.
       *
       * The knobs travel with the request, so the run and the preview above
       * describe the same thing (one request shape, one server-side resolution).
       * The page does not re-check anything: the server's refusal is shown as-is.
       */
      async startRun() {
        this.runBusy = true;
        this.runMsg = { text: "", kind: "" };
        try {
          const r = await fetch("/api/run/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "agent", ...this.knobBody() }),
          });
          const out = await r.json().catch(() => ({}));
          if (!r.ok) {
            const problems = Array.isArray(out.problems) ? out.problems : [];
            this.problems = problems;
            this.runMsg = {
              text: problems.length
                ? problems.map((p) => `${p.message}${p.hint ? ` — ${p.hint}` : ""}`).join("; ")
                : String(out.error || `HTTP ${r.status}`),
              kind: "err",
            };
            U.toast("Could not start the run", "err");
            return;
          }
          this.runMsg = { text: "Run started with these settings.", kind: "ok" };
          U.toast("Run started", "ok");
        } catch (e) {
          this.runMsg = { text: `Start failed: ${e}`, kind: "err" };
          U.toast("Start failed: " + e, "err");
        } finally {
          this.runBusy = false;
        }
      },
    };
  }

  window.ConfigureView = { create: create, KNOB_FIELDS: KNOB_FIELDS };
})();
