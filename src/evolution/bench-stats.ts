/**
 * Paired benchmark statistics (D5c) — same-world pairing, **per axis**.
 *
 * 职责: 比较两个模型时**按 (seed, repeat) 配对**，用**差异**做统计；并且**按轴**给结论。
 * 为什么存在: 两个模型跑在同一张地图上时结果相关；不配对就等于把本可消掉的
 *   世界方差又付一遍（而 CV≈1 意味着样本量要翻好几倍）。
 * 为什么"按轴": 旧实现把指标写死成"每游戏日交付"⇒ 次级轴（每 1M token 交付、
 *   工具失败率）**没有配对区间** ⇒ "看起来分得开"永远不是判定（Issue #87）。
 *   而配对只对**逐局能取标量**的轴有意义 ⇒ 成长轴（跨局斜率）不在其中。
 * 铁律:
 *   - 一侧缺失的配对**不计入**（缺一个数不等于"差为 0"）。
 *   - 配对太少 → `not determinable`（不是"无差异"）。
 *   - 报告必须写清用的是配对设计、**哪个轴**、**什么单位**与 n（读者才知道 n 的含义）。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §3（配对统计按轴给结论）；预登记口径见 metrics.ts（SPEC §10.112）。
 */

import type { GameMetric } from "./metrics.js";
import { metricExclusion } from "./metrics.js";
import { DELIVERED_MEASURE, PASSENGER_CARGO_LABEL } from "./scorecard.js";

/** The axes a **per-run scalar** can live on. Growth is not one of them. */
export type PairedAxis = "ability" | "efficiency" | "stability";

/** A metric that can be compared pair by pair. */
export interface PairedMetric {
	/** Stable id (`axis.metric`). The page passes it back; never a display string. */
	id: string;
	/** The axis this metric belongs to. */
	axis: PairedAxis;
	/** The axis's name, in the server's words. */
	axisLabel: string;
	/** What the number counts (the server's wording - one vocabulary, no second copy). */
	label: string;
	/** The unit of the number ("per game day", "per 1M tokens", …). */
	unit: string;
	/**
	 * Which way is better, in the server's words - or null when the metric
	 * carries no quality ("more stations" is not automatically better).
	 *
	 * Why it must be here: the verdict words are **directional** ("a_higher"
	 * means A's number is the bigger one). On the efficiency axis "higher" is
	 * usually *worse* (more seconds, more tokens) ⇒ a reader who assumes
	 * "higher = better" reads the verdict backwards. The direction is a fact
	 * about the metric, so it belongs to the registry, not to the reader.
	 */
	betterWhen: "higher" | "lower" | null;
	/** The per-run value, or null when this run did not measure it. */
	value(m: GameMetric): number | null;
}

function perGameDay(m: GameMetric): number | null {
	if (typeof m.deliveredRun !== "number" || typeof m.simulatedDays !== "number" || m.simulatedDays <= 0) {
		return null;
	}
	return m.deliveredRun / m.simulatedDays;
}

function perMillionTokens(m: GameMetric): number | null {
	if (typeof m.deliveredRun !== "number" || typeof m.totalTokens !== "number" || m.totalTokens <= 0) {
		return null;
	}
	return (m.deliveredRun / m.totalTokens) * 1_000_000;
}

function finite(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The freight axis' own number: cargo delivered (the GS cargo monitor's cargo
 * half) per game day.
 *
 * 为什么单独一条而不是复用主轴: 主轴量的是 **admin 口径**的"货物 + 旅客交付"
 * （`deliveredRun`），而这里量的是 **monitor 口径**的**货物**那一半 ⇒ 两个口径
 * 不可相加、也不可互相替代（见 `scorecard.ts` 的 `splitByCargo`）。
 * 货运轴要问的是一个**更窄**的问题："模型能不能真的自己建起一条会运货的线" ⇒
 * 它的判据只能是货物那一半（monitor 只统计货物，不统计客运 ⇒ 旅客半边**没有**
 * 读数，不能拿"0"冒充）。
 *
 * 缺失 ≠ 0：这一局没有货物拆分读数（monitor 没报 / 早于 F2 的脚手架）⇒ null。
 */
