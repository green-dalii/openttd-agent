/**
 * Evolution metrics — the cross-game ledger (SPEC §5.2 #3).
 *
 * 职责: 把每局结束时的 `SessionMeta` 投影成**可跨局比较**的一条指标记录，
 *   并提供按 seed 分组、按"是否注入记忆"分臂的对照统计。纯函数，无 IO。
 *
 * 为什么先做这一层（SPEC §5.2）: 三机制里 lessons/策略都建立在"能度量"之上。
 *   没有跨局指标，就无法回答"注入 lessons 到底有没有用"，反思与蒸馏会退化成
 *   自我感觉良好。所以 metrics 是进化闭环的前置条件。
 *
 * 为什么必须记录 `memory` 字段: SPEC §5.2 #3 的对照实验是「同 seed，有无 lessons」。
 *   **自变量不记录，实验就不成立** —— 那只是把两个数字并排放着。因此每局都记下
 *   本局实际注入了多少 lessons/策略。
 *
 * 事实来源: SPEC §5.2（三机制）、§5.3（收敛防抖：限量/阈值/禁止臆测因果）、
 *   §7 #4（跨局指标对比）。
 * 禁止:
 *   - 在此做 IO（落盘见 store.ts）。
 *   - **推断因果**（SPEC §5.3 明确禁止）：本文件只做统计量与差值，
 *     措辞上不得声称"因为注入了 lessons 所以更好"。
 */

import type { SessionMeta } from "../agent/session-store.js";

/** Injectable subset for tests and callers that do not have the store handy. */
export interface SessionMetaLike {
	id: string;
	mode: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	seed: number;
	appVersion?: string;
	llm?: { providerId?: string; model?: string; kind?: string };
	outcome?: {
		constructionDone?: boolean;
		money?: string | number;
		vehicles?: number;
		stations?: number;
	};
	totals?: {
		decisions?: number;
		toolCalls?: number;
		toolFailures?: number;
		usage?: { totalTokens?: number; costTotal?: number };
	};
}

/** One finished (or abandoned) game, flattened for comparison. */
export interface GameMetric {
	id: string;
	seed: number;
	mode: string;
	status: string;
	startedAt: number;
	durationMs: number;
	appVersion: string;
	/** "real" | "faux" | "" — faux runs are excluded from comparisons. */
	llmKind: string;
	llmModel: string;
	constructionDone: boolean | null;
	money: number;
	vehicles: number;
	stations: number;
	decisions: number;
	toolCalls: number;
	toolFailures: number;
	totalTokens: number;
	costTotal: number;
	/** Facts injected from route-facts.jsonl (C-1) - counts toward treatment. */
	routeFactsInjected?: number;
	/** The experiment's independent variable: what memory was injected. */
	memory: { lessonsInjected: number; strategiesInjected: number; routeFactsInjected: number };
}

/** Minimum runs per arm before a difference is worth reporting (SPEC §5.3). */
export const MIN_LESSON_SAMPLE = 3;

function num(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}

/**
 * Project a finished session into a ledger entry.
 *
 * `memory` records what was actually injected; callers that did not inject
 * anything get zeros, which is the honest default (and the control arm).
 */
export function toGameMetric(
	meta: SessionMetaLike | SessionMeta,
	memory?: { lessonsInjected?: number; strategiesInjected?: number; routeFactsInjected?: number },
): GameMetric {
	const o = (meta.outcome ?? {}) as SessionMetaLike["outcome"];
	const t = (meta.totals ?? {}) as SessionMetaLike["totals"];
	const u = (t && t.usage) || {};
	// An unfinished run has no honest duration; 0 beats a huge bogus number.
	const durationMs =
		typeof meta.endedAt === "number" && meta.endedAt >= meta.startedAt
			? meta.endedAt - meta.startedAt
			: 0;
	return {
		id: String(meta.id),
		seed: num(meta.seed),
		mode: String(meta.mode),
		status: String(meta.status),
		startedAt: num(meta.startedAt),
		durationMs,
		appVersion: String(meta.appVersion ?? ""),
		llmKind: String((meta.llm && meta.llm.kind) ?? ""),
		llmModel: String((meta.llm && meta.llm.model) ?? ""),
		// Unknown is null, never false: "we don't know" and "it failed" differ.
		constructionDone:
			o && o.constructionDone === true ? true : o && o.constructionDone === false ? false : null,
		money: num(o && o.money),
		vehicles: num(o && o.vehicles),
		stations: num(o && o.stations),
		decisions: num(t && t.decisions),
		toolCalls: num(t && t.toolCalls),
		toolFailures: num(t && t.toolFailures),
		totalTokens: num(u.totalTokens),
		costTotal: num(u.costTotal),
		memory: {
			lessonsInjected: num(memory && memory.lessonsInjected),
			strategiesInjected: num(memory && memory.strategiesInjected),
			routeFactsInjected: num(memory && memory.routeFactsInjected),
		},
	};
}

export interface MetricSummary {
	count: number;
	completed: number;
	/** Share of runs with a known outcome that reached construction-done. */
	builtRate: number | null;
	totalTokens: number;
	costTotal: number;
}

