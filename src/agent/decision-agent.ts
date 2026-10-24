/**
 * Decision agent — what the decision loop needs from a brain, and nothing more.
 *
 * 职责: 把"一次决策"抽象成两个能力：**发一条提示**、**回读刚产生的消息**（用于
 *   解析结构化 decision）。两种实现:
 *   - `agentDecisionAgent`：裸 `Agent`（旧路径，历史行为不变）；
 *   - `laneDecisionAgent`：`AgentHarness` 的 lane（D6a，可回放会话）。
 * 事实来源: `Agent.prompt` / `Agent.state.messages`；`AgentLane.prompt` 返回
 *   `RunResult`（**只有操作元数据，不含消息**，agent-harness.d.ts:648），
 *   所以消息必须从 transcript 回读（`findEntries`）。
 * 禁止: 在这里解析 plan（那是 loop 的纯函数）；禁止掩盖失败 —— lane 的
 *   `Result.err` 必须抛错，否则"这局没决策"会被记成"决策了但没计划"。
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentLane } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";

export interface DecisionAgent {
	/** Send one decision prompt and wait until the turn settles. Throws on failure. */
	prompt(text: string): Promise<void>;
	/** Transcript messages, oldest → newest, for plan extraction. */
	planMessages(): Promise<readonly unknown[]>;
}

/**
 * How many transcript entries the lane adapter reads back.
 *
 * `extractPlan` scans backwards for the newest assistant text that parses, so
 * the window only has to be larger than one decision's turns. 60 covers the
 * tool-budget ceiling (12 calls ≈ 24 messages) with room to spare; a larger
 * window would only cost JSON reads, never correctness.
 */
export const LANE_PLAN_WINDOW = 60;

/** Adapt a bare `Agent` (legacy path). */
export function agentDecisionAgent(agent: Agent): DecisionAgent {
	return {
		prompt: async (text: string) => {
			await agent.prompt(text);
		},
		planMessages: async () => agent.state.messages as unknown as readonly unknown[],
	};
}

/**
 * Adapt a harness lane (D6a).
 *
 * The harness returns only an operation record, so the assistant messages are
 * read back from the session transcript. Reading the newest N entries and
 * reversing them reproduces the `Agent.state.messages` order the plan parser
 * already expects.
 */
export function laneDecisionAgent(lane: AgentLane, context: Context): DecisionAgent {
	return {
		prompt: async (text: string) => {
			const result = await lane.prompt(text, undefined, context);
			if (!result.ok) {
				throw new Error(`harness prompt failed: ${describeError(result.error)}`);
			}
			if (result.value.status === "suspended") {
				// We never defer runs, so a suspended run means the harness state is
				// not what this adapter assumes. Failing loudly beats reporting a
				// decision that never happened.
				throw new Error("harness run was suspended; this adapter does not support deferred runs");
			}
		},
		planMessages: async () => {
			const entries = await lane.findEntries(
				{ type: "message", order: "newestFirst", limit: LANE_PLAN_WINDOW },
				context,
			);
			return entries.map((e) => (e as { message?: unknown }).message).filter((m) => m !== undefined).reverse();
		},
	};
}

/** Compact, log-safe description of a harness error object. */
function describeError(err: unknown): string {
	if (err && typeof err === "object") {
		const e = err as { message?: unknown; type?: unknown; reason?: unknown };
		if (typeof e.message === "string") return e.message;
		if (typeof e.reason === "string") return e.reason;
		if (typeof e.type === "string") return e.type;
	}
	return String(err);
}