function cargoPerGameDay(m: GameMetric): number | null {
	const split = m.deliveredByCargo;
	if (!Array.isArray(split) || split.length === 0) return null;
	if (typeof m.simulatedDays !== "number" || m.simulatedDays <= 0) return null;
	let cargo = 0;
	for (const c of split) {
		if (c.label === PASSENGER_CARGO_LABEL) continue;
		cargo += c.amount;
	}
	return cargo / m.simulatedDays;
}

/**
 * The registry — the single place that knows which metrics can be paired and
 * what they are called.
 *
 * Why a registry and not a switch inside the comparison: the **wording** (what
 * is counted, in what unit) must exist exactly once, or the report and the
 * page drift apart (the rule this repository keeps hitting).
 */
export const PAIRED_METRICS: PairedMetric[] = [
	{
		id: "ability.deliveredPerGameDay",
		axis: "ability",
		axisLabel: "Result",
		label: DELIVERED_MEASURE,
		unit: "per game day",
		betterWhen: "higher",
		value: perGameDay,
	},
	{
		id: "ability.stations",
		axis: "ability",
		axisLabel: "Result",
		label: "stations",
		unit: "at the end of the run",
		betterWhen: null,
		value: (m) => finite(m.stations),
	},
	{
		id: "ability.vehicles",
		axis: "ability",
		axisLabel: "Result",
		label: "vehicles",
		unit: "at the end of the run",
		betterWhen: null,
		value: (m) => finite(m.vehicles),
	},
	{
		id: "ability.cargoDeliveredPerGameDay",
		axis: "ability",
		axisLabel: "Result",
		label: "cargo delivered",
		unit: "per game day",
		betterWhen: "higher",
		value: cargoPerGameDay,
	},
	{
		id: "efficiency.deliveredPerMillionTokens",
		axis: "efficiency",
		axisLabel: "Efficiency",
		label: DELIVERED_MEASURE,
		unit: "per 1M tokens",
		betterWhen: "higher",
		value: perMillionTokens,
	},
	{
		id: "efficiency.tokensPerDecision",
		axis: "efficiency",
		axisLabel: "Efficiency",
		label: "tokens",
		unit: "per decision",
		betterWhen: "lower",
		value: (m) => (m.decisions > 0 ? finite(m.totalTokens / m.decisions) : null),
	},
	{
		id: "efficiency.secondsPerRun",
		axis: "efficiency",
		axisLabel: "Efficiency",
		label: "wall clock",
		unit: "seconds per run",
		betterWhen: "lower",
		value: (m) => (m.durationMs > 0 ? m.durationMs / 1000 : null),
	},
	{
		id: "stability.toolFailureRate",
		axis: "stability",
		axisLabel: "Reliability",
		label: "tool calls that failed",
		unit: "share of tool calls",
		betterWhen: "lower",
		value: (m) => (m.toolCalls > 0 ? finite(m.toolFailures / m.toolCalls) : null),
	},
	{
		id: "stability.gsErrorsPerRun",
		axis: "stability",
		axisLabel: "Reliability",
		label: "game script errors",
		unit: "per run",
		betterWhen: "lower",
		value: (m) => finite(m.gsErrors),
	},
];

/** The metric the comparison uses when the caller does not pick one. */
export const DEFAULT_PAIRED_METRIC = "ability.deliveredPerGameDay";

/** Look up a metric by id. An unknown id is an error, never a silent fallback. */
export function pairedMetric(id: string): PairedMetric {
	const found = PAIRED_METRICS.find((m) => m.id === id);
	if (!found) {
		throw new Error(
			`unknown paired metric "${id}" (known: ${PAIRED_METRICS.map((m) => m.id).join(", ")})`,
		);
	}
	return found;
}

