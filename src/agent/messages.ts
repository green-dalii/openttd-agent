/**
 * Agent layer — custom AgentMessage declarations (SPEC §4.1).
 *
 * 职责: 通过 declaration merging 向 pi-agent-core 的 AgentMessage 联合类型加入
 *   本项目自定义消息（判决审计/UI 可见，LLM 上下文里按需过滤）。
 * 事实来源: SPEC §4.1「AgentMessage 声明合并」；pi-agent-core README Custom
 *   Message Types 示例（module 名必须是包名 "@earendil-works/pi-agent-core"）。
 * 禁止: 在此声明真实 LLM 消息类型（那由 pi-ai 提供）；禁止副作用。
 */

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		/** A rich state snapshot handed to the LLM at a decision point. */
		game_observation: {
			role: "game_observation";
			/** In-game date label, e.g. "1950-03". */
			date: string;
			/** Compact, LLM-facing state summary (JSON-safe plain object). */
			state: Record<string, unknown>;
			timestamp: number;
		};
		/** Outcome of an executed action (mirrors a tool result for audit). */
		action_result: {
			role: "action_result";
			tool: string;
			ok: boolean;
			summary: string;
			data?: Record<string, unknown>;
			timestamp: number;
		};
	}
}
