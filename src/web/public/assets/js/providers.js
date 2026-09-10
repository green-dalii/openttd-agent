/* Providers page — pick a built-in provider/model, then supply credentials.
 *
 * 职责: 渲染 pi-ai 内置目录（39 providers / ~1900 models）+ 认证状态；保存
 *   selection 到 /api/llm，密钥存 credentials store（永不回显）。
 * 事实来源: docs/DASHBOARD-API.md §2.6/§3.1。
 * 禁止: 在页面持久化密钥（只 POST 一次）；不信客户端算的 baseUrl/api。
 */
"use strict";
(function () {
  const U = window.UI;
  const $ = U.$;

  const state = {
    providers: [],
    models: [],
    providerId: "",
    model: "",
    custom: false,
    settings: null,
  };

  const elProviders = $("prov-list"), elModels = $("model-list"),
        elProvCount = $("prov-count"), elModelCount = $("model-count"),
        elModelHint = $("model-hint"), elProvFilter = $("prov-filter"),
        elModelFilter = $("model-filter"), elAuthStatus = $("auth-status"),
        elAuthHint = $("auth-hint"), elAuthMsg = $("auth-msg"),
        elAuthKey = $("auth-key"), elCustom = $("auth-custom"),
        elCustomFields = $("custom-fields"), elBase = $("auth-base"),
        elApi = $("auth-api"), elEffective = $("effective"),
        elCatalog = $("p-catalog"), elConfigured = $("p-configured"),
        elSelected = $("p-selected");

  $("nav").innerHTML = U.renderNav("/llm");

  function authBadge(p) {
    if (!p.auth || !p.auth.configured) return `<span class="badge bad">no key</span>`;
    if (p.auth.source === "env") return `<span class="badge ok" title="${U.esc(p.auth.envVar || "")}">env</span>`;
    return `<span class="badge ok">stored</span>`;
  }

  function renderProviders() {
    const q = elProvFilter.value.trim().toLowerCase();
    const list = state.providers.filter((p) =>
      !q || p.id.toLowerCase().includes(q) || String(p.modelCount).includes(q));
    elProvCount.textContent = `(${list.length}/${state.providers.length})`;
    elProviders.innerHTML = list.map((p) => `
      <li class="pick ${p.id === state.providerId ? "sel" : ""}" data-id="${U.esc(p.id)}">
        <div class="pick-main">
          <span class="pick-name">${U.esc(p.id)}</span>
          ${authBadge(p)}
        </div>
        <div class="pick-sub dim">${p.modelCount} models · ${U.esc(p.apis.join(", "))}
          ${p.envKeys && p.envKeys.length
            ? `· env ${U.esc(p.envKeys.join("/"))}`
            : p.hint ? `· ${U.esc(p.hint)}` : ""}</div>
      </li>`).join("") || `<li class="empty">No providers match “${U.esc(q)}”.</li>`;

    for (const li of elProviders.querySelectorAll(".pick")) {
      li.onclick = () => selectProvider(li.getAttribute("data-id"));
    }
  }

  function renderModels() {
    const q = elModelFilter.value.trim().toLowerCase();
    const list = state.models.filter((m) =>
      !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    elModelCount.textContent = state.providerId ? `(${list.length}/${state.models.length})` : "";
    elModels.innerHTML = state.providerId
      ? (list.map((m) => `
          <li class="pick ${m.id === state.model ? "sel" : ""}" data-id="${U.esc(m.id)}">
            <div class="pick-main">
              <span class="pick-name">${U.esc(m.id)}</span>
              ${m.reasoning ? `<span class="badge">reasoning</span>` : ""}
            </div>
            <div class="pick-sub dim">${U.esc(m.api)} · ctx ${U.fmtTok(m.contextWindow)} ·
              out ${U.fmtTok(m.maxTokens)}
              ${m.cost.input || m.cost.output ? `· $${m.cost.input}/$${m.cost.output} per 1M` : ""}</div>
          </li>`).join("") || `<li class="empty">No models match “${U.esc(q)}”.</li>`)
      : `<li class="empty">Select a provider to list its models.</li>`;

    for (const li of elModels.querySelectorAll(".pick")) {
      li.onclick = () => {
        state.model = li.getAttribute("data-id");
        renderModels();
        renderAuth();
      };
    }
  }

  async function selectProvider(id) {
    state.providerId = id;
    state.models = [];
    state.model = "";
    elModelHint.textContent = "Loading models…";
    renderProviders();
    renderModels();
    try {
      const r = await fetch(`/api/llm/catalog/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.models = Array.isArray(data.models) ? data.models : [];
      elModelHint.textContent = "Pick a model — API and context window come from the catalog.";
    } catch (e) {
      elModelHint.textContent = "Could not load models: " + e;
    }
    renderModels();
    renderAuth();
  }

  function renderAuth() {
    const p = state.providers.find((x) => x.id === state.providerId);
    if (state.custom) {
      elAuthStatus.textContent = "";
      elAuthHint.textContent =
        "Custom endpoint: the agent talks to your own OpenAI-compatible server (llama.cpp, vLLM, a gateway).";
      elAuthKey.placeholder = "API key (or leave blank if your server needs none)";
    } else if (!p) {
      elAuthStatus.textContent = "pick a provider first";
      elAuthHint.textContent = "";
    } else if (p.auth && p.auth.configured && p.auth.source === "env") {
      elAuthStatus.innerHTML = `<span class="badge ok">ready from environment</span>`;
      elAuthHint.innerHTML =
        `Detected <code>${U.esc(p.auth.envVar || "")}</code> — the agent can already use this provider. ` +
        `Saving a key here would override it for this app only.`;
      elAuthKey.placeholder = "(optional) store a key for this app only";
    } else if (p.auth && p.auth.configured) {
      elAuthStatus.innerHTML = `<span class="badge ok">stored key</span>`;
      elAuthHint.textContent = "A key is stored for this provider. Leave the field blank to keep it.";
      elAuthKey.placeholder = "(stored — leave blank to keep)";
    } else if (p.hint) {
      elAuthStatus.innerHTML = `<span class="badge">oauth / cloud</span>`;
      elAuthHint.textContent = p.hint + " Store a credential here if the provider supports it.";
      elAuthKey.placeholder = "paste a key/token if required";
    } else if (p.envKeys && p.envKeys.length) {
      elAuthStatus.innerHTML = `<span class="badge bad">needs a key</span>`;
      elAuthHint.innerHTML =
        `No key found. Set <code>${U.esc(p.envKeys.join("</code> or <code>"))}</code> in your shell, or paste one below.`;
      elAuthKey.placeholder = "paste API key";
    } else {
      elAuthStatus.innerHTML = `<span class="badge bad">needs a key</span>`;
      elAuthHint.textContent = "No key found for this provider — paste one below.";
      elAuthKey.placeholder = "paste API key";
    }
    renderEffective();
  }

  function renderEffective() {
    const p = state.providers.find((x) => x.id === state.providerId);
    const src = state.custom ? "custom" : "catalog";
    const rows = [
      ["Mode", src === "catalog" ? "pi-ai built-in provider" : "custom OpenAI-compatible endpoint"],
      ["Provider", state.providerId || "—"],
      ["Model", state.model || "—"],
      ["API", state.custom ? elApi.value : (state.models.find((m) => m.id === state.model)?.api || "—")],
      ["Base URL", state.custom ? (elBase.value || "—") : (p && p.baseUrl) || "(provider default)"],
      ["Auth", state.custom ? "key from this form" : (p && p.auth && p.auth.source === "env"
        ? `environment (${p.auth.envVar || "env"})`
        : p && p.auth && p.auth.configured ? "stored credential" : "not configured — set a key")],
    ];
    elEffective.innerHTML = `<table class="kv">${rows
      .map(([k, v]) => `<tr><td>${U.esc(k)}</td><td>${U.esc(v)}</td></tr>`).join("")}</table>`;

    const configured = state.providers.filter((x) => x.auth && x.auth.configured).length;
    elConfigured.textContent = String(configured);
    elSelected.textContent = state.providerId ? `${state.providerId}${state.model ? " / " + state.model : ""}` : "—";
  }

  async function loadSettings() {
    try {
      const r = await fetch("/api/llm");
      if (!r.ok) return;
      const s = await r.json();
      state.settings = s;
      const sel = s.selection || {};
      state.custom = sel.source === "custom";
      elCustom.checked = state.custom;
      elCustomFields.classList.toggle("hidden", !state.custom);
      if (sel.baseUrl) elBase.value = sel.baseUrl;
      if (sel.api) elApi.value = sel.api;
      if (sel.providerId && !state.custom) {
        await selectProvider(sel.providerId);
        if (sel.model) {
          state.model = sel.model;
          renderModels();
          renderAuth();
        }
      } else {
        renderAuth();
      }
    } catch { /* leave defaults */ }
  }

  async function loadCatalog() {
    try {
      const r = await fetch("/api/llm/catalog");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.providers = data.providers || [];
      elCatalog.textContent = `${state.providers.length}${data.generatedAt ? "" : " (no timestamp)"}`;
      renderProviders();
    } catch (e) {
      elProviders.innerHTML = `<li class="empty">Catalog unavailable: ${U.esc(e)}</li>`;
    }
  }

  elProvFilter.oninput = renderProviders;
  elModelFilter.oninput = renderModels;
  elCustom.onchange = () => {
    state.custom = elCustom.checked;
    elCustomFields.classList.toggle("hidden", !state.custom);
    renderAuth();
  };
  elApi.onchange = renderEffective;
  elBase.oninput = renderEffective;

  $("auth-form").onsubmit = async (ev) => {
    ev.preventDefault();
    elAuthMsg.textContent = "saving…";
    const body = {
      source: state.custom ? "custom" : "catalog",
      providerId: state.providerId,
      model: state.model,
      api: state.custom ? elApi.value : undefined,
      baseUrl: state.custom ? elBase.value.trim() : "",
    };
    if (elAuthKey.value.trim()) body.apiKey = elAuthKey.value.trim();
    try {
      const r = await fetch("/api/llm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await r.json();
      if (!r.ok) { elAuthMsg.textContent = "error: " + (out.error || r.status); return; }
      elAuthKey.value = "";
      elAuthMsg.textContent = "saved ✅ — applies on the next agent run";
      await loadCatalog();
      await loadSettings();
      renderAuth();
    } catch (e) { elAuthMsg.textContent = "error: " + e; }
  };

  $("auth-clear").onclick = async () => {
    if (!state.providerId) { elAuthMsg.textContent = "pick a provider first"; return; }
    elAuthMsg.textContent = "clearing…";
    try {
      const r = await fetch(`/api/llm/credentials/${encodeURIComponent(state.providerId)}`, { method: "DELETE" });
      elAuthMsg.textContent = r.ok ? "stored key cleared" : `error: HTTP ${r.status}`;
      if (r.ok) { await loadCatalog(); renderAuth(); }
    } catch (e) { elAuthMsg.textContent = "error: " + e; }
  };

  loadCatalog().then(loadSettings);
})();
