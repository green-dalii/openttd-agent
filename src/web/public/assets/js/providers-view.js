/* Providers page — Alpine view model.
 *
 * 职责: 把"选 provider/model、看凭据状态、确认最终生效配置"的**推导**集中为可测逻辑：
 *   凭据面板该说什么、生效配置表的每一行、保存按钮是否可以按、哪些 provider 已就绪。
 *   模板只做声明式渲染。
 *
 * 为什么这样分层（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.4 阶段 4）:
 *   凭据面板的分支最多（env 变量 / 已存 key / 需要 OAuth / 完全没配），而且它决定了
 *   用户下一步做什么。原来这些分支散在 `renderAuth()` 里直接写 DOM，无法单测。
 *   抽成纯推导后，"什么情况下该显示什么"可以被完整锁住。
 *
 * 事实来源: docs/DASHBOARD-API.md §6（/api/llm 与 catalog 形状）、§6.3（env key 探测）。
 * 禁止:
 *   - 在此发请求（页面组件负责 IO）。
 *   - **渲染或回传任何密钥明文**：本文件只处理"有没有 key"这一事实，不保存 key 值。
 */
"use strict";
(function () {
  const U = window.UI;

  /**
   * Create the Providers view model.
   */
  function create() {
    return {
      /* ------------------------------ state ------------------------------ */
      providers: [],
      models: [],
      providerId: "",
      model: "",
      custom: false,
      modelsLoading: false,
      /** Custom-endpoint form fields (also the "effective config" preview). */
      form: { baseUrl: "", api: "openai-completions", model: "", key: "" },
      /** Catalog-mode key input (never echoed back). */
      catalogKey: "",
      msg: { text: "", kind: "" },
      catalogError: "",
      loadWarning: "",

      /* --------------------------- catalog stats --------------------------- */
      providerCount() {
        return this.providers.length;
      },

      /** Providers that can be used right now (env key or stored credential). */
      readyProviders() {
        return this.providers.filter((p) => p.auth && p.auth.configured);
      },

      /** Compact label for the header: "3 / 39". */
      readyCount() {
        return `${this.readyProviders().length} / ${this.providers.length}`;
      },

      /** What the header shows as the current selection. */
      selectionLabel() {
        const model = this.custom ? this.form.model.trim() : this.model;
        if (!this.providerId) return "—";
        return model ? `${this.providerId} / ${model}` : this.providerId;
      },

      /* ------------------------------ panels ------------------------------ */
      catalogFieldsVisible() {
        return !this.custom;
      },
      customFieldsVisible() {
        return this.custom;
      },

      /** The currently selected catalog provider, if any. */
      currentProvider() {
        return this.providers.find((p) => p.id === this.providerId);
      },

      /**
       * What the credentials panel should say.
       *
       * Each branch answers a different question ("can I use this as-is?", "do I
       * need to do something?"), which is why it is computed here rather than
       * branched in the template.
       */
      authPanel() {
        const p = this.currentProvider();
        if (!this.providerId) {
          return {
            badge: "", badgeCls: "",
            hint: "Pick a provider first — a key already in your environment is detected automatically.",
            placeholder: "paste a key",
          };
        }
        const auth = (p && p.auth) || {};
        if (auth.configured && auth.source === "env") {
          return {
            badge: "ready — no action needed", badgeCls: "ok",
            hint:
              `This machine already has ${auth.envVar || "the key"} set, so the agent can use ` +
              `${this.providerId} right away. Only paste a key below if you want this app to use a different one.`,
            placeholder: "(optional) override for this app only",
            envVar: auth.envVar || "",
          };
        }
        if (auth.configured) {
          return {
            badge: "key stored", badgeCls: "ok",
            hint: "A key is stored locally. Leave the field blank when saving to keep it.",
            placeholder: "(stored — leave blank to keep)",
          };
        }
        if (p && p.hint) {
          return {
            badge: "cloud / OAuth", badgeCls: "warn",
            hint: p.hint,
            placeholder: "paste a token if this provider accepts one",
          };
        }
        if (p && p.envKeys && p.envKeys.length) {
          return {
            badge: "needs a key", badgeCls: "bad",
            hint: `No key found. Either export ${p.envKeys.join(" or ")} in your shell, or paste one below.`,
            placeholder: "paste API key",
            envKeys: p.envKeys,
          };
        }
        return {
          badge: "needs a key", badgeCls: "bad",
          hint: "No key found for this provider — paste one below.",
          placeholder: "paste API key",
        };
      },

      /** The solved model object, for the context-window line. */
      currentModel() {
        return this.models.find((x) => x.id === this.model);
      },

      /** The "what will actually be used" table. */
      effectiveRows() {
        const p = this.currentProvider();
        const m = this.currentModel();
        const model = this.custom ? this.form.model.trim() : this.model;
        const auth = (p && p.auth) || {};
        const authText = this.custom
          ? this.form.key.trim()
            ? "key from this form"
            : "no key (server may not need one)"
          : auth.source === "env"
            ? `environment (${auth.envVar || "env"})`
            : auth.configured
              ? "stored credential"
              : "not configured — set a key";
        return [
          ["Mode", this.custom ? "custom OpenAI-compatible endpoint" : "pi-ai built-in provider"],
          ["Provider", this.providerId || "—"],
          ["Model", model || "—"],
          ["API", this.custom ? this.form.api : (m && m.api) || "—"],
          ["Base URL", this.custom ? this.form.baseUrl.trim() || "—" : (p && p.baseUrl) || "(provider default)"],
          ["Context", m ? `${U.fmtTok(m.contextWindow)} in / ${U.fmtTok(m.maxTokens)} out` : "—"],
          ["Auth", authText],
        ];
      },

      /**
       * Whether Save can be pressed.
       *
       * Mirrors what the server will accept, so the button cannot invite a save
       * that is bound to fail.
       */
      saveReady() {
        if (this.custom) {
          return Boolean(this.form.baseUrl.trim() && this.form.model.trim());
        }
        return Boolean(this.providerId && this.model);
      },

      /** Whether a stored key can be cleared (needs a selected provider). */
      canClearKey() {
        if (!this.providerId) return false;
        return !this.custom;
      },

      /** "Why are there no models?" — a loading vs empty distinction. */
      modelPlaceholder() {
        if (this.modelsLoading) return "Loading models…";
        if (!this.providerId) return "Pick a provider first";
        if (!this.models.length) return "No models listed for this provider";
        return "Search models…";
      },

      /** The request body for Save, built in one place so it can be asserted. */
      saveBody() {
        if (this.custom) {
          const body = {
            source: "custom",
            providerId: this.providerId || "custom-endpoint",
            model: this.form.model.trim(),
            api: this.form.api,
            baseUrl: this.form.baseUrl.trim(),
            // An empty string explicitly clears a previously stored custom key.
            apiKey: this.form.key.trim(),
          };
          return body;
        }
        const body = { source: "catalog", providerId: this.providerId, model: this.model };
        const key = this.catalogKey.trim();
        // Blank means "keep whatever is stored", so omit the field entirely.
        if (key) body.apiKey = key;
        return body;
      },

      /** Options for the provider combobox (search across id + apis + env keys). */
      providerOptions() {
        const rank = (p) => {
          if (p.auth && p.auth.configured) return 0;
          if (p.hint) return 2;
          return 1;
        };
        const groupOf = (p) => {
          if (p.auth && p.auth.configured) return "Ready now";
          if (p.hint) return "Needs cloud/OAuth credentials";
          return "Needs an API key";
        };
        return this.providers
          .slice()
          .sort((a, b) => rank(a) - rank(b) || String(a.id).localeCompare(String(b.id)))
          .map((p) => ({
            id: p.id,
            group: groupOf(p),
            search: `${p.id} ${(p.apis || []).join(" ")} ${p.envKeys ? p.envKeys.join(" ") : ""}`,
            sub: this.providerSub(p),
          }));
      },

      /** Secondary line on a provider option: why you can / cannot use it. */
      providerSub(p) {
        const bits = [`${U.fmtInt(p.modelCount)} models`, (p.apis || []).join(", ")];
        if (p.auth && p.auth.source === "env" && p.auth.envVar) bits.push(`env ${p.auth.envVar}`);
        else if (p.auth && p.auth.configured) bits.push("stored key");
        return bits.filter(Boolean).join(" · ");
      },

      /** Options for the model combobox. */
      modelOptions() {
        return this.models.map((m) => ({
          id: m.id,
          search: `${m.id} ${m.name || ""} ${m.api || ""}`,
          sub: m.contextWindow ? `${U.fmtTok(m.contextWindow)} ctx` : "",
        }));
      },

      /** Message setter (single place, so kind/class cannot drift). */
      setMsg(text, kind) {
        this.msg = { text: text || "", kind: kind || "" };
      },
    };
  }

  window.ProvidersView = { create: create };
})();
