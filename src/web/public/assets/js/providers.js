/* Providers page — pick a provider/model from pi-ai's built-in catalog.
 *
 * 职责: 用**可搜索下拉框**（而非滚动列表）选择 provider 与 model，
 *   展示认证状态并保存选择到 /api/llm；密钥写 credentials store（永不回显）。
 * 为什么这样设计: 39 providers / ~1900 models 是"从大量选项中选一个"的搜索题，
 *   不是"浏览列表"题（用户通常已知道要哪个 provider）。见 docs/DASHBOARD-UI.md §3。
 * 事实来源: docs/DASHBOARD-UI.md §5.2、docs/DASHBOARD-API.md §3.1。
 * 禁止: 在页面持久化密钥（只 POST 一次）；不信客户端自算的 baseUrl/api；
 *   不把 env 里的密钥回显到 DOM。
 */
"use strict";
(function () {
  const U = window.UI;
  const $ = U.$;
  $("nav").innerHTML = U.renderNav("/providers");

  const state = {
    providers: [],
    models: [],
    providerId: "",
    model: "",
    custom: false,
    modelsLoading: false,
  };

  const elProvBox = $("prov-cbx"), elModelBox = $("model-cbx"),
        elAuthStatus = $("auth-status"), elAuthHint = $("auth-hint"),
        elAuthKey = $("auth-key"), elReady = $("p-ready"), elSelected = $("p-selected"),
        elEffective = $("effective"), elReadyList = $("ready-list"),
        elMsg = $("form-msg"), elCustomFields = $("custom-fields"),
        elCatalogFields = $("catalog-fields"),
        elBase = $("auth-base"), elApi = $("auth-api"), elCustomKey = $("auth-key-custom"),
        elCustomModel = $("auth-model");

  /* --------------------------- comboboxes --------------------------- */
  /* Grouping answers the first question a user has: "can I use this right now?" */
  function providerGroup(p) {
    if (p.auth && p.auth.configured) return "Ready now";
    if (p.hint) return "Needs cloud/OAuth credentials";
    return "Needs an API key";
  }

  /** Rank groups so "can I use this right now?" comes first, then contiguity. */
  const GROUP_RANK = ["Ready now", "Needs an API key", "Needs cloud/OAuth credentials", "Other"];
  function providerRank(p) {
    const i = GROUP_RANK.indexOf(providerGroup(p));
    return i < 0 ? GROUP_RANK.length : i;
  }

  function providerSub(p) {
    const bits = [`${p.modelCount} models`, U.esc((p.apis || []).join(", "))];
    if (p.auth && p.auth.source === "env" && p.auth.envVar) {
      bits.push(`<span class="badge ok">env ${U.esc(p.auth.envVar)}</span>`);
    } else if (p.auth && p.auth.configured) {
      bits.push(`<span class="badge ok">stored key</span>`);
    }
    return bits.join(" · ");
  }

  const provCbx = U.combobox(elProvBox, {
    placeholder: "Search providers… (deepseek, openai, google…)",
    emptyLabel: "Select a provider…",
    empty: "No provider matches that search.",
    options: () => state.providers.map((p) => ({
      id: p.id,
      label: p.id,
      sub: providerSub(p),
      ready: Boolean(p.auth && p.auth.configured),
      search: `${p.id} ${(p.apis || []).join(" ")} ${p.envKeys ? p.envKeys.join(" ") : ""}`,
    })),
    value: () => state.providerId,
    groups: (o) => {
      const p = state.providers.find((x) => x.id === o.id);
      return p ? providerGroup(p) : "Other";
    },
    sort: (a, b) => {
      const pa = state.providers.find((x) => x.id === a.id);
      const pb = state.providers.find((x) => x.id === b.id);
      return (pa ? providerRank(pa) : 9) - (pb ? providerRank(pb) : 9);
    },
    onChange: (id) => selectProvider(id),
  });

  const modelCbx = U.combobox(elModelBox, {
    placeholder: "Search models…",
    emptyLabel: "Select a model…",
    empty: "No model matches that search.",
    options: () => state.models.map((m) => ({
      id: m.id,
      label: m.id,
      ready: false,
      search: `${m.id} ${m.name || ""} ${m.api || ""}`,
      sub: [
        U.esc(m.api || ""),
        `ctx ${U.fmtTok(m.contextWindow)}`,
        `out ${U.fmtTok(m.maxTokens)}`,
        m.reasoning ? '<span class="badge">reasoning</span>' : "",
        m.cost && (m.cost.input || m.cost.output)
          ? `$${m.cost.input}/$${m.cost.output} per 1M` : "",
      ].filter(Boolean).join(" · "),
    })),
    value: () => state.model,
    onChange: (id) => { state.model = id; renderAuth(); renderEffective(); },
  });

  /* --------------------------- catalog load --------------------------- */
  async function loadCatalog() {
    try {
      const r = await fetch("/api/llm/catalog");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.providers = data.providers || [];
      const ready = state.providers.filter((p) => p.auth && p.auth.configured);
      $("p-catalog").textContent = String(state.providers.length);
      elReady.textContent = `${ready.length} / ${state.providers.length}`;
      elReadyList.innerHTML = ready.length
        ? `<table class="kv">${ready.map((p) => `<tr>
            <td style="width:auto"><code>${U.esc(p.id)}</code></td>
            <td class="num"><span class="badge ok">${
              p.auth.source === "env" ? U.esc(p.auth.envVar || "env") : "stored key"
            }</span></td></tr>`).join("")}</table>`
        : `<p class="hint">None yet — pick a provider and paste a key, or export one in your shell.</p>`;
      provCbx.refresh();
    } catch (e) {
      elReadyList.innerHTML = `<p class="empty">Catalog unavailable: ${U.esc(e)}</p>`;
    }
  }

  async function selectProvider(id) {
    state.providerId = id;
    state.models = [];
    state.model = "";
    state.modelsLoading = true;
    modelCbx.refresh();
    provCbx.refresh();
    renderAuth();
    renderEffective();
    try {
      const r = await fetch(`/api/llm/catalog/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.models = Array.isArray(data.models) ? data.models : [];
    } catch (e) {
      U.toast(`Could not load models for ${id}: ${e}`, "err");
      state.models = [];
    }
    state.modelsLoading = false;
    modelCbx.refresh();
    renderAuth();
  }

  /* ----------------------------- auth panel ----------------------------- */
  function renderAuth() {
    const p = state.providers.find((x) => x.id === state.providerId);
    if (!state.providerId) {
      elAuthStatus.innerHTML = "";
      elAuthHint.textContent = "Pick a provider first — a key already in your environment is detected automatically.";
      elAuthKey.placeholder = "paste a key";
      return;
    }
    if (p && p.auth && p.auth.configured && p.auth.source === "env") {
      elAuthStatus.innerHTML = `<span class="badge ok">ready — no action needed</span>`;
      elAuthHint.innerHTML =
        `This machine already has <code>${U.esc(p.auth.envVar || "the key")}</code> set, so the agent can use ` +
        `${U.esc(p.id)} right away. Only paste a key below if you want this app to use a different one.`;
      elAuthKey.placeholder = "(optional) override for this app only";
    } else if (p && p.auth && p.auth.configured) {
      elAuthStatus.innerHTML = `<span class="badge ok">key stored</span>`;
      elAuthHint.textContent = "A key is stored locally. Leave the field blank when saving to keep it.";
      elAuthKey.placeholder = "(stored — leave blank to keep)";
    } else if (p && p.hint) {
      elAuthStatus.innerHTML = `<span class="badge warn">cloud / OAuth</span>`;
      elAuthHint.textContent = p.hint;
      elAuthKey.placeholder = "paste a token if this provider accepts one";
    } else if (p && p.envKeys && p.envKeys.length) {
      elAuthStatus.innerHTML = `<span class="badge bad">needs a key</span>`;
      elAuthHint.innerHTML = `No key found. Either export <code>${U.esc(p.envKeys.join("</code> or <code>"))}</code> ` +
        `in your shell, or paste one below.`;
      elAuthKey.placeholder = "paste API key";
    } else {
      elAuthStatus.innerHTML = `<span class="badge bad">needs a key</span>`;
      elAuthHint.textContent = "No key found for this provider — paste one below.";
      elAuthKey.placeholder = "paste API key";
    }
    if (p && p.hint && !elAuthKey.value) elAuthKey.value = "";
  }

  function renderEffective() {
    const p = state.providers.find((x) => x.id === state.providerId);
    const src = state.custom ? "custom" : "catalog";
    const model = state.custom ? elCustomModel.value.trim() : state.model;
    const m = state.models.find((x) => x.id === model);
    const rows = [
      ["Mode", src === "catalog" ? "pi-ai built-in provider" : "custom OpenAI-compatible endpoint"],
      ["Provider", state.providerId || "—"],
      ["Model", model || "—"],
      ["API", state.custom ? elApi.value : (m && m.api) || "—"],
      ["Base URL", state.custom ? (elBase.value.trim() || "—") : (p && p.baseUrl) || "(provider default)"],
      ["Context", m ? `${U.fmtTok(m.contextWindow)} in / ${U.fmtTok(m.maxTokens)} out` : "—"],
      ["Auth", state.custom
        ? (elCustomKey.value.trim() ? "key from this form" : "no key (server may not need one)")
        : p && p.auth && p.auth.source === "env" ? `environment (${p.auth.envVar || "env"})`
          : p && p.auth && p.auth.configured ? "stored credential"
            : "not configured — set a key"],
    ];
    elEffective.innerHTML = `<table class="kv">${rows
      .map(([k, v]) => `<tr><td>${U.esc(k)}</td><td>${U.esc(v)}</td></tr>`).join("")}</table>`;
    elSelected.textContent = state.providerId
      ? `${state.providerId}${model ? " / " + model : ""}` : "—";
    const saveBtn = $("save");
    const ready = state.custom
      ? Boolean(elBase.value.trim() && elCustomModel.value.trim())
      : Boolean(state.providerId && state.model);
    saveBtn.disabled = !ready;
  }

  /* ----------------------------- mode switch ----------------------------- */
  U.segmented($("p-mode"), {
    options: [
      { id: "catalog", label: "Built-in", hint: "Use one of pi-ai's 39 providers" },
      { id: "custom", label: "Custom endpoint", hint: "Your own OpenAI-compatible server" },
    ],
    value: () => (state.custom ? "custom" : "catalog"),
    onChange: (id) => {
      state.custom = id === "custom";
      elCustomFields.hidden = !state.custom;
      elCatalogFields.hidden = state.custom;
      renderAuth();
      renderEffective();
    },
  });

  /* ----------------------------- save / clear ----------------------------- */
  function setMsg(text, kind) {
    elMsg.textContent = text;
    elMsg.className = `form-msg ${kind || ""}`;
  }

  $("save").onclick = async () => {
    setMsg("");
    const body = state.custom
      ? {
          source: "custom",
          providerId: state.providerId || "custom-endpoint",
          model: elCustomModel.value.trim(),
          api: elApi.value,
          baseUrl: elBase.value.trim(),
        }
      : { source: "catalog", providerId: state.providerId, model: state.model };
    const key = state.custom ? elCustomKey.value.trim() : elAuthKey.value.trim();
    if (key) body.apiKey = key;
    else if (state.custom) body.apiKey = "";
    if (!state.custom && !body.model) { setMsg("Pick a model first.", "err"); return; }

    try {
      const r = await fetch("/api/llm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await r.json();
      if (!r.ok) { setMsg("Save failed: " + (out.error || r.status), "err"); U.toast("Save failed", "err"); return; }
      elAuthKey.value = "";
      elCustomKey.value = "";
      await loadCatalog();
      renderAuth();
      renderEffective();
      setMsg("Saved — applies on the next agent run.", "ok");
      U.toast("Configuration saved. It applies on the next agent run.", "ok");
    } catch (e) {
      setMsg("Save failed: " + e, "err");
      U.toast("Save failed: " + e, "err");
    }
  };

  $("clear-key").onclick = async () => {
    if (!state.providerId) { setMsg("Pick a provider first.", "err"); return; }
    const ok = await U.confirmDialog({
      title: "Clear the stored key?",
      body: `The credential stored for "${state.providerId}" will be removed from credentials.json. ` +
        `If an environment variable provides the key, that is unaffected.`,
      confirm: "Clear key",
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/llm/credentials/${encodeURIComponent(state.providerId)}`, { method: "DELETE" });
      if (!r.ok) { setMsg(`Clear failed: HTTP ${r.status}`, "err"); return; }
      await loadCatalog();
      renderAuth();
      renderEffective();
      setMsg("Stored key cleared.", "ok");
      U.toast("Stored key cleared.", "ok");
    } catch (e) {
      setMsg("Clear failed: " + e, "err");
    }
  };

  elBase.oninput = renderEffective;
  elCustomModel.oninput = renderEffective;
  elCustomKey.oninput = renderEffective;
  elApi.onchange = renderEffective;

  /* ----------------------------- bootstrap ----------------------------- */
  async function loadSettings() {
    try {
      const r = await fetch("/api/llm");
      if (!r.ok) return;
      const s = await r.json();
      const sel = s.selection || {};
      const isCustom = sel.source === "custom";
      state.custom = isCustom;
      elCustomFields.hidden = !isCustom;
      elCatalogFields.hidden = isCustom;
      if (sel.baseUrl) elBase.value = sel.baseUrl;
      if (sel.api) elApi.value = sel.api;
      if (sel.model) elCustomModel.value = sel.model;
      if (isCustom) {
        state.providerId = sel.providerId || "";
      } else if (sel.providerId) {
        await selectProvider(sel.providerId);
        if (sel.model) {
          state.model = sel.model;
          modelCbx.refresh();
        }
      }
      if (s.status && s.status.appliedFrom === "env") {
        U.toast("LLM_* environment variables are overriding the saved file.", "warn", 6000);
      }
      renderAuth();
      renderEffective();
    } catch { /* keep defaults */ }
  }

  renderAuth();
  renderEffective();
  loadCatalog().then(loadSettings);
})();
