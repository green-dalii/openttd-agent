/* Providers page — Alpine component (data loading + imperative widgets).
 *
 * 职责: 只做三件事 ——
 *   1) 与 `/api/llm`、`/api/llm/catalog` 交换数据，灌进 view model
 *   2) 挂载必须命令式创建的部件：两个搜索下拉（provider / model）与分段开关
 *   3) 跑一局的旋钮与预览（B2）：`/api/run/preview` 问服务端"下一次会用什么"，
 *      `/api/run/start` 把**同一份**旋钮带去启动。
 * 所有"该显示什么"的判断在 providers-view.js / configure-view.js 里（可单测）。
 *
 * 为什么下拉仍是命令式的（docs/FRONTEND.md §3.2）:
 *   provider/model 选择器是 `U.combobox`（本仓库自带的搜索下拉）。阶段 3 曾尝试换成
 *   Tom Select 但集成后下拉渲染为空，已回退；这里沿用**已验证可用**的实现。
 *   Alpine 负责页面其余部分，两者通过 `$refs` 挂载点衔接。
 *
 * 事实来源: docs/DASHBOARD-API.md §6（/api/llm 与 catalog 形状）、§6.3（env key 探测）。
 * 禁止: 在此写展示规则（放 providers-view.js）；**不把密钥回显到页面**。
 */
