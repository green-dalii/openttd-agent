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
import { type CompareBy, compareArms, metricExclusion, type GameMetric} from "./metrics.js";
import { buildCompareView } from "./compare-view.js";
import { historyGroups, type GroupBy } from "./history-groups.js";
import { evaluatePromotion, type StrategyCard } from "./strategies.js";
import { readLessons, readMetrics, readStrategies, setStrategyEnabled } from "./store.js";
import type { ArmComparison } from "./metrics.js";

/** A strategy card plus the server's verdict on whether it may ever be injected. */
export interface AnnotatedStrategy extends StrategyCard {
	promotion: { promoted: boolean; value: number; runs: number; reason: string };
}

export interface EvolutionView {
	metrics: GameMetric[];
	lessons: unknown[];
	strategies: AnnotatedStrategy[];
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
	return { metrics: withClass, lessons, strategies, arms: compareArms(metrics, by) };
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
	lessons: () => unknown[];
	strategies: () => unknown[];
	arms: () => unknown;
	setStrategyEnabled: (id: string, enabled: boolean) => boolean;
	compare: (opts: { models?: string[]; seed?: number; backend?: string }) => unknown;
	groups: (by: GroupBy) => unknown;
} {
	return {
		// Read fresh on each request: the page must reflect games that finished
		// after it was loaded. `excluded` is an additive field — the reason comes
		// from `metricExclusion`, the single writer of that rule (D64/C1).
		metrics: () => evolutionView(dataDir).metrics.map((m) => ({ ...m, excluded: metricExclusion(m) })),
		lessons: () => evolutionView(dataDir).lessons,
		strategies: () => evolutionView(dataDir).strategies,
		arms: () => evolutionView(dataDir).arms,
		setStrategyEnabled: (id: string, enabled: boolean) => setStrategyEnabled(dataDir, id, enabled),
		compare: (opts) => buildCompareView(readMetricsSafe(dataDir), opts),
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
