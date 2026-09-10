/**
 * Unit tests — agent runtime + decision loop, driven by pi-ai's FAUX provider.
 * No network, no game: proves the wiring (tools + convertToLlm + tool exec)
 * works end-to-end at the type/runtime level.
 * 事实来源: SPEC §4.1-§4.2; pi-ai providers/faux.
 */
import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgent, defaultConvertToLlm, SYSTEM_PROMPT } from "../../src/agent/runtime.js";
import { runDecision, runDecisionLoop } from "../../src/agent/loop.js";
import type { AgentDeps, CommandSink, StateReader } from "../../src/agent/types.js";
import type { WorldSnapshot } from "../../src/game/world-state.js";

function fakeDeps() {
	const gameScript: string[] = [];
	const rcon: string[] = [];
	const sink: CommandSink = { gameScript: (j) => gameScript.push(j), rcon: (c) => rcon.push(c) };
	const state: StateReader = {
		snapshot: (): WorldSnapshot => ({
			date: { raw: 712223, year: 1950, month: 3, day: 1 },
			companies: new Map(),
			recent: [],
			totalEvents: 0,
		}),
	};
	const deps: AgentDeps = { sink, state };
	return { deps, gameScript, rcon };
}

function fauxAgent(deps: AgentDeps, responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
	const faux = createFauxCore({});
	faux.setResponses(responses);
	const { agent } = createAgent({ deps, streamFn: faux.streamSimple, model: faux.getModel() });
	return { agent, faux };
}

describe("createAgent", () => {
	it("installs the four tools and the default system prompt", () => {
		const { deps } = fakeDeps();
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("hi")]);
		const { agent } = createAgent({ deps, streamFn: faux.streamSimple, model: faux.getModel() });
		expect(agent.state.tools.map((t) => t.name)).toEqual([
			"observe",
			"build_bus_route",
			"add_vehicles",
			"set_pause",
		]);
		expect(agent.state.systemPrompt).toBe(SYSTEM_PROMPT);
	});

	it("executes an LLM tool call through the injected CommandSink", async () => {
		const { deps, gameScript } = fakeDeps();
		// Turn 1: LLM calls build_bus_route. Turn 2: LLM finishes with text.
		const { agent } = fauxAgent(deps, [
			fauxAssistantMessage([fauxToolCall("build_bus_route", { from_town: 6, to_town: 18 })]),
			fauxAssistantMessage("route requested"),
		]);
		await agent.prompt("decide");
		expect(gameScript).toHaveLength(1);
		expect(JSON.parse(gameScript[0]!)).toEqual({
			cmd: "build_bus_route",
			company: 0,
			townA: 6,
			townB: 18,
		});
	});

	it("blocks unknown tools via beforeToolCall", async () => {
		const { deps } = fakeDeps();
		const { agent } = fauxAgent(deps, [
			fauxAssistantMessage([fauxToolCall("does_not_exist", {})]),
			fauxAssistantMessage("ok"),
		]);
		await agent.prompt("decide");
		// No throw; the block produced a tool result. Nothing was sent.
		const toolResults = agent.state.messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThanOrEqual(1);
	});

	it("fires onActionResult after a successful tool call", async () => {
		const { deps } = fakeDeps();
		const seen: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("set_pause", { paused: true })]),
			fauxAssistantMessage("paused"),
		]);
		const { agent } = createAgent({
			deps,
			streamFn: faux.streamSimple,
			model: faux.getModel(),
			onActionResult: (tool, r) => seen.push(`${tool}:${r.ok}`),
		});
		await agent.prompt("decide");
		expect(seen).toEqual(["set_pause:true"]);
	});
});

describe("defaultConvertToLlm", () => {
	it("drops UI-only custom messages but keeps LLM messages", () => {
		const kept = defaultConvertToLlm([
			{ role: "user", content: "hi" } as never,
			{ role: "game_observation", date: "1950-03", state: {}, timestamp: 1 } as never,
			{ role: "action_result", tool: "observe", ok: true, summary: "s", timestamp: 2 } as never,
		] as never);
		expect((kept as Array<{ role: string }>).map((m) => m.role)).toEqual(["user"]);
	});
});

describe("runDecision / runDecisionLoop", () => {
	it("prepends a game_observation and prompts the agent", async () => {
		const { deps } = fakeDeps();
		const { agent } = fauxAgent(deps, [fauxAssistantMessage([fauxText("nothing to do")])]);
		const state = await runDecision(agent, deps);
		expect(state.date).toBe("1950-03-01");
		expect(agent.state.messages[0]!.role).toBe("game_observation");
	});

	it("loop runs the requested number of turns and reports state", async () => {
		const { deps } = fakeDeps();
		const { agent } = fauxAgent(deps, [
			fauxAssistantMessage("t1"),
			fauxAssistantMessage("t2"),
		]);
		const turns: number[] = [];
		const res = await runDecisionLoop({ agent, deps, maxTurns: 2, onTurn: (i) => turns.push(i.turn) });
		expect(res.turns).toBe(2);
		expect(turns).toEqual([1, 2]);
		expect(res.lastState.date).toBe("1950-03-01");
	});
});
