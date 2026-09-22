/**
 * Agent layer — shared types & dependency contracts.
 *
 * 职责: 定义 agent 层与游戏层之间的**抽象边界**（依赖倒置），使 tools 可用
 *   mock 完全单测，无需真机/网络。
 * 事实来源: SPEC §4.1-§4.3（tools/convertToLlm/transformContext 设计）。
 * 禁止: 在此层直接依赖 AdminClient 具体类（只用下方接口）；禁止游戏语义推断。
 */

import type { RouteStats } from "./route-stats.js";
import type { WorldSnapshot } from "../game/world-state.js";

/** Outbound command channel the tools use (implemented by AdminClient). */
export interface CommandSink {
	/** Send a JSON command to the in-game Bridge GS (SPEC §10.11). */
	gameScript(json: string): void;
	/** Server-level RCON command (pause/unpause/save/...). */
	rcon(command: string): void;
	/**
	 * RCON with the reply awaited (2026-09-17). Optional because not every sink
	 * can observe replies; tools must then REPORT that they could not confirm
	 * rather than claiming success (observe-or-refuse).
	 */
	rconAwait?(command: string, timeoutMs?: number): Promise<string | null>;
}

/** Read-side: latest normalized world state (implemented by WorldState). */
export interface StateReader {
	snapshot(): WorldSnapshot;
}

/** Everything a tool needs; injected so tests can substitute fakes. */
export interface AgentDeps {
	sink: CommandSink;
	state: StateReader;
	/**
	 * Latest per-route economics reported by the GS (NEXT-2 N2-1).
	 * Optional on purpose: modes without a GS channel have nothing to report,
	 * and `inspect_route` must REFUSE in that case rather than return an empty
	 * success ("a tool that always says yes destroys learning").
	 */
	routeStats?: () => RouteStats[];
	/**
	 * 按需检索这一局的记忆快照（M4a，SPEC §10.89）。
	 *
	 * **缺席 = 本局没有记忆**（例如 `--no-memory` 的控制臂）。工具必须据此**具名拒绝**，
	 * 而不是返回空成功——否则控制臂会静默地"有记忆但没内容"，两臂之差就不再干净（D4）。
	 */
	recall?: (q: { query?: string; limit?: number }) => { id: string; line: string }[];
	/** 每次检索的记账（落到审计：让"记忆有没有被用"成为可查事实）。 */
	onRecall?: (r: { query: string | null; hits: number; ids: string[] }) => void;
	/**
	 * agent **自己**通过 `set_pause` 改了游戏的暂停状态。
	 *
	 * 为什么需要它（2026-09-23 真实事故）：一个长跑的**最后一次决策**就是 `set_pause`，
	 * 游戏从此冻结、循环再没跑过 5 小时；而页面上只写 `paused`，看不出是"agent 自己停的"
	 * 还是"人按的按钮"。**谁让它停的是一个独立事实**，必须被记录并呈现——
	 * 否则 owner 按 Pause 时状态早已是 paused，只会更困惑。
	 */
	onPauseChanged?: (paused: boolean, at: number) => void;
}

/** Structured result payload carried in AgentToolResult.details. */
export interface ActionResult {
	/** Machine-readable status. */
	ok: boolean;
	/** Short human/LLM-readable summary (goes into the tool result content). */
	summary: string;
	/** Optional structured details (job id, params echoed, etc.). */
	data?: Record<string, unknown>;
}

/**
 * A decision the LLM produced for one decision point (SPEC §4.2 step 2).
 * Validated before any command is sent.
 */
export interface AgentPlan {
	goal: string;
	plan: string[];
	/** Tool call the agent wants to make now, if any. */
	immediate_action?: { tool: string; args: Record<string, unknown> };
	/** Observation gate: wait until this is true before re-deciding. */
	wait_until?: string;
	rationale?: string;
}
