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
import { classifyOutcome, describeOutcome, type OutcomeClass, type OutcomeClassCount } from "./outcome.js";

export interface BenchConditions {
	scenario: string | null;
	horizonDays: number | null;
	seeds: number[];
	repeats: number;
}

/**
 * What "delivered" counts, in the **server's** words.
 *
 * 为什么不能写 "cargo"：admin 的 `company_economy.deliveredCargo` 是
 * `cur_economy.delivered_cargo` 这个**按货种的数组**的求和，而 OpenTTD 把客运
 * （CT_PASSENGERS）也记进同一个数组（`src/economy.cpp` 的
 * `cur_economy.delivered_cargo[cargo_type] += accepted_total`）。
 * 所以这个数**已经同时计入货物与客运**——旧标签写 "cargo" 是在说谎。
 *
 * 页面照抄这句话，不自己另写一份措辞（一份词表 ⇒ 一处漂移）。
 */
export const DELIVERED_MEASURE = "cargo + passengers delivered";

/**
 * The passenger label the GS reports (OpenTTD's cargo label for CT_PASSENGERS).
 */
export const PASSENGER_CARGO_LABEL = "PASS";

export interface AbilityAxis {
	runs: number;
	/** What the delivery numbers count (server's wording; see DELIVERED_MEASURE). */
	measure: string;
	/**
	 * The split, in the **monitor measure** (what the GS's cargo monitor saw
	 * unloaded at the monitored towns/industries - not the admin's accepted
	 * counter, so the two must not be added together).
	 *
	 * null = **not measured** (the GS never reported a split - every run before
	 * the monitor accumulation was fixed). "0" would be a different claim.
	 */
	cargoDelivered: number | null;
	passengersDelivered: number | null;
	/** The split's own wording (so the page does not write a second one). */
	splitMeasure: string;
	/** Cargo + passengers delivered per game day: mean and median over comparable runs. */
	mean: number | null;
	median: number | null;
	/** Mean stations / vehicles at the end (capacity built). */
	stations: number | null;
	vehicles: number | null;
}

export interface EfficiencyAxis {
	/** What the delivery numbers count (server's wording; see DELIVERED_MEASURE). */
	measure: string;
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
	/**
	 * The same counts, with the **server's** names and meanings (B5).
	 *
	 * 为什么多一份：页面不该自己写一份"这个结果意味着什么"的词表（那是两份实现，
	 * 迟早漂移）。`outcomes` 是**事实**（计数），这份是**投影**（给页面照抄）。
	 */
	outcomeDistribution: OutcomeClassCount[];
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
/** How the split is measured, in the server's words. */
export const SPLIT_MEASURE = "delivered to monitored towns/industries, by cargo type";

/**
 * Split the deliveries of the comparable runs into cargo and passengers.
 *
 * 两家口径：**monitor**（GS 的 cargo monitor：卸到被监视的城镇/产业的量，自己累加）
 * 与 **admin**（被接受量）不是一回事 ⇒ 只在这里分开报，**不与主轴相加**。
 * 只有当**每一局**都有拆分时才给数；否则 null（"没测到"），不是 0。
 */
export function splitByCargo(rows: GameMetric[]): { cargo: number | null; passengers: number | null } {
	let cargo = 0;
	let passengers = 0;
	let seen = 0;
	for (const m of rows) {
		const split = m.deliveredByCargo;
		if (!Array.isArray(split) || split.length === 0) continue;
		seen += 1;
		for (const c of split) {
			if (c.label === PASSENGER_CARGO_LABEL) passengers += c.amount;
			else cargo += c.amount;
		}
	}
	if (seen === 0 || seen < rows.length) return { cargo: null, passengers: null };
	return { cargo, passengers };
}

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

		// 按货种的拆分（monitor 口径）：货物与客运分列；**没拆分到就是 null**。
		const split = splitByCargo(used);
		const ability: AbilityAxis = {
			runs: used.length,
			measure: DELIVERED_MEASURE,
			cargoDelivered: split.cargo,
			passengersDelivered: split.passengers,
			splitMeasure: SPLIT_MEASURE,
			mean: mean(days),
			median: median(days),
			stations: mean(used.map((m) => (typeof m.stations === "number" ? m.stations : null))),
			vehicles: mean(used.map((m) => (typeof m.vehicles === "number" ? m.vehicles : null))),
		};

		const efficiency: EfficiencyAxis = {
			measure: DELIVERED_MEASURE,
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
		const outcomeDistribution: OutcomeClassCount[] = Object.entries(outcomes)
			.map(([code, count]) => {
				const d = describeOutcome(code as OutcomeClass);
				return { code: d.code, label: d.label, hint: d.hint, count: Number(count) };
			})
			.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
		const stability: StabilityAxis = {
			toolFailureRate: calls > 0 ? failures / calls : null,
			outcomes,
			outcomeDistribution,
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
