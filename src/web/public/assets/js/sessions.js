/* Sessions page — browse past runs, replay one, compare two.
 *
 * 职责: 列出 <dataDir>/sessions（历史局），展示成绩单 / token 构成 / 阶段性总结 /
 *   agent 步骤 / 事件流，并支持**两次运行对比**（历史数据的真正价值）。
 * 事实来源: docs/DASHBOARD-UI.md §5.3、docs/DASHBOARD-API.md §2.5/§3.3。
 * 禁止: 写入任何内容（本页只读）；不重放控制指令。
 */
"use strict";
(function () {
  const U = window.UI;
  const C = window.Charts;
  const $ = U.$;
  $("nav").innerHTML = U.renderNav("/sessions");

  const state = {
    sessions: [],
    selected: null,
    data: null,
    onlyDone: U.getPref("sessions.onlyDone", false),
    stepFilter: "all",
    stepRaw: false,
    compareWith: null,
    compareData: null,
  };

  const elList = $("session-list"), elCount = $("s-count"), elDone = $("s-done"),
        elRate = $("s-rate"), elTokens = $("s-tokens"), elCost = $("s-cost"),
        elDetail = $("session-detail"), elTitle = $("replay-title"),
        elStepsPanel = $("steps-panel"), elSteps = $("detail-steps"),
        elStepsCount = $("steps-count"), elOnlyDone = $("only-done"),
        elRawSteps = $("raw-steps"), elCompare = $("compare"),
        elComparePanel = $("compare-panel"), elCompareBody = $("compare-body"),
        elComparePick = $("compare-pick");

  const statusBadge = (s) => {
    const cls = s === "completed" ? "ok" : s === "running" ? "live" : s === "error" ? "bad" : "warn";
    return `<span class="badge ${cls}">${U.esc(s)}</span>`;
  };

  /* ------------------------------- list ------------------------------- */
  async function load() {
    try {
      const r = await fetch("/api/sessions");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.sessions = (await r.json()).sessions || [];
    } catch (e) {
      elList.innerHTML = `<li class="empty">Could not list runs: ${U.esc(e)}</li>`;
      return;
    }
    renderTotals();
    renderList();
  }

  function renderTotals() {
    const all = state.sessions;
    const done = all.filter((s) => s.status === "completed");
    const built = done.filter((s) => s.outcome && s.outcome.constructionDone);
    const tokens = all.reduce((a, s) => a + Number((s.totals || {}).usage?.totalTokens || 0), 0);
    const cost = all.reduce((a, s) => a + Number((s.totals || {}).usage?.costTotal || 0), 0);
    elCount.textContent = String(all.length);
    elDone.textContent = String(done.length);
    elRate.textContent = done.length ? U.fmtPct(built.length / done.length, 0) : "—";
    elRate.title = `${built.length} of ${done.length} completed runs reached construction-done`;
    elTokens.textContent = U.fmtTok(tokens);
    elCost.textContent = U.fmtCost(cost);
  }

  function renderList() {
    const list = state.onlyDone ? state.sessions.filter((s) => s.status === "completed") : state.sessions;
    elList.innerHTML = list.map((s) => {
      const t = s.totals || {};
      const o = s.outcome || {};
      const u = t.usage || {};
      const built = o.constructionDone;
      return `<li class="pick ${s.id === state.selected ? "sel" : ""}" data-id="${U.esc(s.id)}">
        <div class="pick-main">
          <span class="pick-name">${U.esc(s.id)}</span>
          ${statusBadge(s.status)}
          <span class="badge">${U.esc(s.mode)}</span>
          ${built === true ? '<span class="badge ok">built</span>' : ""}
          ${built === false ? '<span class="badge warn">incomplete</span>' : ""}
        </div>
        <div class="pick-sub">
          seed ${U.esc(s.seed)} · ${U.esc(s.companyName || "—")} ·
          ${s.endedAt ? U.fmtDuration(s.endedAt - s.startedAt) : "running"} · ${U.fmtAgo(s.startedAt)}<br />
          ${U.fmtMoney(o.money)} · ${U.fmtInt(o.vehicles)} veh · ${U.fmtInt(o.stations)} stn ·
          ${U.fmtInt(t.decisions)} decisions · ${U.fmtInt(t.toolCalls)} tools${
            t.toolFailures ? ` <span class="neg">(${U.fmtInt(t.toolFailures)} failed)</span>` : ""} ·
          ${U.fmtTok(u.totalTokens)} tok · ${U.fmtCost(u.costTotal)}
        </div>
      </li>`;
    }).join("") || `<li class="empty">No runs archived yet.
      <span class="empty-cta"><code>pnpm run cli --watch --web-port 8080</code></span></li>`;
    for (const li of elList.querySelectorAll(".pick")) {
      li.onclick = () => open(li.getAttribute("data-id"));
    }
  }

  /* ------------------------------ detail ------------------------------ */
  async function open(id) {
    state.selected = id;
    state.compareWith = null;
    state.compareData = null;
    elComparePanel.hidden = true;
    elCompare.disabled = true;
    renderList();
    elTitle.textContent = id;
    elDetail.innerHTML = `<p class="empty">Loading…</p>`;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.data = await r.json();
    } catch (e) {
      elDetail.innerHTML = `<p class="empty">Could not load: ${U.esc(e)}</p>`;
      return;
    }
    renderDetail();
  }

  function renderDetail() {
    const data = state.data || {};
    const meta = data.meta || {};
    const o = meta.outcome || {};
    const t = meta.totals || {};
    const u = t.usage || {};
    const tel = data.telemetry || null;
    const cps = meta.checkpoints || [];

    const tokens = [
      { label: "Input", value: u.input, color: "#5fb3ff" },
      { label: "Output", value: u.output, color: "#7bc96f" },
      { label: "Reasoning", value: u.reasoning, color: "#c3a6ff" },
      { label: "Cache read", value: u.cacheRead, color: "#56d4dd" },
      { label: "Cache write", value: u.cacheWrite, color: "#e5c07b" },
    ].filter((x) => Number(x.value) > 0);

    elDetail.innerHTML = `
      <div class="kpis" style="margin-bottom:12px">
        ${U.kpi({ label: "Result", value: o.constructionDone === true
          ? '<span class="pos">built</span>'
          : o.constructionDone === false ? '<span class="warn">incomplete</span>' : "—",
          hint: o.phase ? `last phase: ${o.phase}` : "" })}
        ${U.kpi({ label: "Cash", value: U.fmtMoney(o.money) })}
        ${U.kpi({ label: "Fleet", value: `${U.fmtInt(o.vehicles)} <span class="dim">veh</span>`,
          hint: `${U.fmtInt(o.stations)} stations` })}
        ${U.kpi({ label: "Tokens", value: U.fmtTok(u.totalTokens), hint: U.fmtCost(u.costTotal) })}
        ${U.kpi({ label: "Tool failures", value: U.fmtInt(t.toolFailures),
          hint: `${U.fmtInt(t.toolCalls)} calls` })}
      </div>

      <div class="grid two">
        <div>
          <h3>Run</h3>
          <table class="kv">
            <tr><td>Status</td><td>${statusBadge(meta.status)} ${meta.error ? U.esc(meta.error) : ""}</td></tr>
            <tr><td>Mode</td><td>${U.esc(meta.mode)} · seed ${U.esc(meta.seed)} · from ${U.esc(meta.startYear)}</td></tr>
            <tr><td>Map</td><td>${U.esc((meta.mapSize || []).join("×"))} · ${U.esc(meta.serverName || "")}</td></tr>
            <tr><td>Brain</td><td>${U.esc(meta.llm ? `${meta.llm.kind} · ${meta.llm.providerId || "—"} / ${meta.llm.model || "—"}` : "—")}</td></tr>
            <tr><td>Started</td><td>${U.esc(U.fmtClock(meta.startedAt))} · ${U.fmtAgo(meta.startedAt)}</td></tr>
            <tr><td>Duration</td><td>${meta.endedAt ? U.fmtDuration(meta.endedAt - meta.startedAt) : "running"}</td></tr>
            <tr><td>Events</td><td>${U.fmtInt(t.events)} recorded · ${(data.events || []).length} in archive</td></tr>
          </table>

          <h3>Token breakdown</h3>
          <div class="chart-box"><canvas id="detail-donut" height="200"></canvas></div>
          <div class="legend">${tokens.map((x) =>
            `<span class="lg"><i style="background:${x.color}"></i>${U.esc(x.label)} ${U.fmtTok(x.value)}</span>`).join("")}</div>
        </div>

        <div>
          <h3>Staged summaries <span class="dim">阶段性总结</span></h3>
          ${cps.length ? `<ol class="timeline">${cps.slice().reverse().map((c) => `<li>
              <span class="t-meta">${U.esc(c.gameDate)} · turn ${U.esc(c.turn)}</span>${U.esc(c.note)}</li>`).join("")}</ol>`
            : `<p class="hint">No staged summaries recorded for this run.</p>`}

          <h3>Event log <span class="dim">(${(data.events || []).length} archived)</span></h3>
          <input id="detail-ev-search" class="filter" type="search" placeholder="Search events…"
                 style="width:100%;margin-bottom:6px" />
          <ol id="detail-events" class="events short">${(data.events || []).slice(-120).reverse().map(renderEvent).join("")}</ol>
        </div>
      </div>
    `;
    bindRawToggles(elDetail);

    if (tokens.length) {
      const cv = $("detail-donut");
      if (cv) {
        C.donut(cv, {
          slices: tokens.map((x) => ({ label: x.label, value: x.value, color: x.color })),
          center: { value: U.fmtTok(u.totalTokens), label: "tokens" },
          height: 200,
        });
      }
    }

    const evSearch = $("detail-ev-search");
    if (evSearch) {
      evSearch.oninput = () => {
        const q = evSearch.value.trim();
        const shown = (data.events || []).filter((e) => U.eventMatches(e, q)).slice(-120).reverse();
        $("detail-events").innerHTML = shown.map(renderEvent).join("") ||
          `<li class="empty">No events match.</li>`;
        bindRawToggles(elDetail);
      };
    }

    renderSteps((tel && tel.steps) || []);
    // Comparing needs at least one other run to compare against.
    elCompare.disabled = !state.selected || state.sessions.filter((s) => s.id !== state.selected).length === 0;
  }

  function renderEvent(ev) {
    const cat = U.categoryOf(ev.kind);
    return `<li class="ev">
      <span class="seq">${U.esc(ev.seq)}</span>
      <span class="tag ${U.categoryClass(cat)}">${U.esc(U.categoryLabel(cat))}</span>
      <span class="kind">${U.esc(ev.kind)}</span>
      <span class="brief">${U.esc(U.briefOf(ev))}</span>
      <button class="raw-toggle" type="button">json</button>
      <pre class="raw" hidden>${U.esc(JSON.stringify(ev.payload, null, 2))}</pre>
    </li>`;
  }

  /* ------------------------------- steps ------------------------------- */
  U.segmented($("step-filter"), {
    options: [
      { id: "all", label: "All" },
      { id: "message", label: "LLM" },
      { id: "tool", label: "Tools" },
      { id: "failed", label: "Failures" },
    ],
    value: () => state.stepFilter,
    onChange: (id) => { state.stepFilter = id; renderSteps(state.steps || []); },
  });

  function renderSteps(steps) {
    state.steps = steps;
    const shown = steps.filter((s) => {
      if (state.stepFilter === "message") return s.kind === "message";
      if (state.stepFilter === "tool") return s.kind === "tool";
      if (state.stepFilter === "failed") return s.kind === "tool" && s.ok === false;
      return true;
    }).slice(-150);
    elStepsPanel.hidden = steps.length === 0;
    elStepsCount.textContent = steps.length ? `(${shown.length}/${steps.length})` : "";
    elSteps.innerHTML = shown.map(renderStep).join("");
    bindRawToggles(elSteps);
  }

  function renderStep(s) {
    const cls = s.kind === "tool" ? (s.ok ? "tool-ok" : "tool-bad") : "msg";
    return `<li class="step ${cls}">
      <div class="step-head">
        <span class="badge${s.kind === "tool" && s.ok === false ? " bad" : ""}">${s.kind === "tool" ? "tool" : "LLM"}</span>
        <span class="badge">turn ${U.esc(s.turn)}</span>
        <span class="step-title">${U.esc(s.kind === "tool" ? `${s.tool} — ${s.summary || ""}` : (s.model || "assistant"))}</span>
        ${s.durationMs !== undefined ? `<span class="dim">${U.fmtDuration(s.durationMs)}</span>` : ""}
        ${s.usage ? `<span class="dim">${U.fmtTok(s.usage.totalTokens)} tok · ${U.fmtCost(s.usage.costTotal)}</span>` : ""}
      </div>
      ${s.thinking ? `<details class="think" open><summary>reasoning</summary><pre>${U.esc(s.thinking)}</pre></details>` : ""}
      ${s.text ? `<div class="step-text">${U.esc(s.text)}</div>` : ""}
      ${state.stepRaw && s.args !== undefined ? `<details open><summary>args</summary><pre>${U.esc(JSON.stringify(s.args, null, 2))}</pre></details>` : ""}
      ${state.stepRaw && s.data ? `<details open><summary>result</summary><pre>${U.esc(JSON.stringify(s.data, null, 2))}</pre></details>` : ""}
    </li>`;
  }

  /* ------------------------------ compare ------------------------------ */
  $("compare").onclick = async () => {
    if (!state.selected) return;
    const others = state.sessions.filter((s) => s.id !== state.selected);
    if (!others.length) { U.toast("Only one run archived so far.", "warn"); return; }
    elComparePanel.hidden = false;
    elComparePick.innerHTML = "";
    U.combobox(elComparePick, {
      placeholder: "Pick a run to compare against…",
      options: () => others.map((s) => ({
        id: s.id, label: s.id, search: `${s.id} ${s.mode} ${s.status}`,
        sub: `${s.mode} · seed ${s.seed} · ${U.fmtTok((s.totals || {}).usage?.totalTokens || 0)} tok`,
      })),
      value: () => state.compareWith,
      onChange: (id) => compareWith(id),
    });
    U.toast("Pick the run to compare against.", "info", 2500);
  };

  $("compare-close").onclick = () => { elComparePanel.hidden = true; };

  async function compareWith(id) {
    state.compareWith = id;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.compareData = await r.json();
    } catch (e) {
      elCompareBody.innerHTML = `<p class="empty">Could not load ${U.esc(id)}: ${U.esc(e)}</p>`;
      return;
    }
    renderCompare();
  }

  function renderCompare() {
    const a = state.data || {}, b = state.compareData || {};
    const ma = a.meta || {}, mb = b.meta || {};
    const ta = ma.totals || {}, tb = mb.totals || {};
    const ua = ta.usage || {}, ub = tb.usage || {};
    const oa = ma.outcome || {}, ob = mb.outcome || {};
    const dur = (m) => (m.endedAt ? m.endedAt - m.startedAt : undefined);

    const rows = [
      ["Result", oa.constructionDone === true ? "built" : oa.constructionDone === false ? "incomplete" : "—",
        ob.constructionDone === true ? "built" : ob.constructionDone === false ? "incomplete" : "—", null],
      ["Cash", U.fmtMoney(oa.money), U.fmtMoney(ob.money), Number(ob.money) - Number(oa.money)],
      ["Vehicles", U.fmtInt(oa.vehicles), U.fmtInt(ob.vehicles), Number(ob.vehicles) - Number(oa.vehicles)],
      ["Stations", U.fmtInt(oa.stations), U.fmtInt(ob.stations), Number(ob.stations) - Number(oa.stations)],
      ["Decisions", U.fmtInt(ta.decisions), U.fmtInt(tb.decisions), Number(tb.decisions) - Number(ta.decisions)],
      ["Tool calls", U.fmtInt(ta.toolCalls), U.fmtInt(tb.toolCalls), Number(tb.toolCalls) - Number(ta.toolCalls)],
      ["Tool failures", U.fmtInt(ta.toolFailures), U.fmtInt(tb.toolFailures), Number(tb.toolFailures) - Number(ta.toolFailures)],
      ["Tokens", U.fmtTok(ua.totalTokens), U.fmtTok(ub.totalTokens), Number(ub.totalTokens) - Number(ua.totalTokens)],
      ["Cost", U.fmtCost(ua.costTotal), U.fmtCost(ub.costTotal), Number(ub.costTotal) - Number(ua.costTotal)],
      ["Duration", dur(ma) ? U.fmtDuration(dur(ma)) : "—", dur(mb) ? U.fmtDuration(dur(mb)) : "—",
        dur(ma) && dur(mb) ? dur(mb) - dur(ma) : NaN],
      ["Mode", ma.mode, mb.mode, null],
      ["Model", (ma.llm && ma.llm.model) || "—", (mb.llm && mb.llm.model) || "—", null],
    ];

    elCompareBody.innerHTML = `
      <table class="kv">
        <tr><th>Metric</th><th class="num">${U.esc(ma.id || "—")}</th>
            <th class="num">${U.esc(mb.id || "—")}</th><th class="num">Δ</th></tr>
        ${rows.map(([k, va, vb, d]) => `<tr>
          <td>${U.esc(k)}</td><td class="num">${U.esc(va)}</td><td class="num">${U.esc(vb)}</td>
          <td class="num">${Number.isFinite(d)
            ? `<span class="${d > 0 ? "pos" : d < 0 ? "neg" : "dim"}">${d > 0 ? "+" : ""}${U.esc(
                typeof d === "number" && Math.abs(d) >= 1000 ? U.fmtInt(Math.round(d)) : Math.round(d * 1000) / 1000)}</span>`
            : "—"}</td></tr>`).join("")}
      </table>
      <p class="hint" style="margin-top:8px">
        Δ is the right-hand run minus the left-hand one, so a positive Δ on Cash is an improvement
        while a positive Δ on Tool failures or Cost is a regression.
      </p>`;
  }

  /* ------------------------------ controls ------------------------------ */
  function bindRawToggles(root) {
    for (const b of (root || document).querySelectorAll(".raw-toggle")) {
      b.onclick = () => {
        const pre = b.parentElement.querySelector(".raw");
        if (pre) pre.hidden = !pre.hidden;
      };
    }
  }

  elOnlyDone.checked = state.onlyDone;
  elOnlyDone.onchange = () => {
    state.onlyDone = elOnlyDone.checked;
    U.setPref("sessions.onlyDone", state.onlyDone);
    renderList();
  };
  elRawSteps.onchange = () => {
    state.stepRaw = elRawSteps.checked;
    renderSteps(state.steps || []);
  };

  load();
})();