/** Roll a set of runs up into headline numbers. */
export function summarise(metrics: GameMetric[]): MetricSummary {
	const list = metrics ?? [];
	const completed = list.filter((m) => m.status === "completed").length;
	const known = list.filter((m) => m.constructionDone !== null);
	const built = known.filter((m) => m.constructionDone === true).length;
	return {
		count: list.length,
		completed,
		builtRate: known.length ? built / known.length : null,
		totalTokens: list.reduce((a, m) => a + m.totalTokens, 0),
		costTotal: list.reduce((a, m) => a + m.costTotal, 0),
	};
}

/**
 * Group by seed. Same-seed runs are the only fair comparison, because a different
 * map changes the difficulty (SPEC §5.2 #3).
 */
export function groupBySeed(metrics: GameMetric[]): Record<string, GameMetric[]> {
	const out: Record<string, GameMetric[]> = {};
	for (const m of metrics ?? []) {
		const k = String(m.seed);
		(out[k] = out[k] ?? []).push(m);
	}
	return out;
}

export interface ArmStats {
	count: number;
	meanMoney: number | null;
	meanTokens: number | null;
	/**
	 * Tokens per DECISION (C-3, SPEC §10.43): raw meanTokens is confounded by
	 * how much the arm happened to ACT - a run that ordered 4 routes costs more
	 * tokens than one that ordered 0, with or without memory. Normalize before
	 * comparing "memory costs tokens".
	 */
	tokensPerDecision: number | null;
	builtRate: number | null;
}

export interface ArmComparison {
	withLessons: ArmStats;
	withoutLessons: ArmStats;
	/** Right arm minus left arm, or null when either side is empty. */
	moneyDelta: number | null;
	/** True only when BOTH arms have MIN_LESSON_SAMPLE runs AND the arms are comparable. */
	conclusive: boolean;
	/**
	 * True when the two arms finished at different stages, which makes money
	 * uninterpretable. See `compareArms` for the measurement behind this.
	 */
	confounded: boolean;
	/** Human-readable caveat; always set when `conclusive` is false. */
	note: string;
}

