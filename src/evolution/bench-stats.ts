/**
 * Paired benchmark statistics (D5c) — same-world pairing.
 *
 * 职责: 比较两个模型时**按 (seed, repeat) 配对**，用**差异**做统计。
 * 为什么存在: 两个模型跑在同一张地图上时结果相关；不配对就等于把本可消掉的
 *   世界方差又付一遍（而 CV≈1 意味着样本量要翻好几倍）。
 * 铁律:
 *   - 一侧缺失的配对**不计入**（缺一个数不等于"差为 0"）。
 *   - 配对太少 → `not determinable`（不是"无差异"）。
 *   - 报告必须写清用的是配对设计（读者才知道 n 的含义）。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §3；预登记口径见 metrics.ts（SPEC §10.112）。
 */

import type { GameMetric } from "./metrics.js";
import { metricExclusion } from "./metrics.js";

export interface PairPoint {
	seed: number;
	repeat: number;
	/** delivered per game day for each side of the pair. */
	a: number;
	b: number;
	/** a - b (positive = model A delivered more per game day). */
	diff: number;
}

export interface PairedComparison {
	design: "paired";
	modelA: string;
	modelB: string;
	pairs: PairPoint[];
	/** Mean of the per-pair differences (null when no pair is usable). */
	meanDiff: number | null;
	/** Deterministic bootstrap CI of the mean difference (null when too few pairs). */
	diffCi95: [number, number] | null;
	verdict: "a_higher" | "b_higher" | "not determinable";
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

function perDay(m: GameMetric): number | null {
	if (typeof m.deliveredRun !== "number" || typeof m.simulatedDays !== "number" || m.simulatedDays <= 0) return null;
	return m.deliveredRun / m.simulatedDays;
}

/** Group comparable rows of one model by their (seed, repeat) cell. */
function cellMap(rows: GameMetric[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const m of rows) {
		if (metricExclusion(m)) continue;
		const v = perDay(m);
		if (v === null) continue;
		// The repeat index is not stored on the metric row; the start order within
		// a seed is the only available proxy, so repeated runs of the same seed
		// pair in the order they were started.
		const key = `${m.seed}`;
		// Multiple rows per seed: keep them as separate slots.
		let i = 0;
		while (out.has(`${key}#${i}`)) i++;
		out.set(`${key}#${i}`, v);
	}
	return out;
}

/**
 * Compare model A and model B on the same worlds.
 *
 * The pairing key is (seed, occurrence index within that seed) because the
 * metric row does not carry an explicit repeat number.
 */
export function pairedComparison(metrics: GameMetric[], modelA: string, modelB: string): PairedComparison {
	const rows = (Array.isArray(metrics) ? metrics : []).filter((m) => m && typeof m === "object");
	const modelOf = (m: GameMetric): string => m.manifest?.servedModel || m.llmModel || "unknown";
	const a = cellMap(rows.filter((m) => modelOf(m) === modelA));
	const b = cellMap(rows.filter((m) => modelOf(m) === modelB));

	const pairs: PairPoint[] = [];
	for (const [key, va] of a) {
		const vb = b.get(key);
		if (vb === undefined) continue; // one side missing: not a zero difference
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

	const base = { design: "paired" as const, modelA, modelB, pairs };
	if (pairs.length === 0) {
		return {
			...base,
			meanDiff: null,
			diffCi95: null,
			verdict: "not determinable",
			message: `no usable pair: ${modelA} and ${modelB} share no (seed, repeat) cell with a measured outcome`,
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

	if (ci === null) {
		return {
			...base,
			meanDiff,
			diffCi95: null,
			verdict: "not determinable",
			message: `only ${pairs.length} usable pair(s) - a paired interval needs >= 3`,
		};
	}
	if (ci[0] > 0) {
		return {
			...base,
			meanDiff,
			diffCi95: ci,
			verdict: "a_higher",
			message: `paired mean difference ${meanDiff.toFixed(3)} per game day, 95% CI [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] excludes 0 (n=${pairs.length} pairs)`,
		};
	}
	if (ci[1] < 0) {
		return {
			...base,
			meanDiff,
			diffCi95: ci,
			verdict: "b_higher",
			message: `paired mean difference ${meanDiff.toFixed(3)} per game day, 95% CI [${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] excludes 0 (n=${pairs.length} pairs)`,
		};
	}
	return {
		...base,
		meanDiff,
		diffCi95: ci,
		verdict: "not determinable",
		message:
			`paired mean difference ${meanDiff.toFixed(3)} per game day, 95% CI ` +
			`[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}] includes 0 - this design cannot decide (n=${pairs.length} pairs)`,
	};
}
