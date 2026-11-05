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

import { createHash } from "node:crypto";
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
	/**
	 * Distinct **observation-shape** hashes (the structure of the world facts the
	 * model sees). Cross-seed stable ⇒ comparable across runs (SPEC §10.121).
	 */
	observationShapeHashes: string[];
	/**
	 * Distinct **observation policies** the GS reported (`towns=all;…`).
	 *
	 * A different slice of the world is a different question, even when the facts
	 * have the same shape — so this, too, decides "differs".
	 */
	observationPolicies: string[];
	/**
	 * Distinct payload-shape hashes (the real request, numbers normalised).
	 *
	 * **Informational only**: the payload contains the world (town names, industry
	 * lists), so it differs on every seed — it must NOT decide "different
	 * question" (that would cry wolf on every cross-seed comparison).
	 */
	payloadShapeHashes: string[];
	/** True when the compared runs were not answering the same question. */
	differs: boolean;
}

/**
 * One group of runs that answered **the same question**.
 *
 * Why groups exist (2026-11-02, the owner's decision for Issue #13): two runs
 * with a different scaffold (prompt + tools), a different observation surface or
 * a different slice of the world are **not the same question**. The 2026-10-31
 * benchmark matrix was produced by an older scaffold; mixing it with the newer
 * runs would compare two different things. So the runs are **partitioned** and
 * only one group is compared at a time - the rest are disclosed, never dropped
 * silently.
 *
 * The key comes from the **manifest's own fields** (the same ones that decide
 * `surface.differs`), so the page cannot invent a grouping of its own.
 */
export interface QuestionGroup {
	/** A short stable id (the page passes it back to pick this group). */
	id: string;
	/** The scaffold (prompt + tools). Null = the run did not record it. */
	scaffoldHash: string | null;
	/** The structure of the observation surface. Null = not recorded. */
	observationShapeHash: string | null;
	/** Which slice of the world the GS exposed. Null = not recorded. */
	observationPolicy: string | null;
	/** How many runs are in this group. */
	runs: number;
	/** The models that served the runs in this group. */
	models: string[];
	/** The first and the last run of the group (ms). */
	firstStartedAt: number;
	lastStartedAt: number;
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
	/**
	 * The groups the filtered runs fall into ("did these answer the same
	 * question?"). The page offers them; the server picks the default.
	 */
	groups: QuestionGroup[];
	/** The group the numbers below come from (null when there is no run). */
	selectedGroupId: string | null;
	/**
	 * How many filtered runs are in **another** group - they are not in any
	 * number below. A silently shrinking sample is how a benchmark starts to
	 * lie (Issue #58's rule, applied to groups).
	 */
	runsOutsideGroup: number;
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

/** The three manifest fields that decide "the same question" (null = not recorded). */
function questionKey(m: GameMetric): [string | null, string | null, string | null] {
	const norm = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
	return [
		norm(m.manifest?.scaffoldHash),
		norm(m.manifest?.observationShapeHash),
		norm(m.manifest?.observationPolicy),
	];
}

/** A short, stable id for a group key (the page passes it back to select it). */
function groupId(key: [string | null, string | null, string | null]): string {
	return createHash("sha256").update(key.map((k) => k ?? "").join("|")).digest("hex").slice(0, 8);
}

/**
 * Partition the runs into "the same question" groups.
 *
 * The key is the manifest's own triple (scaffold, observation shape, observed
 * policy) - the very fields `surface.differs` uses - so the page cannot invent
 * a grouping. Runs that never recorded a field group under null (i.e. "not
 * recorded"), never under a guess.
 */
export function questionGroups(rows: GameMetric[]): QuestionGroup[] {
	const byId = new Map<string, QuestionGroup>();
	for (const m of rows) {
		const key = questionKey(m);
		const id = groupId(key);
		const existing = byId.get(id);
		const startedAt = Number(m.startedAt ?? 0);
		if (!existing) {
			byId.set(id, {
				id,
				scaffoldHash: key[0],
				observationShapeHash: key[1],
				observationPolicy: key[2],
				runs: 1,
				models: [servedModel(m)],
				firstStartedAt: startedAt,
				lastStartedAt: startedAt,
			});
			continue;
		}
		existing.runs += 1;
		if (!existing.models.includes(servedModel(m))) existing.models.push(servedModel(m));
		existing.models.sort();
		if (startedAt < existing.firstStartedAt) existing.firstStartedAt = startedAt;
		if (startedAt > existing.lastStartedAt) existing.lastStartedAt = startedAt;
	}
	return [...byId.values()].sort((a, b) => b.runs - a.runs || b.lastStartedAt - a.lastStartedAt);
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
	opts: {
		models?: string[];
		seed?: number;
		backend?: string;
		/** The group to compare (its id). Unknown ids fall back to the default. */
		group?: string;
		conditions?: BenchConditions;
	} = {},
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

	// The groups: runs that answered the same question. The numbers below come
	// from **one** group only - the other groups are disclosed, not merged in
	// (the owner's decision for Issue #13: the old matrix is its own group).
	const groups = questionGroups(filtered);
	const wantedGroup = opts.group ? groups.find((g) => g.id === opts.group) : undefined;
	const selectedGroup =
		wantedGroup ??
		// Default: the group with the most runs (ties = the newest one). A group
		// of the biggest matrix is the one the user most likely means.
		groups[0] ??
		null;
	const scoped = selectedGroup ? filtered.filter((m) => groupId(questionKey(m)) === selectedGroup.id) : [];

	// The four axes: from the scorecard, never recomputed here. The scorecard also
	// carries the outcome classes with the server's own names (B5), so this module
	// has no vocabulary of its own.
	const models = buildScorecard(scoped, opts.conditions ? { conditions: opts.conditions } : {}).models;

	// The exclusions: counted by the existing reason enum.
	const counts = new Map<string, number>();
	for (const m of scoped) {
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
		selected.length === 2 ? pairedComparison(scoped, selected[0]!, selected[1]!) : null;

	const runs: CompareRun[] = scoped
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
		for (const m of scoped) {
			const v = pick(m);
			if (typeof v === "string" && v) out.add(v);
		}
		return [...out].sort();
	};
	const scaffoldHashes = distinct((m) => m.manifest?.scaffoldHash);
	const observationShapeHashes = distinct((m) => m.manifest?.observationShapeHash);
	const observationPolicies = distinct((m) => m.manifest?.observationPolicy);
	const payloadShapeHashes = distinct((m) => m.manifest?.payloadShapeHash);

	return {
		conditions: opts.conditions ?? { scenario: null, horizonDays: null, seeds: [], repeats: 0 },
		collisions,
		surface: {
			scaffoldHashes,
			observationShapeHashes,
			observationPolicies,
			payloadShapeHashes,
			// The trigger is the **cross-seed stable** facts: the scaffold
			// (prompt + tools), the observation surface's shape, and the policy
			// (which slice of the world was exposed). The payload shape is listed
			// for the record but never decides — it contains the world, so it
			// differs on every seed.
			differs:
				scaffoldHashes.length > 1 ||
				observationShapeHashes.length > 1 ||
				observationPolicies.length > 1,
		},
		models,
		exclusions,
		comparison,
		runs,
		groups,
		selectedGroupId: selectedGroup?.id ?? null,
		runsOutsideGroup: filtered.length - scoped.length,
	};
}
