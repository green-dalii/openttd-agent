/* Compare page — the view logic (pure).
 *
 * 职责: 把服务端给的比较结果**画出来**：每个模型一行四轴、排除按原因计数、
 *   两个模型的配对判定、每局的下钻链接。
 * 铁律（AGENTS §5.2 / docs/DASHBOARD-CODESIGN.md §4.2）:
 *   - **页面不下判断**：四轴的数字、配对判定、排除原因全部来自服务端
 *     （scorecard.ts / bench-stats.ts / metrics.ts）。页面只决定怎么写出来。
 *   - **缺失 = "not measured"**：服务端给 null 时写 "not measured"，绝不写 0
 *     （"没测到"与"测到是 0"是两回事，D60）。
 *   - 页面**不重算**任何一个数（页面抄一份规则就会和服务端漂移）。
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.2；docs/DASHBOARD-API.md §3.9。
 */
"use strict";
(function () {
  /** The text for a reading the server did not have. */
  const NOT_MEASURED = "not measured";

  /** Format a number for humans; null/undefined → "not measured". */
  function num(value, digits) {
    if (typeof value !== "number" || !Number.isFinite(value)) return NOT_MEASURED;
    const d = typeof digits === "number" ? digits : 2;
    return value.toLocaleString("en-US", { maximumFractionDigits: d });
  }

  /** A reading with its label; `known` says whether the server had it. */
  function reading(label, value, digits) {
    const known = typeof value === "number" && Number.isFinite(value);
    return { label, text: known ? num(value, digits) : NOT_MEASURED, known };
  }

  /** A share (0..1) as a percentage. */
  function pct(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return { label: "", text: NOT_MEASURED, known: false };
    return { label: "", text: `${(value * 100).toFixed(1)}%`, known: true };
  }

  /**
   * One row per model: the four axes the scorecard computed.
   *
   * The four axes are the scorecard's (ability / efficiency / stability /
   * growth); "comparability" is how many runs actually counted.
   */
  function modelRows(payload) {
    const models = payload && Array.isArray(payload.models) ? payload.models : [];
    return models.map((m) => ({
      model: String(m.model ?? "unknown"),
      requested: Array.isArray(m.requestedModels) ? m.requestedModels.join(", ") : "",
      runs: typeof m.runs === "number" ? m.runs : 0,
      excluded: typeof m.excluded === "number" ? m.excluded : 0,
      ability: [
        reading("Delivered / game day", m.ability && m.ability.mean),
        reading("Median", m.ability && m.ability.median),
        reading("Stations", m.ability && m.ability.stations, 1),
        reading("Vehicles", m.ability && m.ability.vehicles, 1),
      ],
      efficiency: [
        reading("Delivered / M tokens", m.efficiency && m.efficiency.deliveredPerMillionTokens, 1),
        reading("Tokens / decision", m.efficiency && m.efficiency.tokensPerDecision, 0),
        reading("Seconds / run", m.efficiency && m.efficiency.secondsPerRun, 0),
        reading("Cost / run", m.efficiency && m.efficiency.costPerRun, 4),
      ],
      stability: [
        reading("Tool failure rate", pct(m.stability && m.stability.toolFailureRate).text, 0),
        reading("GS errors / run", m.stability && m.stability.gsErrorsPerRun, 1),
      ],
      growth: {
        label: "Growth",
        text: m.growth && m.growth.verdict ? String(m.growth.verdict) : NOT_MEASURED,
        known: Boolean(m.growth && m.growth.verdict),
      },
      growthMessage: m.growth && m.growth.message ? String(m.growth.message) : "",
      outcomes: m.stability && m.stability.outcomes ? m.stability.outcomes : {},
    }));
  }

  /** The runs left out, counted by reason (the server's own reasons). */
  function exclusionRows(payload) {
    const list = payload && Array.isArray(payload.exclusions) ? payload.exclusions : [];
    return list.map((e) => ({ reason: String(e.reason ?? ""), count: Number(e.count ?? 0) }));
  }

  /**
   * The paired comparison of two models — **the server's verdict, verbatim**.
   *
   * The page must not turn "not determinable" into "no difference": that is a
   * different claim, and the sample size is what decides it.
   */
  function comparison(payload) {
    const c = payload && payload.comparison ? payload.comparison : null;
    if (!c) return null;
    return {
      verdict: String(c.verdict ?? "not determinable"),
      message: String(c.message ?? ""),
      pairs: Array.isArray(c.pairs) ? c.pairs.length : 0,
      known: c.verdict === "a_higher" || c.verdict === "b_higher",
      modelA: String(c.modelA ?? ""),
      modelB: String(c.modelB ?? ""),
      meanDiff: typeof c.meanDiff === "number" ? c.meanDiff : null,
      ci: Array.isArray(c.diffCi95) ? c.diffCi95 : null,
    };
  }

  /** The runs (the drill-down list). */
  function runRows(payload) {
    const runs = payload && Array.isArray(payload.runs) ? payload.runs : [];
    return runs.map((r) => ({
      id: String(r.id ?? ""),
      model: String(r.model ?? ""),
      seed: Number(r.seed ?? 0),
      backend: r.backend ? String(r.backend) : "",
      excluded: r.excluded ? String(r.excluded) : "",
      perDay: typeof r.deliveredPerGameDay === "number" ? r.deliveredPerGameDay : null,
      costKnown: r.costKnown === true,
      link: `/sessions?run=${encodeURIComponent(String(r.id ?? ""))}`,
    }));
  }

  /** The models the page may pick from (the server's list, never invented). */
  function modelNames(payload) {
    const models = payload && Array.isArray(payload.models) ? payload.models : [];
    return models.map((m) => String(m.model ?? "")).filter((m) => m !== "");
  }

  window.CompareView = {
    modelRows,
    exclusionRows,
    comparison,
    runRows,
    modelNames,
    reading,
    num,
    NOT_MEASURED,
  };
})();
