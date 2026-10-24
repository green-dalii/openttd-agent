/**
 * Benchmark scorecard (D5b) — four orthogonal axes per model.
 *
 * 职责: 把一堆度量行折成**每个模型四张卡**：能力 / 效率 / 稳定性 / 成长。
 * 为什么存在: 单一分数会让"模型 A 更好"这种话无法辩护——A 可能只是更快更便宜，
 *   或者只是更少崩溃。四轴分开，并且**每个数字都带 n 与测量条件**。
 * 铁律:
 *   - 缺失 → `null`（不是 0）。分母为 0 的比率也是 `null`（不是 Infinity）。
 *   - 被排除的局必须**计数并说明原因**（静默丢弃 = 伪造样本量）。
 *   - 不含任何"哪个更好"的评语。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §3；排除口径见 metrics.ts（SPEC §10.101/§10.102）。
 */

import { learningCurve, metricExclusion, type GameMetric } from "./metrics.js";
import { classifyOutcome, type OutcomeClass } from "./outcome.js";

export interface BenchConditions {
	scenario: string | null;
	horizonDays: number | null;
	seeds: number[];
	repeats: number;
}

export interface AbilityAxis {
	runs: number;
	/** Cargo delivered per game day: mean and median over comparable runs. */
	mean: number | null;
	median: number | null;
	/** Mean stations / vehicles at the end (capacity built). */
	stations: number | null;
	vehicles: number | null;
}

export interface EfficiencyAxis {
	deliveredPerMillionTokens: number | null;
	tokensPerDecision: number | null;
	/** Wall-clock seconds per run (mean). */
	secondsPerRun: number | null;
	/** Total money spent (mean cost per run). */
	costPerRun: number | null;
}

export interface StabilityAxis {
	/** Share of tool calls that failed (null when no calls). */
	toolFailureRate: number | null;
	/** Outcome class → count. */
	outcomes: Partial<Record<OutcomeClass, number>>;
	/** GS error replies per run (mean). */
	gsErrorsPerRun: number | null;
}

export interface GrowthAxis {
	verdict: "rising" | "falling" | "not determinable";
	slopePerRun: number | null;
	message: string;
}

export interface ModelCard {
	/** The model that actually served these runs (manifest.servedModel). */
	model: string;
	/**
	 * The model ids that were REQUESTED for these runs. When a gateway answers
	 * with another model, the requested ids pile up here - so the substitution
	 * is visible instead of two "models" being silently merged.
	 */
	requestedModels: string[];
	/** Comparable runs used for the numbers below. */
	runs: number;
	/** Runs left out, with one reason each. */
	excluded: number;
	excludedReasons: string[];
	ability: AbilityAxis;
	efficiency: EfficiencyAxis;
	stability: StabilityAxis;
	growth: GrowthAxis;
}

export interface Scorecard {
	conditions: BenchConditions;
	models: ModelCard[];
}