"use strict";
(function () {
  const U = window.UI;

  document.addEventListener("alpine:init", function () {
    window.Alpine.data("providers", function () {
      const model = window.ProvidersView.create();
      // The run knobs + the next-run preview (B2). A **separate** view module:
      // the knobs have their own rules (and their own tests), and folding them
      // into providers-view.js would make that file a grab bag.
      const run = window.ConfigureView.create();

      return {
        ...model,
        ...run,

        /* ------------------------------ state ------------------------------ */
        saving: false,
        provCbx: null,
        modelCbx: null,
        /** True while asking the provider for its current model list. */
        modelsRefreshing: false,
        /** What the last refresh said (error, or "N models, M new"). */
        modelsNote: "",
        /**
         * Why the last refresh did not work, **as the server sent it**
         * (`[{code, message, hint}]`). B5: the page renders by code; it never
         * guesses what an error string meant.
         */
        refreshProblemsList: [],
        /** When the list currently shown was fetched from the provider (ms). */
        modelsFetchedAt: 0,

        /* ------------------------------- init ------------------------------- */
        async init() {
          U.renderChrome();
          await this.loadCatalog();
          await this.loadSettings();
          // The preview is asked for **once** on load: the page must show what
          // the next run would use, not an empty panel (an empty panel reads as
          // "broken" — MEMORY B8).
          await this.refreshPreview();
          this.$nextTick(() => {
            this.mountMode();
            this.mountCombos();
          });
        },

        /**
         * The Built-in / Custom-endpoint switch.
         *
         * Imperative because `U.segmented` is shared with other pages. Dropping
         * this call silently removed the only way to switch modes — the control
         * rendered as an empty div with no error anywhere.
         */
        mountMode() {
          const el = document.getElementById("p-mode");
          if (!el || el.childElementCount) return;
          U.segmented(el, {
            options: [
              { id: "catalog", label: "Built-in", hint: "Use one of pi-ai's 39 providers" },
              { id: "custom", label: "Custom endpoint", hint: "Your own OpenAI-compatible server" },
            ],
            value: () => (this.custom ? "custom" : "catalog"),
            // setMode (view model) keeps the catalog/custom selections apart and
            // refreshes the selects, which are hidden rather than unmounted.
            onChange: (id) => this.setMode(id),
          });
        },

        /** Mount the searchable selects (imperative, so they live here). */
        mountCombos() {
          if (this.$refs.provBox && !this.provCbx) {
            this.provCbx = U.combobox(this.$refs.provBox, {
              placeholder: "Search providers… (deepseek, openai, google…)",
              empty: "No provider matches that search.",
              options: () => this.providerOptions(),
              groups: (o) => o.group,
              sort: (a, b) => String(a.group).localeCompare(String(b.group)) || String(a.id).localeCompare(String(b.id)),
              value: () => this.providerId,
              onChange: (id) => this.selectProvider(id),
            });
          }
          if (this.$refs.modelBox && !this.modelCbx) {
            this.modelCbx = U.combobox(this.$refs.modelBox, {
              placeholder: this.modelPlaceholder(),
              empty: "No model matches that search.",
              options: () => this.modelOptions(),
              value: () => this.model,
              onChange: (id) => { this.model = id; },
            });
          }
        },

        /* ------------------------------ catalog ------------------------------ */
        async loadCatalog() {
          try {
            const r = await fetch("/api/llm/catalog");
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            this.providers = data.providers || [];
            this.catalogError = "";
          } catch (e) {
            this.providers = [];
            this.catalogError = `Catalog unavailable: ${e}`;
          }
          if (this.provCbx) this.provCbx.refresh();
        },

        async loadSettings() {
          try {
            const r = await fetch("/api/llm");
            if (!r.ok) return;
            const s = await r.json();
            const sel = s.selection || {};
            this.custom = sel.source === "custom";
            if (sel.baseUrl) this.form.baseUrl = sel.baseUrl;
            if (sel.api) this.form.api = sel.api;
            if (sel.model) this.form.model = sel.model;
            if (this.custom) {
              // Remember the catalog choice from a previous switch when there is one,
              // so flipping modes does not lose it.
              this.providerId = this.lastCatalogProvider || "";
            } else if (sel.providerId) {
              await this.selectProvider(sel.providerId);
              if (sel.model) this.model = sel.model;
            }
            // Explicit env vars beat both files; say so rather than silently differing.
            if (s.status && s.status.appliedFrom === "env") {
              U.toast("LLM_* environment variables are overriding the saved file.", "warn", 6000);
            }
          } catch {
            /* keep defaults */
          }
          if (this.modelCbx) this.modelCbx.refresh();
        },

        /**
         * Ask the provider what it has right now (P5).
         *
         * The bundled list is a snapshot of the pi-ai package, so it cannot know a
         * model released later. This hits the provider's own /models endpoint via
         * the server, which merges the result into the persisted overlay.
         */
        async refreshModels() {
          const id = this.custom ? "" : this.providerId;
          if (!id) {
            this.modelsNote = this.custom
              ? "Custom endpoints have no provider id - the list is read from the endpoint below."
              : "Pick a provider first.";
            return;
          }
          this.modelsRefreshing = true;
          this.modelsNote = "";
          this.refreshProblemsList = [];
          try {
            const r = await fetch(`/api/llm/catalog/${encodeURIComponent(id)}/refresh`);
            const data = await r.json().catch(() => ({}));
            if (data && Array.isArray(data.models)) this.models = data.models;
            this.modelsFetchedAt = Number(data.fetchedAt || 0);
            // The reasons come structured (code + message + hint).
            this.refreshProblemsList = Array.isArray(data && data.problems) ? data.problems : [];
            if (this.refreshProblemsList.length) {
              this.modelsNote = "The provider did not answer with a model list.";
              U.toast("Could not refresh the model list", "warn", 6000);
            } else {
              const live = this.models.filter((m) => m && m.source === "live").length;
              this.modelsNote = live
                ? `${this.models.length} models (${live} newer than this build's snapshot)`
                : `${this.models.length} models - this build's snapshot is current`;
              U.toast("Model list refreshed", "ok");
            }
          } catch (e) {
            this.modelsNote = `Refresh failed: ${e}`;
            U.toast("Could not refresh the model list", "err");
          }
          this.modelsRefreshing = false;
          if (this.modelCbx) this.modelCbx.refresh();
        },

        async selectProvider(id) {
          this.providerId = id;
          this.models = [];
          this.model = "";
          this.modelsLoading = true;
          if (this.modelCbx) this.modelCbx.refresh();
          if (this.provCbx) this.provCbx.refresh();
          try {
            const r = await fetch(`/api/llm/catalog/${encodeURIComponent(id)}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            this.models = Array.isArray(data.models) ? data.models : [];
          } catch (e) {
            U.toast(`Could not load models for ${id}: ${e}`, "err");
            this.models = [];
          }
          this.modelsLoading = false;
          if (this.modelCbx) this.modelCbx.refresh();
        },

        /* ---------------------------- save / clear ---------------------------- */
        async save() {
          this.setMsg("");
          this.saving = true;
          try {
            const r = await fetch("/api/llm", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(this.saveBody()),
            });
            const out = await r.json().catch(() => ({}));
            if (!r.ok) {
              // B5: a refusal carries `problems[]` (code + message + hint) — show
              // what to do, not just the sentence the server produced.
              const problems = Array.isArray(out && out.problems) ? out.problems : [];
              const text = problems.length
                ? problems.map((p) => `${p.message}${p.hint ? " — " + p.hint : ""}`).join("; ")
                : String((out && out.error) || r.status);
              this.setMsg("Save failed: " + text, "err");
              U.toast("Save failed", "err");
              return;
            }
            // Never keep the secret in the page after a successful save.
            this.catalogKey = "";
            this.form.key = "";
            await this.loadCatalog();
            this.setMsg("Saved — applies on the next agent run.", "ok");
            U.toast("Configuration saved. It applies on the next agent run.", "ok");
          } catch (e) {
            this.setMsg("Save failed: " + e, "err");
            U.toast("Save failed: " + e, "err");
          } finally {
            this.saving = false;
          }
        },

        async clearKey() {
          if (!this.providerId) { this.setMsg("Pick a provider first.", "err"); return; }
          const ok = await U.confirmDialog({
            title: "Clear the stored key?",
            body:
              `The credential stored for "${this.providerId}" will be removed from credentials.json. ` +
              `If an environment variable provides the key, that is unaffected.`,
            confirm: "Clear key",
          });
          if (!ok) return;
          try {
            const r = await fetch(`/api/llm/credentials/${encodeURIComponent(this.providerId)}`, { method: "DELETE" });
            if (!r.ok) { this.setMsg(`Clear failed: HTTP ${r.status}`, "err"); return; }
            await this.loadCatalog();
            this.setMsg("Stored key cleared.", "ok");
            U.toast("Stored key cleared.", "ok");
          } catch (e) {
            this.setMsg("Clear failed: " + e, "err");
          }
        },
      };
    });
  });
})();
