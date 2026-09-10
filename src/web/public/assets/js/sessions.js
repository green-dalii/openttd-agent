/* Sessions page — list past game sessions, inspect outcome + replay events.
 *
 * 职责: 列出 <dataDir>/sessions（历史局），选中后展示成绩单（outcome）、
 *   阶段性总结（checkpoints）、agent 步骤与事件流（按类别 Tag 呈现）。
 * 事实来源: docs/DASHBOARD-API.md §2.5/§3.3。
 * 禁止: 写入任何内容（本页只读）；不重放未授权的控制指令。
 */
"use strict";
(function () {
  const U = window.UI;
  const $ = U.$;
  $("nav").innerHTML = U.renderNav("/sessions");

  const elList = $("session-list"), elCount = $("s-count"),
        elDone = $("s-done"), elTokens = $("s-tokens"),
        elDetail = $("session-detail"), elTitle = $("replay-title"),
        elStepsPanel = $("detail-steps-panel"), elSteps = $("detail-steps"),
        elStepsCount = $("detail-steps-count");

  let sessions = [];
  let selected = null;

  function statusBadge(s) {
    const cls = s === "completed" ? "ok" : s === "running" ? "live" : "bad";
    return `<span class="badge ${cls}">${U.esc(s)}</span>`;
  }

  async function load() {
    try {
      const r = await fetch("/api/sessions");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      sessions = (await r.json()).sessions || [];
    } catch (e) {
      elList.innerHTML = `<li class="empty">Could not list sessions: ${U.esc(e)}</li>`;
      return;
    }
    elCount.textContent = String(sessions.length);
    elDone.textContent = String(sessions.filter((s) => s.status === "completed").length);
    const toks = sessions.reduce((a, s) => a + Number(s?.totals?.usage?.totalTokens || 0), 0);
    elTokens.textContent = U.fmtTok(toks);

    elList.innerHTML = sessions.map((s) => {
      const t = s.totals || {};
      return `<li class="pick ${s.id === selected ? "sel" : ""}" data-id="${U.esc(s.id)}">
        <div class="pick-main">
          <span class="pick-name">${U.esc(s.id)}</span>
          ${statusBadge(s.status)}
          <span class="badge">${U.esc(s.mode)}</span>
        </div>
        <div class="pick-sub dim">
          seed ${U.esc(s.seed)} · ${U.esc(s.companyName || "—")} ·
          ${U.fmtAgo(s.startedAt)}${s.endedAt ? ` · ran ${U.fmtDuration(s.endedAt - s.startedAt)}` : " · running"}<br/>
          ${U.fmtInt(t.decisions)} decisions · ${U.fmtInt(t.toolCalls)} tools
          (${U.fmtInt(t.toolFailures)} failed) · ${U.fmtInt(t.events)} events ·
          ${U.fmtTok(t.usage && t.usage.totalTokens)} tokens ·
          ${U.fmtCost(t.usage && t.usage.costTotal)}
        </div>
      </li>`;
    }).join("") || `<li class="empty">No sessions yet. Run <code>pnpm run cli --watch</code> or <code>--agent</code>.</li>`;

    for (const li of elList.querySelectorAll(".pick")) {
      li.onclick = () => open(li.getAttribute("data-id"));
    }
  }

  async function open(id) {
    selected = id;
    elList.querySelectorAll(".pick").forEach((li) =>
      li.classList.toggle("sel", li.getAttribute("data-id") === id));
    elTitle.textContent = id;
    elDetail.innerHTML = `<p class="empty">Loading…</p>`;
    let data;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (e) {
      elDetail.innerHTML = `<p class="empty">Could not load: ${U.esc(e)}</p>`;
      return;
    }

    const meta = data.meta || {};
    const o = meta.outcome || {};
    const t = meta.totals || {};
    const usage = t.usage || {};
    const tel = data.telemetry || null;

    elDetail.innerHTML = `
      <table class="kv">
        <tr><td>Status</td><td>${statusBadge(meta.status)} ${meta.error ? U.esc(meta.error) : ""}</td></tr>
        <tr><td>Mode</td><td>${U.esc(meta.mode)} · seed ${U.esc(meta.seed)} · from ${U.esc(meta.startYear)}</td></tr>
        <tr><td>Map</td><td>${U.esc((meta.mapSize || []).join("×"))}</td></tr>
        <tr><td>Brain</td><td>${U.esc(meta.llm ? `${meta.llm.kind} · ${meta.llm.providerId || "—"} / ${meta.llm.model || "—"}` : "—")}</td></tr>
        <tr><td>Ran</td><td>${U.esc(U.fmtClock(meta.startedAt))}${meta.endedAt ? ` → ${U.esc(U.fmtClock(meta.endedAt))} (${U.fmtDuration(meta.endedAt - meta.startedAt)})` : " · still running"}</td></tr>
        <tr><td>Tokens</td><td>in ${U.fmtInt(usage.input)} · out ${U.fmtInt(usage.output)} ·
          cache r/w ${U.fmtInt(usage.cacheRead)}/${U.fmtInt(usage.cacheWrite)} ·
          total ${U.fmtInt(usage.totalTokens)} · ${U.fmtCost(usage.costTotal)}</td></tr>
      </table>
      ${Object.keys(o).length ? `
        <h3>Outcome</h3>
        <table class="kv">
          ${o.constructionDone !== undefined ? `<tr><td>Construction</td><td>${o.constructionDone ? "done ✅" : "not finished"}</td></tr>` : ""}
          ${o.phase ? `<tr><td>Last phase</td><td><code>${U.esc(o.phase)}</code></td></tr>` : ""}
          ${o.vehicles !== undefined ? `<tr><td>Vehicles</td><td>${U.esc(o.vehicles)}</td></tr>` : ""}
          ${o.stations !== undefined ? `<tr><td>Stations</td><td>${U.esc(o.stations)}</td></tr>` : ""}
          ${o.money !== undefined ? `<tr><td>Cash</td><td>${U.fmtMoney(o.money)}</td></tr>` : ""}
          ${o.totalEvents !== undefined ? `<tr><td>Events</td><td>${U.fmtInt(o.totalEvents)}</td></tr>` : ""}
        </table>` : ""}
      ${(meta.checkpoints || []).length ? `
        <h3>Staged summaries</h3>
        <ol class="timeline">${meta.checkpoints.map((c) =>
          `<li><span class="dim">${U.esc(c.gameDate)} (turn ${U.esc(c.turn)})</span> ${U.esc(c.note)}</li>`).join("")}</ol>` : ""}
      <h3>Event log <span class="dim">(${(data.events || []).length} shown)</span></h3>
      <ol class="events short">${(data.events || []).slice(-80).map(renderEvent).join("")}</ol>
    `;

    // Agent steps (from the archived telemetry, when the run had a brain).
    const steps = (tel && tel.steps) || [];
    elStepsPanel.hidden = steps.length === 0;
    elStepsCount.textContent = steps.length ? `(${steps.length})` : "";
    elSteps.innerHTML = steps.slice(-120).map((s) => renderStep(s)).join("");
    bindExpanders(elDetail);
    bindExpanders(elSteps);
  }

  function renderEvent(ev) {
    const cat = U.categoryOf(ev.kind);
    return `<li class="ev">
      <span class="seq">${U.esc(ev.seq)}</span>
      <span class="tag ${U.categoryClass(cat)}">${U.esc(U.categoryLabel(cat))}</span>
      <span class="kind dim">${U.esc(ev.kind)}</span>
      <span class="brief">${U.esc(U.briefOf(ev))}</span>
      <button class="raw-toggle" type="button">json</button>
      <pre class="raw" hidden>${U.esc(JSON.stringify(ev.payload, null, 2))}</pre>
    </li>`;
  }

  function renderStep(s) {
    const cls = s.kind === "tool" ? (s.ok ? "tool-ok" : "tool-bad") : "msg";
    const title = s.kind === "tool"
      ? `${U.esc(s.tool)} ${U.esc(s.summary || "")}`
      : `${U.esc(s.model || "assistant")}`;
    return `<li class="step ${cls}">
      <div class="step-head">
        <span class="badge">${s.kind === "tool" ? "tool" : "LLM"}</span>
        <span class="badge">turn ${U.esc(s.turn)}</span>
        <span class="step-title">${title}</span>
        ${s.durationMs !== undefined ? `<span class="dim">${U.fmtDuration(s.durationMs)}</span>` : ""}
        ${s.usage ? `<span class="dim">${U.fmtInt(s.usage.totalTokens)} tok · ${U.fmtCost(s.usage.costTotal)}</span>` : ""}
      </div>
      ${s.thinking ? `<details class="think"><summary>thinking</summary><pre>${U.esc(s.thinking)}</pre></details>` : ""}
      ${s.text ? `<div class="step-text">${U.esc(s.text)}</div>` : ""}
      ${s.args !== undefined ? `<details><summary>args</summary><pre>${U.esc(JSON.stringify(s.args, null, 2))}</pre></details>` : ""}
      ${s.data ? `<details><summary>data</summary><pre>${U.esc(JSON.stringify(s.data, null, 2))}</pre></details>` : ""}
    </li>`;
  }

  function bindExpanders(root) {
    root.querySelectorAll(".raw-toggle").forEach((b) => {
      b.onclick = () => {
        const pre = b.parentElement.querySelector(".raw");
        if (pre) pre.hidden = !pre.hidden;
      };
    });
  }

  load();
})();
