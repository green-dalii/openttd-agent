/**
 * Unit tests — agent runtime + decision loop, driven by pi-ai's FAUX provider.
 * No network, no game: proves the wiring (tools + convertToLlm + tool exec)
 * works end-to-end at the type/runtime level.
 * 事实来源: SPEC §4.1-§4.2; pi-ai providers/faux.
 */
import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createTools } from "../../src/agent/tools/index.js";
import { createAgent, defaultConvertToLlm, SYSTEM_PROMPT } from "../../src/agent/runtime.js";
import { runDecision, runDecisionLoop } from "../../src/agent/loop.js";
import type { AgentDeps, CommandSink, StateReader } from "../../src/agent/types.js";
import { emptyTracker, recordAction, recordPhase } from "../../src/agent/decision-context.js";
import type { WorldSnapshot } from "../../src/game/world-state.js";

function fakeDeps() {
	const gameScript: string[] = [];
	const rcon: string[] = [];
	// Fake game answers rcon (2026-09-17: the channel exists, so tools can observe
	// their effect; without it set_pause honestly reports "unconfirmed").
	const sink: CommandSink = {
		gameScript: (j) => gameScript.push(j),
		rcon: (c) => rcon.push(c),
		rconAwait: async (c: string) => {
			rcon.push(c);
			return "ok";
		},
	};
	const state: StateReader = {
		snapshot: (): WorldSnapshot => ({
			date: { raw: 712223, year: 1950, month: 3, day: 1 },
			companies: new Map(),
			recent: [],
			totalEvents: 0, towns: [],
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
	it("installs the seven tools and the default system prompt", () => {
		const { deps } = fakeDeps();
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("hi")]);
		const { agent } = createAgent({ deps, streamFn: faux.streamSimple, model: faux.getModel() });
		expect(agent.state.tools.map((t) => t.name)).toEqual([
			"observe",
			"estimate_route",
			"inspect_route",
			"build_bus_route",
			"set_route_vehicles",
			"retire_route",
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

/**
 * R1 — 与 pi-agent-core 的协同（ADR 见 SPEC §10.74）。
 *
 * 三条都是"库已提供、而我们没用"的机制，其中第一条是**领域不变量**：
 *  - `executionMode`：游戏按 FIFO 应用命令（SPEC §10.39.1），两个变更命令并发执行
 *    会让台账记录顺序 ≠ 实际应用顺序，归因链断掉；
 *  - 每决策工具预算：实测有一局做出 193 次工具调用 / 17.5 次每决策（正常 2–3）；
 *  - `sessionId`：provider 提示缓存（每决策 15–56k tokens）。
 */
describe("R1: pi-agent-core 协同（执行顺序 / 工具预算 / provider 缓存）", () => {
	/** 展平 toolResult 的文本内容，用于断言"模型看到了什么"。 */
	function resultTexts(messages: readonly { role?: string }[]): string[] {
		const out: string[] = [];
		for (const m of messages) {
			if (m.role !== "toolResult") continue;
			const content = (m as { content?: unknown }).content;
			if (typeof content === "string") out.push(content);
			else if (Array.isArray(content)) {
				for (const c of content) {
					const t = (c as { text?: unknown }).text;
					if (typeof t === "string") out.push(t);
				}
			}
		}
		return out;
	}

	it("变更型工具声明 sequential 执行模式（只读工具不受影响）", () => {
		const { deps } = fakeDeps();
		const mode = (n: string) => createTools(deps).find((t) => t.name === n)?.executionMode;
		expect(mode("build_bus_route")).toBe("sequential");
		expect(mode("set_route_vehicles")).toBe("sequential");
		expect(mode("set_pause")).toBe("sequential");
		// 读型工具不会改变世界，并发读没有顺序问题
		expect(mode("observe")).not.toBe("sequential");
		expect(mode("estimate_route")).not.toBe("sequential");
		expect(mode("inspect_route")).not.toBe("sequential");
	});

	it("同一条助手消息里的两个变更命令串行执行（并发会打乱台账顺序）", async () => {
		const trace: string[] = [];
		const { deps } = fakeDeps();
		deps.sink.rconAwait = async (c: string) => {
			trace.push(`start:${c}`);
			await new Promise((r) => setTimeout(r, 20));
			trace.push(`end:${c}`);
			return "ok";
		};
		// 两条 set_pause 在**同一条**助手消息里：并发执行会得到 start,start,end,end
		const { agent } = fauxAgent(deps, [
			fauxAssistantMessage([
				fauxToolCall("set_pause", { paused: true }),
				fauxToolCall("set_pause", { paused: false }),
			]),
			fauxAssistantMessage("done"),
		]);
		await agent.prompt("decide");
		expect(trace).toEqual(["start:pause", "end:pause", "start:unpause", "end:unpause"]);
	});

	it("每决策工具预算耗尽后拒绝，并把理由交给模型", async () => {
		const { deps, rcon } = fakeDeps();
		const faux = createFauxCore({});
		faux.setResponses([
			// 同一条消息里连续三次命令，预算只有 1
			fauxAssistantMessage([
				fauxToolCall("set_pause", { paused: true }),
				fauxToolCall("set_pause", { paused: false }),
				fauxToolCall("set_pause", { paused: true }),
			]),
			fauxAssistantMessage("done"),
		]);
		const { agent, getBudgetBlocks } = createAgent({
			deps,
			streamFn: faux.streamSimple,
			model: faux.getModel(),
			maxToolCallsPerDecision: 1,
		});
		await agent.prompt("decide");
		expect(rcon).toHaveLength(1); // 只有预算内的那一次真的发出去了
		expect(getBudgetBlocks()).toBe(2);
		const texts = resultTexts(agent.state.messages as Array<{ role?: string }>);
		expect(texts.some((t) => /budget/i.test(t))).toBe(true);
	});

	it("下一次决策会重置预算", async () => {
		const { deps, rcon } = fakeDeps();
		const faux = createFauxCore({});
		// 两次 prompt，各发一条命令：预算 1 也必须两次都放行
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("set_pause", { paused: true })]),
			fauxAssistantMessage("first"),
			fauxAssistantMessage([fauxToolCall("set_pause", { paused: false })]),
			fauxAssistantMessage("second"),
		]);
		const { agent, getBudgetBlocks } = createAgent({
			deps,
			streamFn: faux.streamSimple,
			model: faux.getModel(),
			maxToolCallsPerDecision: 1,
		});
		await agent.prompt("decide 1");
		await agent.prompt("decide 2");
		expect(rcon).toHaveLength(2);
		expect(getBudgetBlocks()).toBe(0);
	});

	it("sessionId 透传给 Agent（provider 提示缓存）与 deliberation 档位", () => {
		const { deps } = fakeDeps();
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage("hi")]);
		const { agent } = createAgent({
			deps,
			streamFn: faux.streamSimple,
			model: faux.getModel(),
			sessionId: "run-42",
			thinkingLevel: "low",
		});
		expect(agent.sessionId).toBe("run-42");
		expect(agent.state.thinkingLevel).toBe("low");
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
		const { state, plan } = await runDecision(agent, deps, { trigger: "start", tracker: emptyTracker() });
		expect(state.date).toBe("1950-03-01");
		expect(agent.state.messages[0]!.role).toBe("game_observation");
		// A prose-only reply has no structured plan; that must be tolerated.
		expect(plan).toBeNull();
	});

	it("hands the model facts and causality, and gives it no advice", async () => {
		// The framework must not steer: the prompt carries observations only.
		const { deps } = fakeDeps();
		const { agent } = fauxAgent(deps, [fauxAssistantMessage([fauxText("ok")])]);
		const tracker = emptyTracker({ money: 1000, income: -10, vehicles: 0, stations: 0, gameDay: 0 });
		recordPhase(tracker, "EX hb road #1");
		recordAction(tracker, { tool: "build_bus_route", ok: true, summary: "sent" });

		await runDecision(agent, deps, { trigger: "phase_change", tracker, gameDay: 90, history: ["earlier"] });

		// The prompt is the last *user* message (the tail is the model's reply).
		const msgs = agent.state.messages as { role: string; content: unknown }[];
		const user = [...msgs].reverse().find((m) => m.role === "user")!;
		const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
		expect(text).toContain("phase_change");
		// The executor phase reaches the model DECODED. The old assertion here
		// demanded the raw telegraph string "EX hb road #1", which meant the
		// model was handed a grammar that exists only in the Squirrel source.
		expect(text).toContain("still working on");
		expect(text).not.toContain("EX hb road");
		expect(text).toContain("build_bus_route");
		expect(text).toContain("elapsedGameDays");
		// No steering language anywhere.
		const lower = text.toLowerCase();
		for (const banned of ["you should", "recommend", "suggest", "if construction is still", "just report"]) {
			expect(lower, `advice leaked into prompt: "${banned}"`).not.toContain(banned);
		}
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

describe("structured plan extraction (SPEC §4.2 step 2)", () => {
	it("recovers the plan JSON the model produced", async () => {
		const { deps } = fakeDeps();
		const { agent } = fauxAgent(deps, [
			fauxAssistantMessage([
				fauxText(
					'Considering cash. {"goal":"restore profitability","plan":["add buses"],' +
						'"immediate_action":"set_route_vehicles","wait_until":{"game_days":30},"rationale":"income negative"}',
				),
			]),
		]);
		const { plan } = await runDecision(agent, deps, { trigger: "interval", tracker: emptyTracker() });
		expect(plan).not.toBeNull();
		expect(plan!.goal).toBe("restore profitability");
		expect(plan!.plan).toEqual(["add buses"]);
		expect(plan!.wait_until).toEqual({ game_days: 30 });
	});

	it("asks for the structured decision without dictating its content", async () => {
		const { deps } = fakeDeps();
		const { agent } = fauxAgent(deps, [fauxAssistantMessage("ok")]);
		await runDecision(agent, deps, { trigger: "start", tracker: emptyTracker() });
		const msgs = agent.state.messages as { role: string; content: unknown }[];
		const user = [...msgs].reverse().find((m) => m.role === "user")!;
		const text = typeof user.content === "string" ? user.content : JSON.stringify(user.content);
		// The interface is specified...
		for (const key of ["goal", "plan", "immediate_action", "wait_until", "rationale"]) {
			expect(text).toContain(key);
		}
		// ...but the framework never suggests what to do.
		const lower = text.toLowerCase();
		for (const banned of ["you should", "recommend", "suggest", "best to", "make sure to"]) {
			expect(lower, `advice leaked: "${banned}"`).not.toContain(banned);
		}
	});

	it("returns null rather than throwing on a malformed plan", async () => {
		const { deps } = fakeDeps();
		const { agent } = fauxAgent(deps, [fauxAssistantMessage([fauxText('{"goal": "unclosed')])]);
		const { plan } = await runDecision(agent, deps, { trigger: "start", tracker: emptyTracker() });
		expect(plan).toBeNull();
	});

	it("ignores an echoed observation that is not a plan", async () => {
		const { deps } = fakeDeps();
		const { agent } = fauxAgent(deps, [
			fauxAssistantMessage([fauxText('State was {"date":"1950-01-01","totalEvents":3}')]),
		]);
		const { plan } = await runDecision(agent, deps, { trigger: "start", tracker: emptyTracker() });
		expect(plan).toBeNull();
	});
});

describe("harness boundary: 框架不替 agent 做决定", () => {
	// 用户的明确要求（2026-09-12）:
	//   "不要把经验、教训内化到 Harness 中……经验教训要让 agent 自主探索和学习"。
	//
	// 边界怎么划:
	//   ✅ 工具/子系统的**契约与前提**（"本工具靠克隆头车扩容"）——像函数签名一样必须知道
	//   ✅ **世界事实与因果**（"施工是异步的"、"贷款产生利息"）——SPEC §4.2 要求框架给
	//   ✅ **交互协议**（输出 JSON 的键、何时该让出回合）——框架拥有协议
	//   ❌ **策略**（"你应该…"、"优先…"、"队列长了就加车"）——那是 agent 该自己学的东西
	//
	// 为什么必须机械守卫:策略句子读起来很合理,写进去时几乎无感,但它们把
	// **agent 的探索空间直接删掉**——被剧透的 agent 不会去试错,也就没有可学的教训。

	const STRATEGY_MARKERS: [RegExp, string][] = [
		[/\byou should\b/i, "you should"],
		[/\byou must\b/i, "you must"],
		[/\brecommend/i, "recommend"],
		[/\bsuggest/i, "suggest"],
		[/\bprefer\b/i, "prefer"],
		[/\bbest to\b/i, "best to"],
		[/\bmake sure to\b/i, "make sure to"],
		[/\bavoid (?:building|issuing|using)/i, "avoid building/issuing/using"],
		[/\btry to\b/i, "try to"],
		[/\bdo not (?:issue|repeat|build|add)\b/i, "do not <action>"],
		[/\bonly then\b/i, "only then"],
	];

	function assertNoStrategy(where: string, text: string) {
		for (const [re, label] of STRATEGY_MARKERS) {
			expect(re.test(text), `${where}: strategy leaked ("${label}") -> ${text.slice(0, 160)}`).toBe(false);
		}
	}

	it("SYSTEM_PROMPT 只给角色/世界事实/协议，不含策略", () => {
		assertNoStrategy("SYSTEM_PROMPT", SYSTEM_PROMPT);
	});

	it("SYSTEM_PROMPT 仍然给出必要的事实与协议", () => {
		// The guard must not be satisfiable by deleting everything useful.
		expect(SYSTEM_PROMPT).toMatch(/asynchronous/i);
		expect(SYSTEM_PROMPT).toMatch(/money|loan/i);
	});

	/**
	 * M2（2026-09-19）：**计分规则是一个事实**，必须告诉 agent。
	 *
	 * 事故：提示词写着 "build profitable transport routes"，而实验判据是
	 * `deliveredRun`（运货量）。实测 106 局里 `income>0` 的只有 9 局——
	 * **目标通常不可达**，于是 agent 长期在为一件做不到的事优化，
	 * 而"它在为什么优化"与"我们在量什么"根本不匹配。
	 *
	 * 说明这是**事实**而不是策略：它描述的是"本项目如何评分"（环境的一部分），
	 * 不告诉 agent 该怎么玩。策略仍然要靠它自己试出来。
	 */
	it("把计分规则作为事实写出来（目标与判据同源）", () => {
		expect(SYSTEM_PROMPT).toMatch(/delivered per game day|deliveries per game day|cargo delivered/i);
		// 不再宣称一个窗口内通常不可达的目标（"profitable"）
		expect(SYSTEM_PROMPT).not.toMatch(/build profitable/i);
		// 但必须如实说明施工期收入为负这个**会计事实**
		expect(SYSTEM_PROMPT).toMatch(/income.*(negative|loss)|negative while/i);
	});

	it("每个工具的 description 不含策略", () => {
		const tools = createTools(fakeDeps().deps);
		expect(tools.length).toBeGreaterThan(0);
		for (const t of tools) {
			assertNoStrategy(`tool "${t.name}" description`, String(t.description ?? ""));
		}
	});

	it("工具的失败/拒绝信息只陈述原因，不给建议", async () => {
		// The refusal message is where advice sneaks in most easily: it is written
		// at the exact moment we know what the "right" next move is.
		const { deps } = fakeDeps();
		// Drive the tool with a world state that HAS the company (0 vehicles), which is
		// the case that matters: the refusal must state the contract, not give advice.
		const withCompany = {
			...deps,
			state: {
				snapshot: () => ({
					date: { raw: 1, year: 1950, month: 9, day: 1 },
					companies: new Map([
						[0, { info: { id: 0, name: "EX rd", isAi: true }, stats: { vehicles: 0, stations: 2 } }],
					]) as never,
					recent: [],
					totalEvents: 0, towns: [],
				}),
			},
		};
		const tools = createTools(withCompany);
		const add = tools.find((t) => t.name === "set_route_vehicles")!;
		const res = await add.execute("c1", { count: 1 });
		const summary = String((res as { details?: { summary?: string } }).details?.summary ?? "");
		assertNoStrategy("add_vehicles refusal", summary);
		// ...but it must still state the contract fact that makes it impossible.
		expect(summary).toMatch(/clone/i);
	});
});
