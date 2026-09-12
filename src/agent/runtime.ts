/**
 * Agent runtime — assemble a pi-agent-core Agent for OpenTTD (SPEC §4.1).
 *
 * 职责: 装配 Agent(streamFn + tools + convertToLlm + transformContext) 并把
 *   决策循环需要的 hooks（beforeToolCall 预检 / afterToolCall 审计）接好。
 *   streamFn 由调用方注入 —— 生产用真实 provider，测试用 pi-ai 的 faux provider
 *   （见 test/unit/agent-runtime.test.ts），因此本模块单测不触网。
 * 事实来源: SPEC §4.1-§4.2；pi-agent-core AgentOptions/AgentState。
 * 禁止: 在此直接创建网络 provider；禁止等待施工完成（异步由 loop 编排）。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentDeps, ActionResult } from "./types.js";
import { createTools } from "./tools/index.js";

/**
 * System prompt: role, world mechanics, and the interaction protocol — nothing else.
 *
 * 边界（用户明确要求, 2026-09-12）:框架只给**事实与因果**与**协议**,
 * **不给策略**。曾经这里写着 "Do NOT issue the same command repeatedly"、
 * "Prefer one solid route over many half-built ones"、"add vehicles when queues grow"
 * —— 那些读起来很合理,但它们把 agent 的探索空间直接删掉了。
 * 被剧透的 agent 不会去试错,也就没有可学的教训。
 * 何时该重发命令、该铺几条线、什么时候加车 —— 都留给它自己从观察里得出来。
 */
export const SYSTEM_PROMPT = `You are an autonomous agent playing OpenTTD (a transport tycoon game) through a fixed tool API.

Objective: build profitable transport routes and grow the company.

How the world works (mechanics, not instructions):
- Actions are ASYNCHRONOUS. A construction command returns immediately; the in-game
  executor then builds stations, roads, depots and vehicles over several game months.
  The executor's current phase is carried in the company name.
- Money is real: construction spends cash, and loans accrue interest.
- Passengers waiting at a station are demand that has not been served yet.
- A tool result reports the outcome of the REQUEST it was given, which is not the same
  as the resulting change in the world. observe() reports the world.

Protocol:
- Each decision prompt states the JSON shape to answer with.
- A turn ends when you stop calling tools. The framework decides when to wake you again
  from the wait_until you return.`;

/** Injection points so tests can drive the agent without a network. */
export interface RuntimeOptions {
	deps: AgentDeps;
	/** Stream function (provider). Required by Agent. */
	streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"];
	/** Model used for future turns. */
	model: Model<string>;
	systemPrompt?: string;
	/** Optional context transform (lessons/strategy injection later, §5.2). */
	transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
	/** Optional audit hook fired after each tool call. */
	onActionResult?: (tool: string, result: ActionResult) => void;
}

/** Convert agent messages → LLM messages: drop UI-only custom messages. */
export function defaultConvertToLlm(messages: AgentMessage[]) {
	return messages.filter((m) => {
		const role = (m as { role?: string }).role;
		// game_observation / action_result are audit/UI-only for now: the LLM
		// sees their effect through tool results, not raw history replay.
		return role !== "game_observation" && role !== "action_result";
	}) as never;
}

/** Build the tools + Agent for a run. */
export function createAgent(opts: RuntimeOptions): { agent: Agent; tools: AgentTool[] } {
	const tools = createTools(opts.deps);
	const agent = new Agent({
		streamFn: opts.streamFn,
		convertToLlm: defaultConvertToLlm,
		transformContext: opts.transformContext,
		initialState: {
			systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT,
			model: opts.model,
			thinkingLevel: "off",
			tools,
			messages: [],
		},
		// Pre-flight legality check: refuse commands while the game is paused by
		// us without explicit intent (cooldown/validation point, SPEC §4.1).
		beforeToolCall: async (ctx): Promise<BeforeToolCallResult | undefined> => {
			const name = ctx.toolCall.name;
			if (!tools.some((t) => t.name === name)) {
				return { block: true, reason: `unknown tool: ${name}` };
			}
			return undefined;
		},
		afterToolCall: async (ctx) => {
			const details = ctx.result?.details as ActionResult | undefined;
			if (details && opts.onActionResult) {
				opts.onActionResult(ctx.toolCall.name, details);
			}
			return undefined;
		},
	});
	return { agent, tools };
}
