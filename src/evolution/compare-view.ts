/**
 * The Compare page's data (B4) — read-only, computed from the metric rows.
 *
 * 职责: 把**已有的度量行**折成看板要画的那张表：每个模型四轴、排除按原因计数、
 *   两个模型之间的配对判定、以及每一局的可下钻明细。
 * 为什么存在: `buildScorecard` / `pairedComparison` / `powerVerdict` 早就能算出四轴与
 *   置信区间，但**没有任何 HTTP 端点或页面**把它们露出来（只有 CLI 的 `scripts/bench.ts`）。
 * 铁律:
 *   - **数字只来自 scorecard/pairedComparison**：本模块不重算任何一个数，也不下判断
 *     （"哪个更好"是 scorecard.ts 的事，本模块只搬运）。
 *   - **缺失 = null**（不是 0）：没价目表的模型 `costPerRun` 是"没测到"，不是免费。
 *   - **被排除的局必须计数并带原因**：静默丢弃 = 伪造样本量。
 *   - 只读：本模块不写任何文件，也不发起运行。
 * 事实来源: docs/DASHBOARD-CODESIGN.md §4.2；scorecard.ts / bench-stats.ts / metrics.ts。
 * 禁止: 在此发明阈值、在此比较模型、在此改写口径。
 */

import { metricExclusion, type GameMetric } from "./metrics.js";
import { buildScorecard, type BenchConditions, type ModelCard } from "./scorecard.js";
import { pairedComparison, type PairedComparison } from "./bench-stats.js";

/** One run, as the Compare page lists it (the drill-down to History). */
export interface CompareRun {
	/** The session id — the drill-down link into History. */
	id: string;
	/** The model that actually served the run. */
	model: string;
	/** The model that was requested (differs when a gateway substitutes). */
	requestedModel: string;
	seed: number;
	backend: string | null;
	status: string;
	/** Why the run was left out (null = it counts). */
	excluded: string | null;
	/** Cargo delivered per game day (null when either side is unknown). */
	deliveredPerGameDay: number | null;
	deliveredRun: number | null;
	simulatedDays: number | null;
	totalTokens: number;
	/** Whether the cost was measurable (false = no price table). */
	costKnown: boolean | null;
	costTotal: number | null;
	startedAt: number;
}

/** How many runs were left out, per reason. */
export interface ExclusionCount {
	reason: string;
	count: number;
}

/** Everything the Compare page draws. */
export interface ComparePayload {
	conditions: BenchConditions;
	/** One card per model: the four axes (from `buildScorecard`). */
	models: ModelCard[];
	/** The runs left out, counted by reason. */
	exclusions: ExclusionCount[];
	/** The paired comparison of the two selected models (null if not two). */
	comparison: PairedComparison | null;
	/** The runs themselves (the drill-down list). */
	runs: CompareRun[];
}

/** The model that served a run (a gateway substitute must not be credited to the request). */
function servedModel(m: GameMetric): string {
	return m.manifest?.servedModel || m.llmModel || "unknown";
}

/** Cargo delivered per game day, or null when either side is unknown. */
function perDay(m: GameMetric): number | null {
	if (typeof m.deliveredRun !== "number" || typeof m.simulatedDays !== "number" || m.simulatedDays <= 0) return null;
	return m.deliveredRun / m.simulatedDays;
}

/**
 * Build the Compare page's payload.
 *
 * The filters (`models`, `seed`, `backend`) narrow the **rows shown**; the
 * scorecard is computed from the same narrowed set, so the axes and the list
 * always describe the same runs.
 */
export function buildCompareView(
	metrics: GameMetric[],
	opts: { models?: string[]; seed?: number; backend?: string; conditions?: BenchConditions } = {},
): ComparePayload {
	const rows = (Array.isArray(metrics) ? metrics : []).filter((m) => m && typeof m === "object");
	const wanted = opts.models && opts.models.length ? new Set(opts.models) : null;
	const filtered = rows.filter((m) => {
		if (wanted && !wanted.has(servedModel(m))) return false;
		if (typeof opts.seed === "number" && Number.isFinite(opts.seed) && m.seed !== opts.seed) return false;
		if (opts.backend && (m.manifest?.backend ?? null) !== opts.backend) return false;
		return true;
	});

	// The four axes: from the scorecard, never recomputed here.
	const models = buildScorecard(filtered, opts.conditions ? { conditions: opts.conditions } : {}).models;

	// The exclusions: counted by the existing reason enum.
	const counts = new Map<string, number>();
	for (const m of filtered) {
		const why = metricExclusion(m);
		if (!why) continue;
		counts.set(why, (counts.get(why) ?? 0) + 1);
	}
	const exclusions: ExclusionCount[] = [...counts.entries()]
		.map(([reason, count]) => ({ reason, count }))
		.sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

	// The paired comparison: only when exactly two models are selected.
	const selected = opts.models ?? [];
	const comparison =
		selected.length === 2 ? pairedComparison(filtered, selected[0]!, selected[1]!) : null;

	const runs: CompareRun[] = filtered
		.map((m) => ({
			id: String(m.id ?? ""),
			model: servedModel(m),
			requestedModel: String(m.llmModel ?? ""),
			seed: Number(m.seed ?? 0),
			backend: m.manifest?.backend ?? null,
			status: String(m.status ?? ""),
			excluded: metricExclusion(m),
			deliveredPerGameDay: perDay(m),
			deliveredRun: typeof m.deliveredRun === "number" ? m.deliveredRun : null,
			simulatedDays: typeof m.simulatedDays === "number" ? m.simulatedDays : null,
			totalTokens: Number(m.totalTokens ?? 0),
			costKnown: typeof m.costKnown === "boolean" ? m.costKnown : null,
			costTotal: typeof m.costTotal === "number" ? m.costTotal : null,
			startedAt: Number(m.startedAt ?? 0),
		}))
		.sort((a, b) => b.startedAt - a.startedAt);

	return {
		conditions: opts.conditions ?? { scenario: null, horizonDays: null, seeds: [], repeats: 0 },
		models,
		exclusions,
		comparison,
		runs,
	};
}
