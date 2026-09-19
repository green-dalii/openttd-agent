/**
 * Agent runtime — assemble a pi-agent-core Agent for OpenTTD (SPEC §4.1).
 *
 * 职责: 装配 Agent(streamFn + tools + convertToLlm + transformContext) 并把
 *   决策循环需要的 hooks（beforeToolCall 预检 / afterToolCall 审计）接好。
 *   streamFn 由调用方注入 —— 生产用真实 provider，测试用 pi-ai 的 faux provider
 *   （见 test/unit/agent-runtime.test.ts），因此本模块单测不触网。
 * 事实来源: SPEC §4.1-§4.2；pi-agent-core AgentOptions/AgentState；ADR §10.74。
 * 禁止: 在此直接创建网络 provider；禁止等待施工完成（异步由 loop 编排）。
 *
 * R1（2026-09-18，ADR §10.74 "库的默认值不是契约"）在这里补了三件库已提供、
 * 而框架原先没用的事：
 *   1. **每决策工具预算**：`beforeToolCall` 是唯一能让模型"看到拒绝理由"的位置，
 *      实测出现过 193 次工具调用/局（17.5 次/决策，正常 2–3）；
 *   2. **`sessionId`**：provider 提示缓存（每决策 15–56k tokens）；
 *   3. **deliberation 档位**（`thinkingLevel`/`thinkingBudgets`）：默认保持 "off"，
 *      以便"有无 deliberation"能被当作可测变量。
 * 变更型工具的**执行顺序**由工具自己声明 `executionMode:"sequential"`（见 tools/index.ts）——
 * 游戏按 FIFO 应用命令，并发会打乱台账顺序。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Model, ThinkingBudgets, ThinkingLevel } from "@earendil-works/pi-ai";
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
	/**
	 * Session id forwarded to providers for prompt caching (pi-agent-core `sessionId`).
	 * One id per game run: the system prompt + tool schemas are re-sent on every
	 * decision, so a cache-aware provider can reuse them.
	 */
	sessionId?: string;
	/**
	 * Max tool calls allowed inside ONE decision (a prompt and its answer).
	 * Measured: normal decisions use 2–3; one pathological run used 17.5 per
	 * decision across 193 calls and burned 82% of its arm's tokens. Default 12
	 * leaves room for genuine exploration but cuts a runaway short.
	 */
	maxToolCallsPerDecision?: number;
	/** Deliberation level; `"off"` (default) preserves pre-R1 behaviour. */
	thinkingLevel?: ThinkingLevel;
	thinkingBudgets?: ThinkingBudgets;
}

/** Normal decisions use 2–3 tool calls; a runaway measured 17.5 per decision. */
export const DEFAULT_MAX_TOOL_CALLS_PER_DECISION = 12;

/** Convert agent messages → LLM messages: drop UI-only custom messages. */
export function defaultConvertToLlm(messages: AgentMessage[]) {
	return messages.filter((m) => {
		const role = (m as { role?: string }).role;
		// game_observation / action_result are audit/UI-only for now: the LLM
		// sees their effect through tool results, not raw history replay.
		return role !== "game_observation" && role !== "action_result";
	}) as never;
}

/** Handle returned by `createAgent`: the agent plus what telemetry needs from the runtime. */
export interface AgentRuntime {
	agent: Agent;
	tools: AgentTool[];
	/**
	 * Tool calls refused because the per-decision budget was exhausted.
	 * Reported so a run can never silently degrade into "the agent stopped
	 * exploring" without the experiment seeing it (SPEC §10.66 channel health).
	 */
	getBudgetBlocks(): number;
}

/** Build the tools + Agent for a run. */
export function createAgent(opts: RuntimeOptions): AgentRuntime {
	const tools = createTools(opts.deps);
	const budget = opts.maxToolCallsPerDecision ?? DEFAULT_MAX_TOOL_CALLS_PER_DECISION;
	let callsThisDecision = 0;
	let budgetBlocks = 0;

	const agent = new Agent({
		streamFn: opts.streamFn,
		convertToLlm: defaultConvertToLlm,
		transformContext: opts.transformContext,
		// Provider prompt cache key (ADR §10.74): stable per run.
		sessionId: opts.sessionId,
		thinkingBudgets: opts.thinkingBudgets,
		initialState: {
			systemPrompt: opts.systemPrompt ?? SYSTEM_PROMPT,
			model: opts.model,
			thinkingLevel: opts.thinkingLevel ?? "off",
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
			// Per-decision budget. Blocking (not throwing) is the point: the reason
			// is handed to the model as a tool error, so it can still decide with
			// the observations it already has. Blocked calls do not consume budget.
			if (budget > 0 && callsThisDecision >= budget) {
				budgetBlocks += 1;
				return {
					block: true,
					reason:
						`tool budget for this decision is exhausted (${budget} calls used). ` +
						"Further tool calls in this decision are refused. Answer with the " +
						"observations you already have; you get a fresh budget next decision.",
				};
			}
			callsThisDecision += 1;
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

	// One decision = one prompt→answer. `agent_start` is emitted once per run
	// before any tool preflight, so the budget resets exactly at that boundary
	// without the caller having to remember to do it.
	agent.subscribe((event) => {
		if (event.type === "agent_start") callsThisDecision = 0;
	});

	return { agent, tools, getBudgetBlocks: () => budgetBlocks };
}