/** Mean of the finite numbers, or null when there are none. */
function mean(values: Array<number | null | undefined>): number | null {
	const nums = (values ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
	if (nums.length === 0) return null;
	return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(values: Array<number | null | undefined>): number | null {
	const nums = (values ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
	if (nums.length === 0) return null;
	return nums.length % 2 ? nums[(nums.length - 1) / 2]! : (nums[nums.length / 2 - 1]! + nums[nums.length / 2]!) / 2;
}

/** Delivered per game day for one row, or null when either side is unknown. */
function perDay(m: GameMetric): number | null {
	if (typeof m.deliveredRun !== "number" || typeof m.simulatedDays !== "number" || m.simulatedDays <= 0) return null;
	return m.deliveredRun / m.simulatedDays;
}

/**
 * Build the scorecard. Rows are grouped by the model that actually served them
 * (`manifest.servedModel` when present, else the requested `llmModel`) - a
 * gateway answering with another model must not be credited to the request.
 */
export function buildScorecard(
	metrics: GameMetric[],
	opts: { conditions?: BenchConditions } = {},
): Scorecard {
	const rows = (Array.isArray(metrics) ? metrics : []).filter((m) => m && typeof m === "object");
	const byModel = new Map<
		string,
		{ used: GameMetric[]; excluded: string[]; excludedRows: GameMetric[]; requested: Set<string> }
	>();
	for (const m of rows) {
		const model = m.manifest?.servedModel || m.llmModel || "unknown";
		const bucket = byModel.get(model) ?? { used: [], excluded: [], excludedRows: [], requested: new Set<string>() };
		byModel.set(model, bucket);
		if (m.llmModel) bucket.requested.add(m.llmModel);
		const why = metricExclusion(m);
		if (why) {
			bucket.excluded.push(why);
			bucket.excludedRows.push(m);
		} else bucket.used.push(m);
	}

	const models: ModelCard[] = [];
	for (const [model, bucket] of [...byModel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		const used = bucket.used;
		const excludedRows = bucket.excludedRows;
		const days = used.map(perDay);
		const totalTokens = used.map((m) => m.totalTokens);
		const totalDelivered = used.map((m) => m.deliveredRun);
		const tokensSum = totalTokens.filter((t) => Number.isFinite(t)).reduce((a, b) => a + b, 0);
		const deliveredSum = totalDelivered.filter((d): d is number => typeof d === "number").reduce((a, b) => a + b, 0);

		// Outcome counts come from EVERY row of this model (excluded ones too):
		// "how often did it end paused" is a stability fact, not a score fact.
		const outcomes: Partial<Record<OutcomeClass, number>> = {};
		for (const m of used.concat(excludedRows)) {
			const cls = classifyOutcome(m);
			outcomes[cls] = (outcomes[cls] ?? 0) + 1;
		}

		const ability: AbilityAxis = {
			runs: used.length,
			mean: mean(days),
			median: median(days),
			stations: mean(used.map((m) => (typeof m.stations === "number" ? m.stations : null))),
			vehicles: mean(used.map((m) => (typeof m.vehicles === "number" ? m.vehicles : null))),
		};

		const efficiency: EfficiencyAxis = {
			deliveredPerMillionTokens:
				tokensSum > 0 && deliveredSum > 0 ? (deliveredSum / tokensSum) * 1_000_000 : null,
			tokensPerDecision: mean(
				used.map((m) => (m.decisions > 0 ? m.totalTokens / m.decisions : null)),
			),
			secondsPerRun: mean(used.map((m) => (m.durationMs > 0 ? m.durationMs / 1000 : null))),
			// A run whose model has no price table reports 0 for lack of pricing, not
			// because it was free - including it would drag the mean toward a fake
			// $0.00. Such runs are reported separately, never silently averaged in.
			costPerRun: mean(
				used.map((m) => (m.costKnown === false ? null : typeof m.costTotal === "number" ? m.costTotal : null)),
			),
		};

		const calls = used.reduce((a, m) => a + (m.toolCalls || 0), 0);
		const failures = used.reduce((a, m) => a + (m.toolFailures || 0), 0);
		const stability: StabilityAxis = {
			toolFailureRate: calls > 0 ? failures / calls : null,
			outcomes,
			gsErrorsPerRun: mean(used.map((m) => (typeof m.gsErrors === "number" ? m.gsErrors : null))),
		};

		const curve = learningCurve(
			[...used]
				.sort((a, b) => a.startedAt - b.startedAt)
				.map((m, i) => ({ index: i, delivered: perDay(m) ?? 0 }))
				.filter((p) => Number.isFinite(p.delivered)),
		);
		const growth: GrowthAxis = {
			verdict: curve.verdict,
			slopePerRun: curve.slopePerRun,
			message: curve.message,
		};

		models.push({
			model,
			requestedModels: [...bucket.requested].sort(),
			runs: used.length,
			excluded: bucket.excluded.length,
			excludedReasons: bucket.excluded,
			ability,
			efficiency,
			stability,
			growth,
		});
	}

	return { conditions: opts.conditions ?? { scenario: null, horizonDays: null, seeds: [], repeats: 0 }, models };
}
