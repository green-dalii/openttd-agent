/**
 * Evolution web view — the single source for what the dashboard is shown.
 *
 * 职责: 把一个 dataDir 的进化层组装成**已注解**的只读视图（供 `/api/evolution`），
 *   并在服务端完成所有**规则判定**。
 * 事实来源: SPEC §5.2 #3（对照实验）、§5.3（入库门槛 / 人工确认）、§6.1 #4。
 * 禁止: 在此做 HTTP 处理（见 src/web/server.ts）。
 *
 * 为什么规则必须在服务端:浏览器**不能**重新实现 promotion 门槛或"样本是否足够"的判定,
 * 否则同一规则会存在两份实现并悄悄漂移——本仓库已经因为 `toWireSnapshot` 有两份
 * 而让主模式的现金曲线空了整整一个版本（MEMORY.md C1）。
 * 页面只负责显示服务端给出的结论。
 */

import { classifyOutcome } from "./outcome.js";
import { normalizeRun } from "./normalized.js";
import { type CompareBy, compareArms, metricExclusion, type GameMetric} from "./metrics.js";
import { buildCompareView } from "./compare-view.js";
import { historyGroups, type GroupBy } from "./history-groups.js";
import { evaluatePromotion, type StrategyCard } from "./strategies.js";
import { readLessons, readMetrics, readMetricsWithCollisions, readStrategies, setStrategyEnabled } from "./store.js";
import type { ArmComparison } from "./metrics.js";

/** A strategy card plus the server's verdict on whether it may ever be injected. */
export interface AnnotatedStrategy extends StrategyCard {
	promotion: { promoted: boolean; value: number; runs: number; reason: string };
}

/**
 * 一局的归一化读数（给页面画趋势用）。
 *
 * 为什么服务端算：归一化的口径只有一处定义（`normalizeRun`）⇒ 页面重算就是
 * 第二份口径，必然漂移（MEMORY D132 的同一类问题）。
 */
export interface NormalizedSeriesPoint {
	id: string;
	/** 这一局建了几条线（分母本身）。 */
	lines: number | null;
	/** 这一局有几辆车（另一个分母）。 */
	vehicles: number | null;
	deliveredPerLine: number | null;
	operatingProfitPerLine: number | null;
	deliveredPerVehicle: number | null;
	operatingProfitPerVehicle: number | null;
}

export interface EvolutionView {
	metrics: GameMetric[];
	lessons: unknown[];
	strategies: AnnotatedStrategy[];
	/**
	 * 逐局的归一化读数（最旧 → 最新）。
	 *
	 * null = **不可比**（没建线 ⇒ 分母为 0；老局没记读数 ⇒ 分母没测到），
	 * 不是 0 ⇒ 页面画成断点，而不是"这一局什么都没运"。
	 */
	normalizedSeries: NormalizedSeriesPoint[];
	/** Arm comparison for the M3 acceptance ("with vs without lessons"). */
	/** 对照结果（`compareArms` 的返回）——判据的单一事实源，不再留 unknown。 */
	arms: ArmComparison;
}

/** Read + annotate everything the Evolution page shows. Never throws. */
export function evolutionView(dataDir: string, by: CompareBy = "memory"): EvolutionView {
	let metrics: GameMetric[] = [];
	try {
		metrics = readMetrics(dataDir);
	} catch {
		metrics = [];
	}

	let lessons: unknown[] = [];
	try {
		lessons = readLessons(dataDir);
	} catch {
		lessons = [];
	}

	let strategies: AnnotatedStrategy[] = [];
	try {
		strategies = readStrategies(dataDir).map((c) => ({ ...c, promotion: evaluatePromotion(c) }));
	} catch {
		strategies = [];
	}

	// D3b/S8: derive the outcome class for every row. Derived, never stored -
	// so it can never disagree with the facts it is computed from.
	const withClass = metrics.map((m) => ({ ...m, outcomeClass: classifyOutcome(m) }));
	// 归一化序列（最旧 → 最新）：页面的"每条线能运多少"趋势直接用这份数据。
	const normalizedSeries: NormalizedSeriesPoint[] = metrics
		.slice()
		.sort((a, b) => Number(a.startedAt ?? 0) - Number(b.startedAt ?? 0))
		.map((m) => {
			const n = normalizeRun(m);
			return {
				id: String(m.id ?? ""),
				lines: n.lines,
				vehicles: typeof m.vehicles === "number" && Number.isFinite(m.vehicles) ? m.vehicles : null,
				deliveredPerLine: n.deliveredPerLine,
				operatingProfitPerLine: n.operatingProfitPerLine,
				deliveredPerVehicle: n.deliveredPerVehicle,
				operatingProfitPerVehicle: n.operatingProfitPerVehicle,
			};
		});
	return { metrics: withClass, lessons, strategies, arms: compareArms(metrics, by), normalizedSeries };
}

