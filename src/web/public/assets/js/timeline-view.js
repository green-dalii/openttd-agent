/* Timeline view — the pure logic of the causal timeline (B3).
 *
 * 职责: 把服务端给的**一行因果链**（decision → tools → job/phase → effect）
 *   变成页面上要画的每一条线。**只画服务端给的**：页面不重算增量、不判断成败、
 *   不猜 job 的归属——那些是服务端的规则（src/agent/causal-timeline.ts）。
 * 铁律:
 *   - **缺失就是"not measured"**：服务端给 null 时页面写 `not measured`，
 *     绝不显示 0（"没测到"与"测到是 0"是两回事，D60）。
 *   - 页面不自己归一化数字：显示的每个数都来自服务端。
 *
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.1；SPEC §10.119。
 */
"use strict";
(function () {
  /** One tool call of a decision. */
  function tools(row) {
    if (!row || !Array.isArray(row.tools)) return [];
    return row.tools.map((t) => ({
      tool: String(t.tool || "—"),
      ok: t.ok === true,
      summary: String(t.summary || ""),
      job: typeof t.job === "number" ? t.job : null,
    }));
  }

  /** The GS work a decision ordered, with its phases. */
  function jobs(row) {
    if (!row || !Array.isArray(row.jobs)) return [];
    return row.jobs.map((j) => ({
      job: Number(j.job),
      command: j.command ? String(j.command) : null,
      phases: (Array.isArray(j.phases) ? j.phases : []).map((p) => ({
        stage: String(p.stage || "—"),
        phase: String(p.phase || ""),
      })),
    }));
  }

  /**
   * The effect of a decision: what changed until the next one.
   *
   * Every reading is either a number or "not measured" — the page never
   * invents a zero for a reading the server did not have.
   */
  function effect(row) {
    const e = row && row.effect ? row.effect : null;
    if (!e) return null;
    const entry = (label, value, kind) => ({
      label,
      kind,
      text: typeof value === "number" && Number.isFinite(value) ? formatNumber(kind, value) : "not measured",
      known: typeof value === "number" && Number.isFinite(value),
    });
    return [
      entry("Money", e.money, "money"),
      entry("Income", e.income, "money"),
      entry("Vehicles", e.vehicles, "count"),
      entry("Stations", e.stations, "count"),
      entry("Delivered", e.delivered, "count"),
      entry("Game days", e.gameDays, "days"),
    ];
  }

  function formatNumber(kind, value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "not measured";
    // The sign is part of the reading: a loss of £9,600 must not read as
    // "£9,600" (the same digits, the opposite meaning).
    const sign = n > 0 ? "+" : n < 0 ? "-" : "";
    if (kind === "money") return `${sign}£${Math.abs(n).toLocaleString("en-US")}`;
    if (kind === "days") return `${sign}${Math.abs(n)}`;
    return `${sign}${Math.abs(n).toLocaleString("en-US")}`;
  }

  /** The headline of a row: which decision, what triggered it, what it wanted. */
  function headline(row) {
    if (!row) return { turn: "—", trigger: "—", date: "—", goal: null };
    return {
      turn: row.turn === null || row.turn === undefined ? "—" : `#${row.turn}`,
      trigger: row.trigger ? String(row.trigger) : "—",
      date: row.gameDate ? String(row.gameDate) : "—",
      goal: row.goal ? String(row.goal) : null,
    };
  }

  /**
   * A one-line summary of a row (the collapsed state).
   *
   * It carries only the **effect** part: the head of the row already shows
   * the turn, the trigger and the date, and repeating them made the line read
   * "#3 event 1950-04-20 #3 event — ...".
   */
  function summary(row) {
    const e = effect(row);
    if (!e) return "no later reading yet";
    const known = e.filter((x) => x.known && x.label !== "Game days");
    return known.length ? known.map((x) => `${x.label} ${x.text}`).join(" · ") : "nothing measurable yet";
  }

  /** The rows of the page, newest first (the server already ordered them). */
  function rows(page) {
    if (!page || !Array.isArray(page.rows)) return [];
    return page.rows;
  }

  /** Does the page have older rows to load? */
  function hasMore(page, shown) {
    if (!page) return false;
    const total = Number(page.total);
    if (!Number.isFinite(total)) return false;
    const count = typeof shown === "number" ? shown : rows(page).length;
    return count < total;
  }

  window.TimelineView = {
    tools,
    jobs,
    effect,
    headline,
    summary,
    rows,
    hasMore,
    formatNumber,
  };
})();
