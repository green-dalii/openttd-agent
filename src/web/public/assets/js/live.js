/* Live dashboard — game state + agent telemetry.
 *
 * 职责: 消费 WS snapshot/event/telemetry/step/checkpoint 帧，按**信息紧迫性**分层渲染
 *   （见 docs/DASHBOARD-UI.md §0/§5.1）：
 *   1) KPI 条（在赚钱吗） 2) Agent（token/工具/步骤/思考） 3) 经济曲线 4) 事件流 5) 阶段总结
 * 事实来源: docs/DASHBOARD-UI.md（呈现契约）、docs/DASHBOARD-API.md §2/§4/§5（数据契约）。
 * 禁止: 在此页面写业务状态（服务端是真源）；不自造 WS 字段；密钥类信息一律不渲染。
 */
"use strict";
(function () {
  const U = window.UI;
  const C = window.Charts;
  const $ = U.$;
  $("nav").innerHTML = U.renderNav("/");

  const MAX_EVENTS = 600;
  const MAX_STEPS = 400;

  const state = {
    connected: false,
    date: null,
    companies: {},
    recent: [],
    totalEvents: 0,
    telemetry: null,
    steps: [],
    thinking: [],
    checkpoints: [],
    startedAt: null,
    paused: false,
    evSearch: "",
    stepFilter: "all",
    hidden: new Set(U.getPref("ev.hidden", [])),
    cashMetric: U.getPref("cash.metric", "money"),
    tokenMetric: U.getPref("token.metric", "total"),
  };

  const elLink = $("g-link"), elDate = $("g-date"), elSession = $("g-session"),
        elMode = $("g-mode"), elElapsed = $("g-elapsed"),
        elKpis = $("kpis"), elStream = $("events"), elSteps = $("steps"),
        elStepsCount = $("steps-count"), elStages = $("stages"), elStageCount = $("stage-count"),
        elFilters = $("ev-filters"), elRaw = $("ev-raw"), elEvTotal = $("ev-total"),
        elEvSearch = $("ev-search"), elEvPause = $("ev-pause"),
        elAutoScroll = $("steps-autoscroll");

  /* ------------------------------ WS ------------------------------ */
  U.connectWs({
    onLink: (text, cls) => {
      elLink.textContent = text;
      elLink.className = "pill " + (cls === "ok" ? "ok" : "bad");
      state.connected = cls === "ok";
      renderKpis();
    },
    onSnapshot: (snap) => {
      state.date = snap.date || null;
      state.companies = snap.companies || {};
      state.totalEvents = snap.totalEvents || 0;
      state.recent = (snap.recent || []).slice();
      // Server owns the curve: seed from it so a reload of a long run still
      // shows the full cash history instead of restarting from one point.
      for (const [id, c] of Object.entries(snap.companies || {})) {
        if (c && Array.isArray(c.history) && c.history.length) {
          state.companies[id] = { ...(state.companies[id] || {}), ...c, history: c.history.slice() };
        }
      }
      // Late subscribers/reloads get the staged-summary backlog here.
      state.checkpoints = Array.isArray(snap.checkpoints) ? snap.checkpoints.slice() : [];
      if (snap.sessionId) state.sessionId = snap.sessionId;
      if (snap.telemetry) applyTelemetry(snap.telemetry, true);
      renderAll();
    },
    onEvent: (ev) => {
      if (!state.startedAt) state.startedAt = Date.now();
      state.recent = [...state.recent, ev].slice(-MAX_EVENTS);
      state.totalEvents = Math.max(state.totalEvents + 1, state.recent.length);
      fold(ev);
      if (state.paused) return; // user is reading; keep collecting but do not repaint
      renderKpis();
      renderCompanies();
      renderChart();
      renderEvents();
    },
    onTelemetry: (t) => { applyTelemetry(t, false); renderTelemetry(); },
    onStep: (step) => {
      if (!state.startedAt) state.startedAt = Date.now();
      pushStep(step);
      renderSteps();
    },
    onCheckpoint: (cp) => {
      state.checkpoints = [...state.checkpoints, cp];
      renderStages();
    },
  });

  function applyTelemetry(t, replace) {
    state.telemetry = t;
    if (Array.isArray(t.steps)) state.steps = replace ? t.steps.slice() : mergeSteps(state.steps, t.steps);
    state.thinking = Array.isArray(t.recentThinking) ? t.recentThinking : [];
  }

  /** Telemetry snapshots repeat the tail of the step list; keep one copy of each. */
  function mergeSteps(local, incoming) {
    const seen = new Set(local.map((s) => s && s.id));
    const merged = local.slice();
    for (const s of incoming) {
      if (s && !seen.has(s.id)) { merged.push(s); seen.add(s.id); }
    }
    return merged.slice(-MAX_STEPS);
  }

  function pushStep(step) {
    if (!step || typeof step !== "object") return;
    if (state.steps.some((s) => s && s.id === step.id)) return;
    state.steps = [...state.steps, step].slice(-MAX_STEPS);
  }

  function fold(ev) {
    const p = ev.payload || {};
    if (ev.kind === "date") state.date = p;
    else if (ev.kind === "company_new") {
      state.companies[p.id] = state.companies[p.id] || { info: null, economy: null, stats: null, history: [] };
    } else if (ev.kind === "company_info") {
      const c = (state.companies[p.id] = state.companies[p.id] || { economy: null, stats: null, history: [] });
      c.info = p;
    } else if (ev.kind === "company_stats") {
      const c = (state.companies[p.id] = state.companies[p.id] || { info: null, economy: null, history: [] });
      c.stats = p;
    } else if (ev.kind === "company_economy") {
      const c = (state.companies[p.id] = state.companies[p.id] || { info: null, stats: null, history: [] });
      c.economy = p;
      if (p.money !== undefined) {
        // Mirror the server's point shape so seeding and live appends agree.
        c.history = [...(c.history || []), {
          at: ev.ts,
          year: state.date ? state.date.year : null,
          month: state.date ? state.date.month : null,
          money: Number(p.money),
          loan: Number(p.loan || 0),
          income: Number(p.income || 0),
        }].slice(-400);
      }
    }
  }

  /* ---------------------------- render ---------------------------- */
  function renderAll() {
    renderHeader();
    renderKpis();
    renderCompanies();
    renderChart();
    renderEvents();
    renderTelemetry();
    renderSteps();
    renderStages();
  }

  function primaryCompany() {
    const ids = Object.keys(state.companies || {});
    if (!ids.length) return {};
    // The agent plays company 0; fall back to the first company seen.
    return state.companies["0"] || state.companies[ids[0]] || {};
  }

  function renderHeader() {
    elDate.textContent = state.date ? U.fmtGameDate(state.date) : "—";
    elSession.textContent = (state.telemetry && state.telemetry.sessionId) || state.sessionId || "—";
    const mode = state.telemetry && state.telemetry.brain;
    elMode.textContent = mode && mode.kind
      ? (mode.kind === "real" ? "agent · real LLM" : "agent · test brain")
      : (state.connected ? "observer only" : "—");
    if (state.startedAt) elElapsed.textContent = U.fmtDuration(Date.now() - state.startedAt);
  }

  /** KPI strip = the "is it working / is it making money" answer (docs §5.1). */
  function renderKpis() {
    const c = primaryCompany();
    const e = c.economy || {};
    const s = c.stats || {};
    const hist = (c.history || []);
    const t = state.telemetry;
    const u = (t && t.usage && t.usage.total) || {};

    const seriesOf = (key) => hist.map((h) => Number(h[key])).filter((v) => Number.isFinite(v));
    const moneySeries = seriesOf("money");
    const incomeSeries = seriesOf("income");
    const delta = (arr) => (arr.length > 1 ? arr[arr.length - 1] - arr[arr.length - 2] : undefined);

    const tiles = [
      {
        label: "Cash",
        value: U.fmtMoney(e.money),
        delta: delta(moneySeries),
        deltaFmt: (v) => U.fmtMoney(v),
        spark: moneySeries.slice(-40),
        color: "#ffb347",
      },
      {
        label: "Income / yr",
        value: U.fmtMoney(e.income),
        delta: delta(incomeSeries),
        deltaFmt: (v) => U.fmtMoney(v),
        spark: incomeSeries.slice(-40),
        color: "#7bc96f",
      },
      { label: "Company value", value: U.fmtMoney(e.companyValue) },
      { label: "Loan", value: U.fmtMoney(e.loan) },
      {
        label: "Fleet",
        value: `${U.fmtInt(s.vehicles ?? 0)} <span class="dim">veh</span>`,
        hint: `${U.fmtInt(s.stations ?? 0)} stations`,
      },
      {
        label: "Tokens used",
        value: U.fmtTok(u.totalTokens),
        hint: `${U.fmtCost(u.costTotal)} · ${U.fmtInt((t && t.totals && t.totals.toolCalls) || 0)} tool calls`,
      },
    ];
    elKpis.innerHTML = tiles.map((k) => U.kpi(k)).join("");
    // Aligned to the tile order above so each tile gets its own trend.
    if (hist.length > 1) {
      U.paintSparks(elKpis, [
        { data: moneySeries.slice(-40), color: "#ffb347" },
        { data: incomeSeries.slice(-40), color: "#7bc96f" },
      ]);
    }
  }

  function renderCompanies() {
    const ids = Object.keys(state.companies || {});
    if (!ids.length) {
      $("companies").innerHTML = '<div class="empty">No company yet — the observer starts an AI and watches its economy.</div>';
      return;
    }
    $("companies").innerHTML = ids.map((id) => {
      const c = state.companies[id] || {};
      const i = c.info || { name: `Company ${id}`, isAi: false };
      const e = c.economy || {};
      const s = c.stats || {};
      const neg = Number(e.money || 0) < 0;
      return `<div class="kpi">
        <div class="kpi-k ccard-head">
          <span>${U.esc(i.name || `Company ${id}`)} <span class="dim">#${U.esc(id)}</span></span>
          <span class="tag ${i.isAi ? "tag-script" : "tag-company"}">${i.isAi ? "AI" : "human"}</span>
        </div>
        <div class="kpi-v ${neg ? "neg" : "pos"}">${U.fmtMoney(e.money)}</div>
        <div class="kpi-hint">value ${U.fmtMoney(e.companyValue)} · loan ${U.fmtMoney(e.loan)}</div>
        <div class="kpi-hint">${U.fmtInt(s.vehicles ?? "—")} veh · ${U.fmtInt(s.stations ?? "—")} stn
          ${i.manager ? ` · ${U.esc(i.manager)}` : ""}</div>
      </div>`;
    }).join("");
  }

  /** Axis label for a history point ("1950-02", "—" before the first date). */
  function pointLabel(hist) {
    return hist.map((h) => (h.year == null
      ? "—"
      : `${h.year}-${String(h.month ?? 1).padStart(2, "0")}`));
  }

  function cashSeries() {
    const ids = Object.keys(state.companies || {});
    return ids.map((id, idx) => ({
      name: (state.companies[id] || {}).info ? state.companies[id].info.name : `Company ${id}`,
      color: U.pickColor(idx),
      data: ((state.companies[id] || {}).history || []).map((h) => Number(h[state.cashMetric] || 0)),
    })).filter((s) => s.data.length);
  }

  function renderChart() {
    const box = $("chart");
    const series = cashSeries();
    const labels = pointLabel((Object.values(state.companies)[0] || {}).history || []);
    C.line(box, {
      series,
      labels,
      format: U.fmtMoney,
      area: series.length === 1,
      height: 260,
    });
    $("cash-legend").innerHTML = series.map((s) =>
      `<span class="lg"><i style="background:${s.color}"></i>${U.esc(s.name)}</span>`).join("");
  }

  function renderEvents() {
    const { counts, order } = U.categoryCounts(state.recent);
    const visible = order.filter((c) => !state.hidden.has(c));
    if (elFilters.childElementCount !== order.length) {
      elFilters.innerHTML = order.map((c) =>
        `<button type="button" class="chip ${state.hidden.has(c) ? "off" : ""}" data-cat="${U.esc(c)}">` +
        `${U.esc(U.categoryLabel(c))}<span class="n">${counts[c]}</span></button>`).join("");
      for (const b of elFilters.querySelectorAll(".chip")) {
        b.onclick = () => {
          const cat = b.getAttribute("data-cat");
          state.hidden.has(cat) ? state.hidden.delete(cat) : state.hidden.add(cat);
          U.setPref("ev.hidden", [...state.hidden]);
          b.classList.toggle("off", state.hidden.has(cat));
          renderEvents();
        };
      }
    } else {
      for (const b of elFilters.querySelectorAll(".chip")) {
        const cat = b.getAttribute("data-cat");
        const n = b.querySelector(".n");
        if (n) n.textContent = String(counts[cat] || 0);
      }
    }

    elEvTotal.textContent = `${U.fmtInt(counts.total)} collected · ${visible.length} categories shown`;
    const shown = state.recent
      .filter((e) => !state.hidden.has(U.categoryOf(e.kind)))
      .filter((e) => U.eventMatches(e, state.evSearch))
      .slice(-160)
      .reverse(); // newest first: the Live page is a "what just happened" feed
    elStream.innerHTML = shown.map(renderEvent).join("") ||
      `<li class="empty">Nothing matches the current filters.</li>`;
    bindRawToggles(elStream);
  }

  function renderEvent(ev) {
    const cat = U.categoryOf(ev.kind);
    return `<li class="ev">
      <span class="seq">${U.esc(ev.seq)}</span>
      <span class="tag ${U.categoryClass(cat)}">${U.esc(U.categoryLabel(cat))}</span>
      <span class="kind">${U.esc(ev.kind)}</span>
      <span class="brief">${U.esc(U.briefOf(ev))}</span>
      <button class="raw-toggle" type="button">json</button>
      <pre class="raw" ${elRaw.checked ? "" : "hidden"}>${U.esc(JSON.stringify(ev.payload, null, 2))}</pre>
    </li>`;
  }

  function bindRawToggles(root) {
    for (const b of root.querySelectorAll(".raw-toggle")) {
      b.onclick = () => {
        const pre = b.parentElement.querySelector(".raw");
        if (pre) pre.hidden = !pre.hidden;
      };
    }
  }

  function renderTelemetry() {
    const t = state.telemetry;
    const brain = $("t-brain");
    if (!t) {
      brain.textContent = "no brain — observer only (run with --agent to see token/step telemetry)";
      $("t-usage").innerHTML =
        `<p class="empty">Watch mode observes the game only — no LLM telemetry.` +
        ` Start with <code>--agent</code> to see token usage, reasoning and steps.</p>`;
      $("t-tools").innerHTML = "";
      $("t-thinking").innerHTML = "";
      $("t-turn-table").innerHTML = "";
      C.line($("t-chart"), { series: [] });
      $("t-legend").innerHTML = "";
      return;
    }
    const b = t.brain || {};
    brain.textContent = b.kind
      ? `${b.kind === "real" ? "real LLM" : "test brain"} · ${b.provider || "—"} / ${b.model || "—"}`
      : "not configured";

    const u = (t.usage && t.usage.total) || {};
    const totals = t.totals || {};
    const failureRate = totals.toolCalls ? totals.toolFailures / totals.toolCalls : 0;
    const rows = [
      ["Turns", `${U.fmtInt(t.activeTurn || 0)} active / ${U.fmtInt(t.turns || 0)} total`],
      ["Decisions", U.fmtInt(totals.decisions)],
      ["Tool calls", `${U.fmtInt(totals.toolCalls)}`],
      ["Tool failures", `${U.fmtInt(totals.toolFailures)} <span class="dim">(${U.fmtPct(failureRate)})</span>`],
      ["Input tokens", U.fmtTok(u.input)],
      ["Output tokens", U.fmtTok(u.output)],
      ["Reasoning", U.fmtTok(u.reasoning)],
      ["Cache r/w", `${U.fmtTok(u.cacheRead)} / ${U.fmtTok(u.cacheWrite)}`],
      ["Total tokens", U.fmtTok(u.totalTokens)],
      ["Cost", U.fmtCost(u.costTotal)],
      ["Last activity", U.fmtAgo(t.lastActivityAt)],
    ];
    $("t-usage").innerHTML = `<table class="kv">${rows
      .map(([k, v]) => `<tr><td>${U.esc(k)}</td><td class="num">${v}</td></tr>`).join("")}</table>`;

    renderTokenChart();

    const byTool = (t.usage && t.usage.byTool) || [];
    $("t-tools").innerHTML = byTool.length
      ? `<table class="kv"><tr><th>Tool</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Avg</th></tr>` +
        byTool.map((r) => `<tr><td>${U.esc(r.tool)}</td><td class="num">${U.fmtInt(r.calls)}</td>
          <td class="num ${r.failures ? "neg" : ""}">${U.fmtInt(r.failures)}</td>
          <td class="num">${U.fmtDuration(r.avgDurationMs)}</td></tr>`).join("") + `</table>`
      : `<p class="empty">No tool calls yet.</p>`;

    const th = state.thinking || [];
    $("t-thinking").innerHTML = th.length
      ? th.slice().reverse().map((x) =>
          `<li><span class="badge">turn ${U.esc(x.turn)}</span> <span class="dim">${U.esc(U.fmtClock(x.ts))}</span>
            <pre>${U.esc(x.text)}</pre></li>`).join("")
      : `<li class="empty">No reasoning captured yet.</li>`;
  }

  /* Metric switch for the per-turn chart (tokens vs cost) — view pref (docs §6). */
  const TOKEN_METRICS = [
    { id: "total", label: "Tokens", hint: "input + output per turn" },
    { id: "cost", label: "Cost", hint: "spend per turn" },
  ];
  U.segmented($("token-metric"), {
    options: TOKEN_METRICS,
    value: () => state.tokenMetric,
    onChange: (id) => { state.tokenMetric = id; U.setPref("token.metric", id); renderTokenChart(); },
  });

  function renderTokenChart() {
    const t = state.telemetry;
    const byTurn = (t && t.usage && t.usage.byTurn) || [];
    if (!byTurn.length) {
      C.line($("t-chart"), { series: [] });
      $("t-legend").innerHTML = "";
      $("t-turn-table").innerHTML = `<p class="empty">No LLM turns recorded yet.</p>`;
      return;
    }
    const labels = byTurn.map((r) => `turn ${r.turn}`);
    const cost = state.tokenMetric === "cost";
    const fmt = cost ? U.fmtCost : U.fmtTok;
    const series = cost
      ? [{ name: "Cost", color: "#e5c07b", data: byTurn.map((r) => Number((r.usage || {}).costTotal) || 0) }]
      : [
          { name: "Input", color: "#5fb3ff", data: byTurn.map((r) => Number((r.usage || {}).input) || 0) },
          { name: "Output", color: "#7bc96f", data: byTurn.map((r) => Number((r.usage || {}).output) || 0) },
          { name: "Reasoning", color: "#c3a6ff", data: byTurn.map((r) => Number((r.usage || {}).reasoning) || 0) },
        ];
    C.line($("t-chart"), { series, format: fmt, yZero: true, height: 200 });
    $("t-legend").innerHTML = series.map((s) =>
      `<span class="lg"><i style="background:${s.color}"></i>${U.esc(s.name)}</span>`).join("");
    $("t-turn-table").innerHTML =
      `<table class="kv"><tr><th>Turn</th><th class="num">In</th><th class="num">Out</th>` +
      `<th class="num">Reason</th><th class="num">Total</th><th class="num">Cost</th><th class="num">Steps</th></tr>` +
      byTurn.map((r) => {
        const u = r.usage || {};
        return `<tr><td>${U.esc(r.turn)}</td><td class="num">${U.fmtTok(u.input)}</td>
          <td class="num">${U.fmtTok(u.output)}</td><td class="num">${U.fmtTok(u.reasoning)}</td>
          <td class="num">${U.fmtTok(u.totalTokens)}</td><td class="num">${U.fmtCost(u.costTotal)}</td>
          <td class="num">${U.fmtInt(r.steps)}</td></tr>`;
      }).join("") + `</table>`;
  }

  /* Step filter (all / llm / tools / failures) — a real control, not a wall. */
  U.segmented($("step-filter"), {
    options: [
      { id: "all", label: "All" },
      { id: "message", label: "LLM" },
      { id: "tool", label: "Tools" },
      { id: "failed", label: "Failures" },
    ],
    value: () => state.stepFilter,
    onChange: (id) => { state.stepFilter = id; renderSteps(); },
  });

  function stepVisible(s) {
    switch (state.stepFilter) {
      case "message": return s.kind === "message";
      case "tool": return s.kind === "tool";
      case "failed": return s.kind === "tool" && s.ok === false;
      default: return true;
    }
  }

  function renderSteps() {
    const all = state.steps;
    const shown = all.filter(stepVisible).slice(-200);
    elStepsCount.textContent = `(${shown.length}${shown.length === all.length ? "" : `/${all.length}`})`;
    elSteps.innerHTML = shown.map((s) => {
      const cls = s.kind === "tool" ? (s.ok ? "tool-ok" : "tool-bad") : "msg";
      return `<li class="step ${cls}">
        <div class="step-head">
          <span class="badge${s.kind === "tool" && s.ok === false ? " bad" : ""}">${s.kind === "tool" ? "tool" : "LLM"}</span>
          <span class="badge">turn ${U.esc(s.turn)}</span>
          <span class="step-title">${U.esc(s.kind === "tool" ? `${s.tool} — ${s.summary || ""}` : (s.model || "assistant"))}</span>
          ${s.durationMs !== undefined ? `<span class="dim">${U.fmtDuration(s.durationMs)}</span>` : ""}
          ${s.usage ? `<span class="dim">${U.fmtTok(s.usage.totalTokens)} tok · ${U.fmtCost(s.usage.costTotal)}</span>` : ""}
        </div>
        ${s.thinking ? `<details class="think"><summary>reasoning</summary><pre>${U.esc(s.thinking)}</pre></details>` : ""}
        ${s.text ? `<div class="step-text">${U.esc(s.text)}</div>` : ""}
        ${s.args !== undefined ? `<details><summary>args</summary><pre>${U.esc(JSON.stringify(s.args, null, 2))}</pre></details>` : ""}
        ${s.data ? `<details><summary>result</summary><pre>${U.esc(JSON.stringify(s.data, null, 2))}</pre></details>` : ""}
      </li>`;
    }).join("") || `<li class="empty">No steps ${state.stepFilter === "all" ? "yet" : "match this filter"}.</li>`;
    const last = elSteps.lastElementChild;
    if (elAutoScroll.checked && last && last.scrollIntoView) last.scrollIntoView({ block: "nearest" });
  }

  function renderStages() {
    const stages = state.checkpoints || [];
    elStageCount.textContent = stages.length ? `${stages.length} recorded` : "";
    elStages.innerHTML = stages.length
      ? stages.slice().reverse().map((c) => `<li>
          <span class="t-meta">${U.esc(c.gameDate)} · turn ${U.esc(c.turn)} · ${U.esc(U.fmtClock(c.at))}</span>
          ${U.esc(c.note)}</li>`).join("")
      : `<li class="empty">No staged summary yet — one is recorded as the run progresses.</li>`;
  }

  /* ---------------------------- controls ---------------------------- */
  elRaw.onchange = renderEvents;
  elEvSearch.oninput = () => { state.evSearch = elEvSearch.value.trim(); renderEvents(); };
  elEvPause.onclick = () => {
    state.paused = !state.paused;
    elEvPause.textContent = state.paused ? "Resume" : "Pause";
    elEvPause.classList.toggle("primary", state.paused);
    if (!state.paused) { renderAll(); U.toast("Live view resumed", "ok", 1500); }
  };
  elAutoScroll.onchange = () => U.setPref("steps.follow", elAutoScroll.checked);

  /* Cash chart metric switch (money / loan / income). */
  U.segmented($("cash-metric"), {
    options: [
      { id: "money", label: "Cash" },
      { id: "loan", label: "Loan" },
      { id: "income", label: "Income" },
    ],
    value: () => state.cashMetric,
    onChange: (id) => { state.cashMetric = id; U.setPref("cash.metric", id); renderChart(); },
  });

  elAutoScroll.checked = U.getPref("steps.follow", true);
  renderAll();
  // Keep "elapsed" honest without a busy 1s repaint loop: refresh it on the
  // events we already receive, plus a slow tick for quiet periods.
  setInterval(() => { if (state.startedAt) renderHeader(); }, 5000);
})();