export { setStrategyEnabled };

/**
 * The dashboard's evolution hooks — **one** construction, shared by the
 * supervised server and the standalone runner.
 *
 * Why one: the runner calls `web.attach({evolution: …})`, which **replaces**
 * the server's hooks with its own (D82: a replaced hook means two contracts
 * unless there is one construction). The two copies had already drifted: only
 * the server's added the per-row `excluded` reason, so the same run showed a
 * different exclusion on two paths.
 *
 * The Compare page's payload (B4) is computed **here**, not in the web layer:
 * the four axes, the exclusion counts and the paired verdict are the
 * evolution layer's rules (`scorecard.ts` / `bench-stats.ts`), and the page
 * must not recompute any of them.
 */
export function evolutionHooks(dataDir: string): {
	metrics: () => unknown[];
	/** 账本里因 session id 撞号被丢掉的行（Issue #58：丢行必须可见）。 */
	collisions: () => unknown[];
	lessons: () => unknown[];
	strategies: () => unknown[];
	arms: () => unknown;
	setStrategyEnabled: (id: string, enabled: boolean) => boolean;
	/**
	 * The per-run normalised readings (oldest → newest) — the History
	 * capability chart's data.
	 *
	 * 为什么必须走这个 hook：`evolutionView()` 已经在算它了，但页面只拿到
	 * metrics/lessons/strategies/arms ⇒ **能力趋势图会画出一张空图**，而
	 * 空图看起来"正常"（AGENTS §5.2：空态通过 = 没验证）。
	 */
	normalizedSeries: () => unknown[];
	compare: (opts: { models?: string[]; seed?: number; backend?: string; group?: string }) => unknown;
	groups: (by: GroupBy) => unknown;
} {
	return {
		// Read fresh on each request: the page must reflect games that finished
		// after it was loaded. `excluded` is an additive field — the reason comes
		// from `metricExclusion`, the single writer of that rule (D64/C1).
		metrics: () => evolutionView(dataDir).metrics.map((m) => ({ ...m, excluded: metricExclusion(m) })),
		// Issue #58 的可见性：`metrics` 是"同 id 取最新"之后的投影，被丢掉的行
		// 只能从这里看到。History 的顶部 KPI 用这些行算中位数 ⇒ 必须一并披露，
		// 否则页面会安静地把样本说小（沉默缩小样本是基准最会骗人的方式）。
		collisions: () => readMetricsWithCollisions(dataDir).collisions,
		lessons: () => evolutionView(dataDir).lessons,
		strategies: () => evolutionView(dataDir).strategies,
		arms: () => evolutionView(dataDir).arms,
		normalizedSeries: () => evolutionView(dataDir).normalizedSeries,
		setStrategyEnabled: (id: string, enabled: boolean) => setStrategyEnabled(dataDir, id, enabled),
		compare: (opts) => {
			// The ledger reports the ids that collided (Issue #58): a dropped row
			// must be visible on the page, not silently shrink the sample.
			const { rows, collisions } = readMetricsWithCollisions(dataDir);
			return buildCompareView(rows, opts, collisions);
		},
		// The runs grouped by the ledger's own fields (B6). The page does not
		// group them itself: the key has to be the one the ledger records.
		groups: (by) => historyGroups(readMetricsSafe(dataDir), by),
	};
}

/** The metric rows, or an empty list when the ledger cannot be read. */
function readMetricsSafe(dataDir: string): GameMetric[] {
	try {
		return readMetrics(dataDir);
	} catch {
		return [];
	}
}
