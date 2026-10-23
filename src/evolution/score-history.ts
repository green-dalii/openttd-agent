/**
 * Cross-game score facts (S5) — the agent's own measured scores in past games.
 *
 * 职责: 把"我历局考了多少"变成**可注入的事实**（数字 + 测量条件）。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §4 的 S5；计分口径见 SPEC.md §10.65。
 * 为什么存在: 记忆里注入的是 lesson 文本（"某次发生了什么"），但没有**成绩**——
 *   于是模型无法知道自己是在变好还是变坏（ROADMAP 对齐检查表第 10 行长期未修）。
 * 禁止: 在此给出评价（"上次比这次好"是评价，"上次 1.2/游戏日"是事实）。
 * 铁律: 只收**可比**的局（同场景同 horizon 且未被排除），被排除的局必须**报出来**
 *   而不是静默丢弃；缺失读数保持 null（D60）。
 */

import type { GameMetric } from "./metrics.js";
import { metricExclusion } from "./metrics.js";

/** One past run's measured score. */
export interface PastRunScore {
	seed: number;
	/** Cargo delivered per game day (null when the run has no measured reading). */
	deliveredPerGameDay: number | null;
	/** The run's horizon in game days (null = the run had no horizon). */
	horizonDays: number | null;
	/** Simulated days the run actually covered (null = not reported). */
	simulatedDays: number | null;
}

/** The comparable history plus the conditions it was collected under. */
export interface ScoreHistory {
	runs: PastRunScore[];
	/** How many earlier runs were left out. */
	excluded: number;
	/** One entry per excluded run, naming the reason. */
	excludedReasons: string[];
	/** The conditions every listed run shares with the current one. */
	conditions: { scenario: string | null; horizonDays: number | null };
}

export interface PastRunOptions {
	/** The current run's scenario; only runs with the same one are comparable. */
	scenario: string | null;
	/** The current run's horizon; only runs with the same one are comparable. */
	horizonDays: number | null;
	/** Ignore rows started at/after this timestamp (the current run's own row). */
	sinceMs?: number;
	/** How many past runs to list at most (newest first). */
	limit?: number;
}

/**
 * Collect the comparable past scores.
 *
 * Comparable means: same scenario, same horizon, and not excluded by
 * `metricExclusion` (a run stopped by a pause or a frozen world did not fail to
 * learn - it was stopped; SPEC 10.101/10.102).
 */
export function pastRunScores(metrics: GameMetric[], opts: PastRunOptions): ScoreHistory {
	const rows = (Array.isArray(metrics) ? metrics : []).filter((m) => m && typeof m === "object");
	const excludedReasons: string[] = [];
	const picked: GameMetric[] = [];
	for (const m of rows) {
		if (opts.sinceMs !== undefined && m.startedAt >= opts.sinceMs) continue; // the current run
		const exclusion = metricExclusion(m);
		if (exclusion) {
			excludedReasons.push(exclusion);
			continue;
		}
		const sameScenario = (m.scenario ?? null) === (opts.scenario ?? null);
		const sameHorizon = (m.horizonDays ?? null) === (opts.horizonDays ?? null);
		if (!sameScenario || !sameHorizon) {
			excludedReasons.push("different scenario or horizon");
			continue;
		}
		picked.push(m);
	}
	picked.sort((a, b) => b.startedAt - a.startedAt);
	const limited = opts.limit !== undefined ? picked.slice(0, opts.limit) : picked;
	const runs: PastRunScore[] = limited.map((m) => ({
		seed: m.seed,
		deliveredPerGameDay:
			typeof m.deliveredRun === "number" && typeof m.simulatedDays === "number" && m.simulatedDays > 0
				? Math.round((m.deliveredRun / m.simulatedDays) * 10000) / 10000
				: null,
		horizonDays: m.horizonDays ?? null,
		simulatedDays: m.simulatedDays ?? null,
	}));
	return {
		runs,
		excluded: excludedReasons.length,
		excludedReasons,
		conditions: { scenario: opts.scenario ?? null, horizonDays: opts.horizonDays ?? null },
	};
}

/**
 * Render the history as the fact block injected into the model's context.
 *
 * Returns null when there is nothing comparable to report — an empty block
 * would look like "you scored nothing before", which is a different claim.
 */
export function renderScoreHistory(history: ScoreHistory): string | null {
	if (history.runs.length === 0) return null;
	const lines = history.runs.map(
		(r) =>
			`- seed ${r.seed}: ${r.deliveredPerGameDay === null ? "no measured rate" : `${r.deliveredPerGameDay} cargo per game day`}` +
			` (horizon ${r.horizonDays ?? "none"} game days, ${r.simulatedDays ?? "?"} days measured)`,
	);
	const conditions =
		`Measurement conditions: scenario=${history.conditions.scenario ?? "freeform"}, ` +
		`horizon=${history.conditions.horizonDays ?? "none"} game days`;
	const excluded =
		history.excluded > 0
			? ` ${history.excluded} earlier run(s) are not comparable and are not listed (${[...new Set(history.excludedReasons)].join("; ")}).`
			: "";
	return (
		"Your own measured scores in earlier comparable games (cargo delivered per game day):\n" +
		`${lines.join("\n")}\n${conditions}.${excluded}`
	);
}
