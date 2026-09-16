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
