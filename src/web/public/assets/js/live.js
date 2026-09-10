/* Live dashboard — game state + agent telemetry.
 *
 * 职责: 消费 WS snapshot/event/telemetry/step 帧，渲染
 *   - 顶部统计条（日期/公司/事件/session）
 *   - Agent 遥测（token 总量、按 turn、按 tool、思考、每步 log）
 *   - 公司卡片 + 现金曲线
 *   - 事件流（按类别 Tag + 人类可读摘要，可展开原始 JSON）
 *   - 阶段性总结时间线
 * 事实来源: docs/DASHBOARD-API.md §2/§4/§5（冻结契约）。
 * 禁止: 在此页面写业务状态（服务端是真源）；不改 WS 协议字段。
 */
"use strict";
(function () {
  const U = window.UI;
  const $ = U.$;
  $("nav").innerHTML = U.renderNav("/");

  const state = {
    date: null,
    companies: {},
    recent: [],
    totalEvents: 0,
    telemetry: null,
    steps: [],
    thinking: [],
    hidden: new Set(),
  };

  const elDate = $("g-date"), elCompanies = $("g-companies"),
        elEvents = $("g-events"), elSession = $("g-session"),
        elLink = $("g-link"), elStream = $("events"), elSteps = $("steps"),
        elStepsCount = $("steps-count"), elStages = $("stages"),
        elFilters = $("ev-filters"), elRaw = $("ev-raw"),
        elAutoScroll = $("steps-autoscroll");

  /* ------------------------------ WS ------------------------------ */
  U.connectWs({
    onLink: (text, cls) => { elLink.textContent = text; elLink.className = "val " + (cls || "dim"); },
    onSnapshot: (snap) => {
      state.date = snap.date || null;
      state.companies = snap.companies || {};
      state.totalEvents = snap.totalEvents || 0;
      state.recent = snap.recent || [];
      if (snap.telemetry) applyTelemetry(snap.telemetry, true);
      renderAll();
    },
    onEvent: (ev) => {
      state.recent = [...state.recent, ev].slice(-400);
      state.totalEvents = Math.max(state.totalEvents + 1, state.recent.length);
      fold(ev);
      renderHeader();
      renderCompanies();
      renderChart();
      renderEvents();
    },
    onTelemetry: (t) => { applyTelemetry(t, false); renderTelemetry(); },
    onStep: (step) => { pushStep(step); renderSteps(); },
  });

  function applyTelemetry(t, replace) {
    state.telemetry = t;
    if (Array.isArray(t.steps)) {
      state.steps = replace ? t.steps.slice() : t.steps.slice();
    }
    state.thinking = Array.isArray(t.recentThinking) ? t.recentThinking : [];
  }

  function pushStep(step) {
    if (!step || typeof step !== "object") return;
    state.steps = [...state.steps, step].slice(-400);
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
        c.history = [...(c.history || []), { y: Number(p.money), at: state.date ? `${state.date.year}-${state.date.month}` : "?" }].slice(-300);
      }
    }
  }

  /* ---------------------------- render ---------------------------- */
  function renderAll() {
    renderHeader();
    renderCompanies();
    renderChart();
    renderEvents();
    renderTelemetry();
    renderSteps();
    renderStages();
  }

  function renderHeader() {
    const d = state.date;
    elDate.textContent = d
      ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`
      : "—";
    elCompanies.textContent = String(Object.keys(state.companies || {}).length || "—");
    elEvents.textContent = U.fmtInt(state.totalEvents || state.recent.length);
    elSession.textContent = (state.telemetry && state.telemetry.sessionId) || "—";
  }

  function renderCompanies() {
    const box = $("companies");
    const ids = Object.keys(state.companies || {});
    if (!ids.length) {
      box.innerHTML = '<div class="empty">No companies yet — the observer starts an AI and watches its economy.</div>';
      return;
    }
    box.innerHTML = ids.map((id) => {
      const c = state.companies[id] || {};
      const i = c.info || { name: `Company ${id}`, isAi: false };
      const e = c.economy || {};
      const s = c.stats || {};
      const neg = Number(e.money || 0) < 0;
      return `<div class="ccard">
        <h3><span>${U.esc(i.name || `Company ${id}`)} <small class="dim">#${U.esc(id)}</small></span>
          <span class="tag ${i.isAi ? "tag-script" : "tag-company"}">${i.isAi ? "AI" : "human"}</span></h3>
        <table>
          <tr><td>Cash</td><td class="money ${neg ? "neg" : "pos"}">${U.fmtMoney(e.money)}</td></tr>
          <tr><td>Loan</td><td>${U.fmtMoney(e.loan)}</td></tr>
          <tr><td>Income (yr)</td><td>${U.fmtMoney(e.income)}</td></tr>
          <tr><td>Value</td><td>${U.fmtMoney(e.companyValue)}</td></tr>
          <tr><td>Vehicles / Stations</td><td>${U.esc(s.vehicles ?? "—")} / ${U.esc(s.stations ?? "—")}</td></tr>
          <tr><td>President</td><td class="dim">${U.esc(i.manager || "—")}</td></tr>
        </table></div>`;
    }).join("");
  }

  function renderChart() {
    const ids = Object.keys(state.companies || {});
    const series = ids.map((id, idx) => ({
      color: U.pickColor(idx),
      data: ((state.companies[id] || {}).history || []).map((pt) => Number(pt.y)),
    })).filter((s) => s.data.length);
    U.drawLines($("chart"), series, {});
  }

  function renderEvents() {
    const cats = [...new Set(state.recent.map((e) => U.categoryOf(e.kind)))].sort();
    if (elFilters.childElementCount !== cats.length) {
      elFilters.innerHTML = cats.map((c) =>
        `<button type="button" class="chip ${state.hidden.has(c) ? "off" : ""}" data-cat="${U.esc(c)}">${U.esc(U.categoryLabel(c))}</button>`
      ).join("");
      elFilters.querySelectorAll(".chip").forEach((b) => {
        b.onclick = () => {
          const c = b.getAttribute("data-cat");
          state.hidden.has(c) ? state.hidden.delete(c) : state.hidden.add(c);
          b.classList.toggle("off", state.hidden.has(c));
          renderEvents();
        };
      });
    }

    const shown = state.recent.filter((e) => !state.hidden.has(U.categoryOf(e.kind))).slice(-200);
    elStream.innerHTML = shown.map((ev) => {
      const cat = U.categoryOf(ev.kind);
      return `<li class="ev">
        <span class="seq">${U.esc(ev.seq)}</span>
        <span class="tag ${U.categoryClass(cat)}">${U.esc(U.categoryLabel(cat))}</span>
        <span class="kind dim">${U.esc(ev.kind)}</span>
        <span class="brief">${U.esc(U.briefOf(ev))}</span>
        <button class="raw-toggle" type="button">json</button>
        <pre class="raw" ${elRaw.checked ? "" : "hidden"}>${U.esc(JSON.stringify(ev.payload, null, 2))}</pre>
      </li>`;
    }).join("");
    elStream.querySelectorAll(".raw-toggle").forEach((b) => {
      b.onclick = () => {
        const pre = b.parentElement.querySelector(".raw");
        if (pre) pre.hidden = !pre.hidden;
      };
    });
  }

  function renderTelemetry() {
    const t = state.telemetry;
    const brain = $("t-brain");
    if (!t) {
      brain.textContent = "no brain (observer only)";
      $("t-cards").innerHTML = "";
      $("t-tools").innerHTML = "";
      $("t-thinking").innerHTML = "";
      $("t-turn-table").innerHTML = "";
      return;
    }
    const b = t.brain || {};
    brain.textContent = b.kind
      ? `${b.kind === "real" ? "🧠" : "🧪"} ${b.kind} · ${b.provider || "—"} / ${b.model || "—"}`
      : "not set";

    const u = (t.usage && t.usage.total) || {};
    const totals = t.totals || {};
    const cards = [
      ["Turns", `${U.fmtInt(t.activeTurn)} / ${U.fmtInt(t.turns)}`],
      ["Decisions", U.fmtInt(totals.decisions)],
      ["Tool calls", `${U.fmtInt(totals.toolCalls)}${totals.toolFailures ? ` (${U.fmtInt(totals.toolFailures)} failed)` : ""}`],
      ["Input tokens", U.fmtTok(u.input)],
      ["Output tokens", U.fmtTok(u.output)],
      ["Reasoning", U.fmtTok(u.reasoning)],
      ["Cache r/w", `${U.fmtTok(u.cacheRead)} / ${U.fmtTok(u.cacheWrite)}`],
      ["Total tokens", U.fmtTok(u.totalTokens)],
      ["Cost", U.fmtCost(u.costTotal)],
      ["Last activity", U.fmtAgo(t.lastActivityAt)],
    ];
    $("t-cards").innerHTML = cards.map(([k, v]) =>
      `<div class="kpi"><span class="kpi-v">${U.esc(v)}</span><span class="kpi-k">${U.esc(k)}</span></div>`).join("");

    const byTurn = (t.usage && t.usage.byTurn) || [];
    U.drawLines($("t-chart"), [
      { color: "#5fb3ff", data: byTurn.map((r) => Number(r.usage && r.usage.input) || 0) },
      { color: "#7bc96f", data: byTurn.map((r) => Number(r.usage && r.usage.output) || 0) },
    ], { compact: true, padLeft: 40, nonNegative: true });
    $("t-turn-table").innerHTML = byTurn.length
      ? `<table class="kv"><tr><td class="dim">turn</td><td class="dim">in</td><td class="dim">out</td><td class="dim">reason</td><td class="dim">total</td><td class="dim">steps</td></tr>` +
        byTurn.map((r) => `<tr><td>${U.esc(r.turn)}</td><td>${U.fmtTok(r.usage.input)}</td>
          <td>${U.fmtTok(r.usage.output)}</td><td>${U.fmtTok(r.usage.reasoning)}</td>
          <td>${U.fmtTok(r.usage.totalTokens)}</td><td>${U.fmtInt(r.steps)}</td></tr>`).join("") + `</table>`
      : `<p class="empty">No LLM turns recorded yet.</p>`;

    const byTool = (t.usage && t.usage.byTool) || [];
    $("t-tools").innerHTML = byTool.length
      ? `<table class="kv"><tr><td class="dim">tool</td><td class="dim">calls</td><td class="dim">fail</td><td class="dim">avg</td></tr>` +
        byTool.map((r) => `<tr><td>${U.esc(r.tool)}</td><td>${U.fmtInt(r.calls)}</td>
          <td class="${r.failures ? "neg" : ""}">${U.fmtInt(r.failures)}</td>
          <td>${U.fmtDuration(r.avgDurationMs)}</td></tr>`).join("") + `</table>`
      : `<p class="empty">No tool calls yet.</p>`;

    const th = state.thinking || [];
    $("t-thinking").innerHTML = th.length
      ? th.slice().reverse().map((x) =>
          `<li><span class="badge">turn ${U.esc(x.turn)}</span> <span class="dim">${U.esc(U.fmtClock(x.ts))}</span>
            <pre>${U.esc(x.text)}</pre></li>`).join("")
      : `<li class="empty">No thinking captured yet.</li>`;
  }

  function renderSteps() {
    elStepsCount.textContent = `(${state.steps.length})`;
    elSteps.innerHTML = state.steps.slice(-200).map((s) => {
      const cls = s.kind === "tool" ? (s.ok ? "tool-ok" : "tool-bad") : "msg";
      return `<li class="step ${cls}">
        <div class="step-head">
          <span class="badge">${s.kind === "tool" ? "tool" : "LLM"}</span>
          <span class="badge">turn ${U.esc(s.turn)}</span>
          <span class="step-title">${U.esc(s.kind === "tool" ? `${s.tool} — ${s.summary || ""}` : (s.model || "assistant"))}</span>
          ${s.durationMs !== undefined ? `<span class="dim">${U.fmtDuration(s.durationMs)}</span>` : ""}
          ${s.usage ? `<span class="dim">${U.fmtTok(s.usage.totalTokens)} tok · ${U.fmtCost(s.usage.costTotal)}</span>` : ""}
        </div>
        ${s.thinking ? `<details class="think"><summary>thinking</summary><pre>${U.esc(s.thinking)}</pre></details>` : ""}
        ${s.text ? `<div class="step-text">${U.esc(s.text)}</div>` : ""}
        ${s.args !== undefined ? `<details><summary>args</summary><pre>${U.esc(JSON.stringify(s.args, null, 2))}</pre></details>` : ""}
      </li>`;
    }).join("");
    if (elAutoScroll.checked) elSteps.scrollTop = elSteps.scrollHeight;
  }

  function renderStages() {
    const t = state.telemetry;
    const stages = (t && t.checkpoints) || [];
    elStages.innerHTML = stages.length
      ? stages.map((c) => `<li><span class="dim">${U.esc(c.gameDate)} · turn ${U.esc(c.turn)}</span> ${U.esc(c.note)}</li>`).join("")
      : `<li class="empty">Checkpoints appear as decision turns complete.</li>`;
  }

  elRaw.onchange = renderEvents;
  renderAll();
})();
