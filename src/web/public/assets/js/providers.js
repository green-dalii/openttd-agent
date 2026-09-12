/* Providers page — Alpine component (data loading + imperative widgets).
 *
 * 职责: 只做两件事 ——
 *   1) 与 `/api/llm`、`/api/llm/catalog` 交换数据，灌进 view model
 *   2) 挂载必须命令式创建的部件：两个搜索下拉（provider / model）与分段开关
 *   所有"该显示什么"的判断在 providers-view.js 里（可单测）。
 *
 * 为什么下拉仍是命令式的（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.2）:
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

      return {
        ...model,

        /* ------------------------------ state ------------------------------ */
        saving: false,
        provCbx: null,
        modelCbx: null,

        /* ------------------------------- init ------------------------------- */
        async init() {
          U.renderNavInto("nav", "/providers");
          await this.loadCatalog();
          await this.loadSettings();
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
            onChange: (id) => {
              this.custom = id === "custom";
              // The selects are hidden with x-show, so just refresh their labels.
              if (this.provCbx) this.provCbx.refresh();
              if (this.modelCbx) this.modelCbx.refresh();
            },
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
              this.providerId = sel.providerId || "";
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
              this.setMsg("Save failed: " + (out.error || r.status), "err");
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