export interface PairPoint {
	seed: number;
	repeat: number;
	/** the metric's value for each side of the pair. */
	a: number;
	b: number;
	/** a - b (positive = model A is higher on this metric). */
	diff: number;
}

export interface PairedComparison {
	design: "paired";
	/** Which metric was compared (`axis.metric`). */
	metricId: string;
	/** The axis's name. */
	axisLabel: string;
	/** What the number counts. */
	label: string;
	/** The unit of the number. */
	unit: string;
	/** Which way is better on this metric (null when the metric carries no quality). */
	betterWhen: "higher" | "lower" | null;
	modelA: string;
	modelB: string;
	pairs: PairPoint[];
	/** Mean of the per-pair differences (null when no pair is usable). */
	meanDiff: number | null;
	/** Deterministic bootstrap CI of the mean difference (null when too few pairs). */
	diffCi95: [number, number] | null;
	verdict: "a_higher" | "b_higher" | "not determinable";
	/**
	 * The model that came out **better** on this metric (null when the verdict
	 * does not decide, or when the metric carries no quality).
	 *
	 * The verdict word is a **direction** ("a_higher" = A's number is the
	 * bigger one). On the efficiency axis the bigger number is the *worse* one
	 * ⇒ the page must not guess which model "won"; the server says it here.
	 */
	betterModel: string | null;
	message: string;
}

/** Deterministic LCG: a CI must not change between two runs on the same data. */
function lcg(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
}

/**
 * Group comparable rows of one model by their (seed, repeat) cell.
 *
 * The repeat index is not stored on the metric row; the start order within a
 * seed is the only available proxy, so repeated runs of the same seed pair in
 * the order they were started.
 *
 * **The cells are the runs, not the measurements**: the slot index is counted
 * over the *comparable* rows, so the same (seed, repeat) cell means the same
 * pair of runs on **every** axis. (Counting the slots over the rows that have
 * a value instead would re-shuffle the pairing when one run has no reading
 * for one metric — A's run 2 would then be compared with B's run 1.)
 */
function cellMap(rows: GameMetric[]): Map<string, GameMetric> {
	const out = new Map<string, GameMetric>();
	for (const m of rows) {
		if (metricExclusion(m)) continue;
		const key = `${m.seed}`;
		// Multiple rows per seed: keep them as separate slots.
		let i = 0;
		while (out.has(`${key}#${i}`)) i++;
		out.set(`${key}#${i}`, m);
	}
	return out;
}

/**
 * Compare model A and model B on the same worlds, on one metric.
 *
 * The pairing key is (seed, occurrence index within that seed) because the
 * metric row does not carry an explicit repeat number.
 *
 * `metricId` defaults to the main axis (delivered per game day) so the old
 * callers keep their behaviour.
 */
