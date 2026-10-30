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

/**
 * The ten classes, in one list — the vocabulary is **closed**.
 *
 * 为什么要有这张表（B5 / CoDesign F5）：后端早就能判定十类成因，但页面只报得出
 * 一部分，最可行动的一类（`refused`：所有工具调用被拒）完全不可见。
 * 名字与解释由**服务端**给出：页面自己写一份词表，就是把"这个结果意味着什么"
 * 变成两份实现，迟早漂移（MEMORY C1 的同款机制）。
 */
export const OUTCOME_CLASSES: readonly OutcomeClass[] = [
	"delivered",
	"delivered_nothing",
	"no_construction",
	"refused",
	"paused_by_agent",
	"world_frozen",
	"wall_clock_cap",
	"token_cap",
	"cost_cap",
	"unknown",
];

/** How one class is shown: what it is called, and what it means for the run. */
export interface OutcomeDescription {
	code: OutcomeClass;
	/** What the class is called in the UI. */
	label: string;
	/** What it means — and whether it counts as a learning result. */
	hint: string;
}

/** One class with how many runs ended that way. */
export interface OutcomeClassCount extends OutcomeDescription {
	count: number;
}

/**
 * The wording per class.
 *
 * 事实: `paused_by_agent` / `world_frozen` / 三个 cap 都**不是**"没学会"
 *   （SPEC §10.101/§10.102：被人停的局与环境停的局都要从平均值里挑出去）；
 *   `unknown` 是"没测到"，不是"什么都没发生"（D60）。
 */
const DESCRIPTIONS: Record<OutcomeClass, { label: string; hint: string }> = {
	delivered: {
		label: "Delivered",
		hint: "the run delivered cargo - a real result",
	},
	delivered_nothing: {
		label: "Built, delivered nothing",
		hint: "construction finished but no cargo moved - look at the route and the vehicles",
	},
	no_construction: {
		label: "Nothing built",
		hint: "the run ended before any construction finished - the agent never got a line up",
	},
	refused: {
		label: "Every tool call was refused",
		hint: "the model never got to act: every call was rejected - wrong arguments, or no budget left",
	},
	paused_by_agent: {
		label: "Paused by the agent",
		hint: "the run was stopped from inside (set_pause) - not a learning result",
	},
	world_frozen: {
		label: "The world froze",
		hint: "the environment stopped advancing, not the agent - not a learning result",
	},
	wall_clock_cap: {
		label: "Wall-clock cap",
		hint: "the run hit the time limit before the horizon - a shorter answer, not a worse one",
	},
	token_cap: {
		label: "Token cap",
		hint: "the run hit the token limit before the horizon - raise the limit to let it finish",
	},
	cost_cap: {
		label: "Cost cap",
		hint: "the run hit the cost limit before the horizon - raise the limit to let it finish",
	},
	unknown: {
		label: "Unknown",
		hint: "not enough readings to name the outcome - not the same as 'nothing happened'",
	},
};

/** The name and the meaning of one class (never empty). */
export function describeOutcome(code: OutcomeClass): OutcomeDescription {
	const d = DESCRIPTIONS[code] ?? DESCRIPTIONS.unknown;
	return { code, label: d.label, hint: d.hint };
}

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
