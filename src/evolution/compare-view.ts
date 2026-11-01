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
import type { LedgerCollision } from "./store.js";
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
	/** Cargo + passengers delivered per game day (null when either side is unknown). */
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

/**
 * Did the compared runs answer the **same question**?
 *
 * Why this is here and not folded into `scaffoldHash` (2026-11-01 assessment):
 * `scaffoldHash` covers only the static scaffold (system prompt + tool
 * name/description/schema) so it can be computed **before** a run - that is what
 * the next-run preview prints. The observation surface (towns, industries, routes,
 * the `since` delta) depends on the world and cannot exist before it; folding it
 * into `scaffoldHash` would make the hash seed-dependent and break the preview.
 * `payloadShapeHash` already fingerprints the *whole question* (numbers
 * normalised), so a change in `observe()` moves it.
 *
 * What was missing was not the hash but the **comparison**: nothing looked at it.
 * This block states the fact; excluding runs stays a human decision (the page
 * only discloses).
 */
export interface SurfaceCheck {
	/** Distinct scaffold hashes among the compared runs (null/absent excluded). */
	scaffoldHashes: string[];
	/** Distinct payload-shape hashes (the question actually asked, numbers normalised). */
	payloadShapeHashes: string[];
	/** True when the compared runs were not answering the same question. */
	differs: boolean;
}

/** Everything the Compare page draws. */
export interface ComparePayload {
	conditions: BenchConditions;
	/**
	 * Session ids the ledger saw more than once, and how many rows each one
	 * swallowed (Issue #58). The page must say this out loud: a silently
	 * shrinking sample is how a benchmark ends up lying.
	 */
	collisions: LedgerCollision[];
	/** One card per model: the four axes (from `buildScorecard`). */
	models: ModelCard[];
	/** The runs left out, counted by reason. */
	exclusions: ExclusionCount[];
	/** The paired comparison of the two selected models (null if not two). */
	comparison: PairedComparison | null;
	/** The runs themselves (the drill-down list). */
	runs: CompareRun[];
	/** Whether the compared runs shared a scaffold and an observation surface. */
	surface: SurfaceCheck;
}

/** The model that served a run (a gateway substitute must not be credited to the request). */
function servedModel(m: GameMetric): string {
	return m.manifest?.servedModel || m.llmModel || "unknown";
}

/** Cargo + passengers delivered per game day, or null when either side is unknown. */
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
	collisions: LedgerCollision[] = [],
): ComparePayload {
	const rows = (Array.isArray(metrics) ? metrics : []).filter((m) => m && typeof m === "object");
	const wanted = opts.models && opts.models.length ? new Set(opts.models) : null;
	const filtered = rows.filter((m) => {
		if (wanted && !wanted.has(servedModel(m))) return false;
		if (typeof opts.seed === "number" && Number.isFinite(opts.seed) && m.seed !== opts.seed) return false;
		if (opts.backend && (m.manifest?.backend ?? null) !== opts.backend) return false;
		return true;
	});

	// The four axes: from the scorecard, never recomputed here. The scorecard also
	// carries the outcome classes with the server's own names (B5), so this module
	// has no vocabulary of its own.
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

	const distinct = (pick: (m: GameMetric) => unknown): string[] => {
		const out = new Set<string>();
		for (const m of filtered) {
			const v = pick(m);
			if (typeof v === "string" && v) out.add(v);
		}
		return [...out].sort();
	};
	const scaffoldHashes = distinct((m) => m.manifest?.scaffoldHash);
	const payloadShapeHashes = distinct((m) => m.manifest?.payloadShapeHash);

	return {
		conditions: opts.conditions ?? { scenario: null, horizonDays: null, seeds: [], repeats: 0 },
		collisions,
		surface: {
			scaffoldHashes,
			payloadShapeHashes,
			differs: scaffoldHashes.length > 1 || payloadShapeHashes.length > 1,
		},
		models,
		exclusions,
		comparison,
		runs,
	};
}