export function pairedComparison(
	metrics: GameMetric[],
	modelA: string,
	modelB: string,
	metricId: string = DEFAULT_PAIRED_METRIC,
): PairedComparison {
	const metric = pairedMetric(metricId);
	const rows = (Array.isArray(metrics) ? metrics : []).filter((m) => m && typeof m === "object");
	const modelOf = (m: GameMetric): string => m.manifest?.servedModel || m.llmModel || "unknown";
	const a = cellMap(rows.filter((m) => modelOf(m) === modelA));
	const b = cellMap(rows.filter((m) => modelOf(m) === modelB));

	const pairs: PairPoint[] = [];
	for (const [key, rowA] of a) {
		const rowB = b.get(key);
		if (rowB === undefined) continue; // one side missing: not a zero difference
		const va = metric.value(rowA);
		const vb = metric.value(rowB);
		// A cell nobody measured on one side is not a difference of zero.
		if (va === null || vb === null) continue;
		const [seedText, idxText] = key.split("#");
		pairs.push({
			seed: Number(seedText),
			repeat: Number(idxText) + 1,
			a: va,
			b: vb,
			diff: va - vb,
		});
	}
	pairs.sort((p, q) => p.seed - q.seed || p.repeat - q.repeat);

	const base = {
		design: "paired" as const,
		metricId: metric.id,
		axisLabel: metric.axisLabel,
		label: metric.label,
		unit: metric.unit,
		betterWhen: metric.betterWhen,
		modelA,
		modelB,
		pairs,
	};
	/**
	 * Which model came out better, given the verdict's direction and the
	 * metric's quality direction. Null when the verdict does not decide or
	 * when the metric carries no quality.
	 */
	const better = (verdict: "a_higher" | "b_higher" | "not determinable"): string | null => {
		if (verdict === "not determinable") return null;
		if (metric.betterWhen === null) return null;
		const higher = verdict === "a_higher" ? modelA : modelB;
		const lower = verdict === "a_higher" ? modelB : modelA;
		return metric.betterWhen === "higher" ? higher : lower;
	};
	if (pairs.length === 0) {
		return {
			...base,
			meanDiff: null,
			diffCi95: null,
			verdict: "not determinable",
			betterModel: null,
			message:
				`no usable pair: ${modelA} and ${modelB} share no (seed, repeat) cell with a measured ` +
				`${metric.label} (${metric.unit})`,
		};
	}
	const diffs = pairs.map((p) => p.diff);
	const meanDiff = diffs.reduce((x, y) => x + y, 0) / diffs.length;

	// Fewer than 3 pairs: a CI would be an artefact of the sample size.
	let ci: [number, number] | null = null;
	if (pairs.length >= 3) {
		const rnd = lcg(20261023);
		const B = 1000;
		const boots: number[] = [];
		for (let k = 0; k < B; k++) {
			let sum = 0;
			for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(rnd() * diffs.length)]!;
			boots.push(sum / diffs.length);
		}
		boots.sort((x, y) => x - y);
		ci = [boots[Math.floor(boots.length * 0.025)]!, boots[Math.floor(boots.length * 0.975)]!];
	}

	const what = `${metric.label} (${metric.unit})`;
	if (ci === null) {
		return {
			...base,
			meanDiff,
			diffCi95: null,
			verdict: "not determinable",
			betterModel: null,
			message: `only ${pairs.length} usable pair(s) for ${what} - a paired interval needs >= 3`,
		};
	}
	if (ci[0] > 0) {
		return {
			...base,
			meanDiff,
			diffCi95: ci,
			verdict: "a_higher",
			betterModel: better("a_higher"),
			message:
				`paired mean difference ${meanDiff.toFixed(3)} ${what}, 95% CI ` +
				`[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] excludes 0 (n=${pairs.length} pairs)`,
		};
	}
	if (ci[1] < 0) {
		return {
			...base,
			meanDiff,
			diffCi95: ci,
			verdict: "b_higher",
			betterModel: better("b_higher"),
			message:
				`paired mean difference ${meanDiff.toFixed(3)} ${what}, 95% CI ` +
				`[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] excludes 0 (n=${pairs.length} pairs)`,
		};
	}
	return {
		...base,
		meanDiff,
		diffCi95: ci,
		verdict: "not determinable",
		betterModel: null,
		message:
			`paired mean difference ${meanDiff.toFixed(3)} ${what}, 95% CI ` +
			`[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] includes 0 - this design cannot decide ` +
			`(n=${pairs.length} pairs)`,
	};
}

/**
 * Compare on **every** metric in the registry (the axes a per-run scalar can
 * live on). The order is the registry's, so the report and the page list the
 * axes the same way.
 */
export function pairedComparisons(
	metrics: GameMetric[],
	modelA: string,
	modelB: string,
): PairedComparison[] {
	return PAIRED_METRICS.map((m) => pairedComparison(metrics, modelA, modelB, m.id));
}