/** Mean of a field, or null for an empty list. */
function mean(values: number[]): number | null {
	if (!values.length) return null;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function armStats(list: GameMetric[]): ArmStats {
	const known = list.filter((m) => m.constructionDone !== null);
	const acting = list.filter((m) => m.decisions > 0);
	return {
		count: list.length,
		meanMoney: mean(list.map((m) => m.money)),
		meanTokens: mean(list.map((m) => m.totalTokens)),
		tokensPerDecision: acting.length
			? mean(acting.map((m) => m.totalTokens / m.decisions))
			: null,
		builtRate: known.length
			? known.filter((m) => m.constructionDone === true).length / known.length
			: null,
	};
}

/**
 * Compare the two arms of SPEC §5.2 #3: runs with lessons injected versus without.
 *
 * Scripted (`faux`) runs are dropped: they execute a fixed plan, so they say
 * nothing about whether the model did better with memory.
 *
 * Deliberately refuses to call a difference "conclusive" below
 * `MIN_LESSON_SAMPLE` per arm — SPEC §5.3 forbids speculative conclusions, and a
 * 1-vs-1 comparison is noise.
 */
export function compareArms(metrics: GameMetric[]): ArmComparison {
	// Two exclusions, for two different reasons.
	//
	// 1. `faux` (scripted) runs execute a fixed plan, so they say nothing about
	//    whether the model did better with memory.
	//
	// 2. `interrupted` runs (2026-09-12) were killed before they finished. Their
	//    outcome measures the operator pressing Ctrl-C, not the agent's skill, so
	//    comparing them with completed runs compares incomparable things
	//    (MEMORY.md A2). This is not hypothetical: the first five real runs in the
	//    ledger were all `interrupted` with money/vehicles/stations at 0 - left
	//    over from the era when the game was silently frozen. Counting them as
	//    "without-lessons" votes would drag that arm's mean to zero and manufacture
	//    a "memory makes you better" result out of a bug.
	const all = metrics ?? [];
	const scripted = all.filter((m) => m.llmKind === "faux").length;
	const interrupted = all.filter((m) => m.llmKind !== "faux" && m.status === "interrupted").length;
	const real = all.filter((m) => m.llmKind !== "faux" && m.status !== "interrupted");
	// Treatment arm = ANY injected memory: lessons OR route facts (C-1). The
	// m3e run exposed the gap: runs that received facts-but-no-lessons were
	// being scored as controls, splitting the arms by an accounting bug.
	const withLessons = real.filter(
		(m) => m.memory.lessonsInjected > 0 || (m.memory.routeFactsInjected ?? 0) > 0,
	);
	// Control arm = received NOTHING (neither lessons nor facts). Using only
	// lessonsInjected here put facts-only runs in BOTH arms (m3e).
	const withoutLessons = real.filter(
		(m) => m.memory.lessonsInjected === 0 && (m.memory.routeFactsInjected ?? 0) === 0,
	);
	const a = armStats(withLessons);
	const b = armStats(withoutLessons);

	const enough = a.count >= MIN_LESSON_SAMPLE && b.count >= MIN_LESSON_SAMPLE;
	const moneyDelta =
		a.meanMoney === null || b.meanMoney === null ? null : a.meanMoney - b.meanMoney;

	// Money is only comparable if both arms got equally far. A run that never
	// finished construction has spent nothing on vehicles or route, so its money
	// is HIGHER precisely BECAUSE it failed. "More money" means "built less".
	//
	// Measured 2026-09-12 (SPEC §10.34): across six runs, the single run that
	// finished construction had the LOWEST money, and this function reported a
	// confident +6342 for the arm that built NOTHING (builtRate 0.00 vs 0.33).
	// The number was real and its sign meant the opposite of what it looked like.
	// This is MEMORY.md A2 (never compare incomparable things) one level down: the
	// existing exclusions catch runs that never finished, not arms that differ.
	const buildGap =
		a.builtRate === null || b.builtRate === null ? 0 : Math.abs(a.builtRate - b.builtRate);
	const confounded = buildGap >= BUILD_RATE_GAP;

	let note = "";
	if (!enough) {
		const missing = [
			a.count < MIN_LESSON_SAMPLE ? `${MIN_LESSON_SAMPLE - a.count} more with-lessons run(s)` : "",
			b.count < MIN_LESSON_SAMPLE
				? `${MIN_LESSON_SAMPLE - b.count} more without-lessons run(s)`
				: "",
		].filter(Boolean);
		// Not a verdict, just what is missing.
		note = `Not enough runs to compare: need ${missing.join(" and ")}.`;
		if (!real.length) {
			note = "No real (non-scripted) runs recorded yet.";
			if (interrupted > 0) {
				// Say WHY nothing is comparable, rather than implying no game was
				// ever played. Silently dropping rows is how a ledger stops being
				// trustworthy.
				note = `No comparable runs: ${interrupted} real run(s) were interrupted before ` +
					`finishing and are excluded (their outcome is the operator stopping them, ` +
					`not the agent's result).`;
			}
		}
	}

	// Always disclose what was excluded - silent filtering is how a comparison
	// starts lying. This applies whether or not there is enough data to compare:
	// "need 3 more runs" is misleading if two runs were quietly dropped.
	const parts: string[] = [];
	if (interrupted > 0) parts.push(`${interrupted} interrupted`);
	if (scripted > 0) parts.push(`${scripted} scripted`);

	const compared =
		`Compared ${a.count} with-lessons vs ${b.count} without-lessons run(s)`;

	// The exclusion clause is ALWAYS present when something was dropped, whatever
	// else the note says. An earlier version let a "need 3 more runs" note replace
	// it, which re-hid the very thing the disclosure exists to reveal.
	const excluded = parts.length ? ` Excluded ${parts.join(" and ")}.` : "";
	// Token attribution guard (C-3, SPEC §10.43): raw meanTokens差 can be pure
	// action-count confounding. When per-decision costs match, say so, so a
	// "memory doubled tokens" claim cannot rest on the arms acting differently.
	let tokenNote = "";
	if (
		a.tokensPerDecision !== null && b.tokensPerDecision !== null &&
		a.meanTokens !== null && b.meanTokens !== null
	) {
		const perDecisionGap = Math.abs(a.tokensPerDecision - b.tokensPerDecision) /
			Math.max(a.tokensPerDecision, b.tokensPerDecision);
		const meanGap = Math.abs(a.meanTokens - b.meanTokens) / Math.max(a.meanTokens, b.meanTokens);
		if (meanGap > 0.25 && perDecisionGap <= 0.15) {
			tokenNote =
				` Token means differ (${Math.round(a.meanTokens)} vs ${Math.round(b.meanTokens)}) ` +
				`but per-decision cost is the same (${Math.round(a.tokensPerDecision)} vs ` +
				`${Math.round(b.tokensPerDecision)}) - the gap is how much each arm ACTED, ` +
				`not a memory cost.`;
		}
	}
	const body = note ? `${note}${excluded}` : `${compared}.${excluded}${tokenNote}`;

	// A confounded comparison leads with the warning, but still discloses
	// exclusions: "+6342" must never be readable without the sentence that says
	// its sign means the opposite.
	const confoundNote =
		`${compared}, but they are NOT comparable: the arms finished construction ` +
		`at different rates (${fmtRate(a.builtRate)} vs ${fmtRate(b.builtRate)}). ` +
		`A run that never built spends nothing, so its money is higher BECAUSE it ` +
		`failed - the money delta above is not a benefit.`;

	return {
		withLessons: a,
		withoutLessons: b,
		moneyDelta,
		confounded,
		conclusive: enough && !confounded,
		note: confounded ? `${confoundNote}${excluded}` : body,
	};
}

/** Below this built-rate gap the arms are treated as having reached the same stage. */
const BUILD_RATE_GAP = 1 / 3;

/** Render a built rate for a human, including the unknown case. */
function fmtRate(r: number | null): string {
	return r === null ? "unknown" : `${Math.round(r * 100)}%`;
}
