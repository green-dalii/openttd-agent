/**
 * Outcome taxonomy (D3b / S8) — why a run ended the way it did.
 *
 * 职责: 给每一局一个**具名结果**，让"0 分"不再是空数字。
 * 为什么需要: 0 分至少有六种成因（agent 自己按了暂停 / 世界冻住 / 墙钟到点 /
 *   工具全被拒 / 没建成线 / 建成了但一单没送），它们对"模型会不会玩"的含义
 *   **完全不同**——混在一起就没法比较。
 * 铁律:
 *   - 缺失读数 → `unknown`（不猜）。
 *   - 优先级固定：人为停止 > 环境事件 > 结果读数，**一个局只报一个成因**。
 *   - 纯函数，无评价。
 */

import type { GameMetric } from "./metrics.js";
import { budgetStop } from "../agent/run-budget.js";

/** The named reason a run ended the way it did. */
export type OutcomeClass =
	| "delivered"
	| "delivered_nothing"
	| "no_construction"
	| "refused"
	| "paused_by_agent"
	| "world_frozen"
	| "wall_clock_cap"
	| "token_cap"
	| "cost_cap"
	| "unknown";

/** The subset of a metric row the classification reads. */
export interface OutcomeFacts {
	deliveredRun?: number | null;
	constructionDone?: boolean | null;
	toolCalls?: number | null;
	toolFailures?: number | null;
	gsErrors?: number | null;
	reachedHorizon?: boolean | null;
	blockedByPause?: boolean | null;
	worldFrozen?: boolean | null;
	/** Spend readings, used only to name a cap that ended the run. */
	totalTokens?: number | null;
	costTotal?: number | null;
	costKnown?: boolean;
	manifest?: { tokenLimit?: number | null; costLimit?: number | null } | null;
}

/**
 * Classify a run's outcome.
 *
 * Order matters and is part of the contract: a run that was stopped did not
 * "fail to learn", so the stop reason wins over anything about the score.
 */
export function classifyOutcome(m: OutcomeFacts | GameMetric | null | undefined): OutcomeClass {
	if (!m) return "unknown";
	const f = m as OutcomeFacts;
	if (f.blockedByPause === true) return "paused_by_agent";
	if (f.worldFrozen === true) return "world_frozen";
	if (f.reachedHorizon === false) {
		// A cap is only the reason when the horizon was NOT reached: a run that
		// finished its horizon produced a valid result even if it also spent a lot.
		// The comparison comes from run-budget.ts so the loop's stop condition and
		// the recorded reason cannot drift apart.
		const stop = budgetStop(
			{ tokens: f.manifest?.tokenLimit ?? null, cost: f.manifest?.costLimit ?? null },
			{ totalTokens: f.totalTokens, costTotal: f.costTotal },
			f.costKnown !== false,
		);
		if (stop === "token_cap") return "token_cap";
		if (stop === "cost_cap") return "cost_cap";
		return "wall_clock_cap";
	}
	if (typeof f.deliveredRun !== "number" || !Number.isFinite(f.deliveredRun)) return "unknown";
	if (f.deliveredRun > 0) return "delivered";
	// Every tool call was refused: the agent never got to act.
	if (typeof f.toolCalls === "number" && f.toolCalls > 0 && f.toolCalls === f.toolFailures) return "refused";
	if (f.constructionDone === false) return "no_construction";
	if (f.constructionDone === true) return "delivered_nothing";
	return "unknown";
}
