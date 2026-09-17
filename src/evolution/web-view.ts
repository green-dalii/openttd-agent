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

import { type CompareBy, compareArms, type GameMetric} from "./metrics.js";
import { evaluatePromotion, type StrategyCard } from "./strategies.js";
import { readLessons, readMetrics, readStrategies, setStrategyEnabled } from "./store.js";

/** A strategy card plus the server's verdict on whether it may ever be injected. */
export interface AnnotatedStrategy extends StrategyCard {
	promotion: { promoted: boolean; value: number; runs: number; reason: string };
}

export interface EvolutionView {
	metrics: GameMetric[];
	lessons: unknown[];
	strategies: AnnotatedStrategy[];
	/** Arm comparison for the M3 acceptance ("with vs without lessons"). */
	arms: unknown;
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

	return { metrics, lessons, strategies, arms: compareArms(metrics, by) };
}

export { setStrategyEnabled };
