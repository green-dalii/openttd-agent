/**
 * Evolution page view model — pure derivations for the cross-game memory view.
 *
 * 职责: 把 `/api/evolution` 的响应变成可直接渲染的行/卡片。**只做展示**。
 * 事实来源: SPEC §6.1 #4、§5.2 #3、§5.3；docs/DASHBOARD-API.md §3.5。
 * 禁止:
 *   - 在此重新实现**规则**（promotion 门槛、"样本是否足够"）。那些判定由服务端
 *     (`src/evolution/web-view.ts`) 给出；浏览器重算会出现两份实现并漂移
 *     （MEMORY.md C1：`toWireSnapshot` 有两份，主模式现金曲线空了一整版）。
 *   - 在此发 HTTP 请求（见 evolution.js）。
 *   - 对"记忆有没有用"下**超出证据**的结论：样本不足时只能明说不足（SPEC §5.3）。
 */

window.EvolutionView = (function () {
  const U = window.UI;

  /** Metrics are the only place the two-arm experiment is legible. */
  function create() {
    return {
      /** Raw API payload: { metrics, lessons, strategies, arms }. */
      data: null,
      loading: true,
      error: null,
      busy: null,

      /* ------------------------------ helpers ------------------------------ */
      // All three guard for a non-array field: this data crosses the wire, and a
      // malformed payload must degrade to an empty list, never a thrown render.
      metrics() {
        const v = this.data && this.data.metrics;
        return Array.isArray(v) ? v : [];
      },
      lessons() {
        const v = this.data && this.data.lessons;
        return Array.isArray(v) ? v : [];
      },
      strategies() {
        const v = this.data && this.data.strategies;
        return Array.isArray(v) ? v : [];
      },
      arms() {
        const v = this.data && this.data.arms;
        return v && typeof v === "object" ? v : null;
      },

      /* --------------------- ① is the memory working? ---------------------- */
      /**
       * The two arms of the SPEC §5.2 #3 experiment.
       *
       * `conclusive` comes from the server (it owns the MIN_LESSON_SAMPLE rule).
       * This only formats — and when it is not conclusive it says what is missing
       * rather than showing a difference nobody should believe yet.
       */
      armCards() {
        const a = this.arms();
        if (!a) return [];
        const card = (label, arm, hint) => ({
          label,
          runs: U.fmtInt(arm && arm.count),
          money: arm && arm.meanMoney !== null ? U.fmtMoney(arm.meanMoney) : "—",
          tokens: arm && arm.meanTokens !== null ? U.fmtTok(arm.meanTokens) : "—",
          built: arm && arm.builtRate !== null ? U.fmtPct(arm.builtRate, 0) : "—",
          hint,
        });
        return [
          card("With lessons", a.withLessons, "memory injected this game"),
          card("Without lessons", a.withoutLessons, "the control arm"),
        ];
      },

      /** The honest headline: a verdict only when the sample supports one. */
      verdictText() {
        const a = this.arms();
        if (!a) return "No data yet.";
        if (!a.conclusive) return a.note || "Not enough runs to compare yet.";
        const d = a.moneyDelta;
        const dir = d === null ? "no measurable" : d > 0 ? "better" : d < 0 ? "worse" : "identical";
        const amount = d === null ? "" : ` by ${U.fmtMoney(Math.abs(d))}`;
        return `Conclusive: runs with lessons ended ${dir}${amount} on average.`;
      },
      verdictOk() {
        const a = this.arms();
        return Boolean(a && a.conclusive);
      },

      /* --------------------------- ② across games -------------------------- */
      /** Newest first: the most recent game is what you came to read. */
      gameRows() {
        return this.metrics()
          .slice()
          .sort((x, y) => (y.startedAt || 0) - (x.startedAt || 0))
          .map((m) => {
            const mem = m.memory || {};
            return {
              id: m.id,
              seed: String(m.seed),
              status: m.status,
              llm: m.llmKind === "real" ? "real" : m.llmKind || "—",
              money: U.fmtMoney(m.money),
              decisions: U.fmtInt(m.decisions),
              tokens: U.fmtTok(m.totalTokens),
              cost: U.fmtCost(m.costTotal),
              memory: mem.lessonsInjected
                ? `${U.fmtInt(mem.lessonsInjected)} lesson(s)`
                : "none",
              hasMemory: Boolean(mem.lessonsInjected),
            };
          });
      },

      /** Money per finished game, oldest first — the trend line. */
      moneySeries() {
        const rows = this.metrics().slice().sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
        return [{ name: "Cash at end", data: rows.map((m) => Number(m.money) || 0) }];
      },
      moneyLabels() {
        return this.metrics()
          .slice()
          .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
          .map((m) => String(m.id || "").slice(-8));
      },

      /* --------------------------- ③ lesson library ------------------------ */
      lessonRows() {
        return this.lessons()
          .slice()
          .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
          .map((l) => ({
            text: l.text,
            kind: l.kind === "dont" ? "dont" : "do",
            kindLabel: l.kind === "dont" ? "avoid" : "do",
            confidence: U.fmtPct(l.confidence || 0, 0),
            evidence: (Array.isArray(l.evidence) ? l.evidence : []).join(" · "),
            source: l.sourceSessionId || "—",
            seed: String(l.sourceSeed),
            superseded: Boolean(l.supersededBy),
          }));
      },

      /* ------------------------- ④ strategy candidates --------------------- */
      /**
       * The candidate pool with the server's verdict.
       *
       * Every card shows WHY it is or is not injectable, because "not promoted"
       * with no reason is indistinguishable from a bug.
       */
      strategyRows() {
        return this.strategies()
          .slice()
          .sort((a, b) => ((b.promotion && b.promotion.value) || 0) - ((a.promotion && a.promotion.value) || 0))
          .map((c) => {
            const p = c.promotion || { promoted: false, value: 0, runs: 0, reason: "" };
            const params = Object.entries(c.params || {})
              .map(([k, v]) => `${k}=${v}`)
              .join(", ");
            return {
              id: c.id,
              label: params ? `${c.action} (${params})` : String(c.action),
              runs: U.fmtInt(p.runs),
              value: U.fmtMoney(p.value),
              // Two independent gates; the page must not collapse them into one
              // "enabled" bit, or a reviewer cannot tell which is missing.
              promoted: Boolean(p.promoted),
              enabled: c.enabled === true,
              injectable: Boolean(p.promoted) && c.enabled === true,
              reason: p.reason || "",
            };
          });
      },
      injectableCount() {
        return this.strategyRows().filter((s) => s.injectable).length;
      },

      /** Nothing at all recorded yet — the page must say so, not render blanks. */
      empty() {
        return !this.loading && !this.error && this.metrics().length === 0 && this.lessons().length === 0;
      },
    };
  }

  return { create: create };
})();
