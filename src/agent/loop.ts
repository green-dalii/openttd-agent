/**
 * Agent decision loop — orchestrate decision points (SPEC §4.2).
 *
 * 职责: 在「决策点」（默认每 N 游戏月）采集状态 → 构造 game_observation →
 *   交给 pi-agent-core Agent 决策 → 校验 → 执行/等待 → 记录审计。
 *   与施工的异步性匹配: 一轮决策后让出（shouldStopAfterTurn 由 prompt 边界
 *   自然实现），由调用方在下一个决策点再次驱动。
 * 事实来源: SPEC §4.2（决策循环细粒度）、§4.1（hooks）。
 * 禁止: 阻塞等待施工完成；在此模块直接触网（provider 由 runtime 注入）。
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentDeps } from "./types.js";
import { summarizeState } from "./tools/index.js";

export interface DecisionLoopOptions {
	agent: Agent;
	deps: AgentDeps;
	/** Max decisions to run before returning (safety bound). */
	maxTurns?: number;
	/** Called after each decision turn for logging/audit. */
	onTurn?: (info: { turn: number; state: Record<string, unknown> }) => void;
}

export interface DecisionLoopResult {
	turns: number;
	/** Final observation the loop saw. */
	lastState: Record<string, unknown>;
}

/**
 * Run one decision: build a game_observation message and prompt the agent.
 * The agent will call tools (observe/build_bus_route/...) as it sees fit; its
 * tool calls go through the injected CommandSink (async, non-blocking).
 */
export async function runDecision(agent: Agent, deps: AgentDeps): Promise<Record<string, unknown>> {
	const state = summarizeState(deps.state.snapshot());
	const observation = {
		role: "game_observation" as const,
		date: String(state.date ?? "unknown"),
		state,
		timestamp: Date.now(),
	};
	// The observation is audit/UI; the LLM prompt carries the actionable ask.
	const prompt =
		`Decision point. Current game state: ${JSON.stringify(state)}\n\n` +
		`Decide what to do next. Use observe() if you need fresh numbers, then act ` +
		`(build_bus_route / add_vehicles / set_pause). If construction is still in ` +
		`progress, just report that and end your turn.`;
	agent.state.messages = [...agent.state.messages, observation];
	await agent.prompt(prompt);
	return state;
}

/**
 * Drive up to `maxTurns` decisions. Each turn is one observation→prompt cycle;
 * because construction is asynchronous, the caller normally drives one turn
 * per decision point (e.g. per game month) rather than looping tightly.
 */
export async function runDecisionLoop(opts: DecisionLoopOptions): Promise<DecisionLoopResult> {
	const maxTurns = opts.maxTurns ?? 1;
	let turns = 0;
	let lastState: Record<string, unknown> = {};
	for (let i = 0; i < maxTurns; i++) {
		lastState = await runDecision(opts.agent, opts.deps);
		turns++;
		opts.onTurn?.({ turn: turns, state: lastState });
	}
	return { turns, lastState };
}
