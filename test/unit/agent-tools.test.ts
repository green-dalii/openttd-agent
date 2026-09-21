/**
 * Unit tests — agent tools (pure logic, no network/game).
 * 事实来源: SPEC §4.3; src/agent/tools/index.ts contracts.
 */
import { describe, expect, it } from "vitest";
import { ACTION_EFFECTS } from "../../src/agent/tools/catalog.js";
import {
	recallTool,
	retireRouteTool,
	setRouteVehiclesTool,
	buildBusRouteTool,
	createTools,
	inspectRouteTool,
	observeTool,
	setPauseTool,
	summarizeState,
} from "../../src/agent/tools/index.js";
import type { AgentDeps, CommandSink, StateReader } from "../../src/agent/types.js";
import type { WorldSnapshot } from "../../src/game/world-state.js";

function fakeSink() {
	const rcon: string[] = [];
	const gameScript: string[] = [];
	const sink: CommandSink = {
		rcon: (c) => rcon.push(c),
		gameScript: (j) => gameScript.push(j),
	};
	return { sink, rcon, gameScript };
}

/** The text the model actually reads (toResult puts the summary in content[0]). */
function textOf(res: unknown): string {
	const c = (res as { content?: { text?: string }[] }).content;
	return c?.[0]?.text ?? "";
}

function fakeState(snap: Partial<WorldSnapshot> = {}): StateReader {
	return {
		snapshot: () => ({
			date: { raw: 712223, year: 1950, month: 3, day: 1 },
			companies: new Map(),
			recent: [],
			totalEvents: 0,
			towns: [],
			...snap,
		}),
	};
}

function deps(over: Partial<AgentDeps> = {}): AgentDeps {
	const { sink } = fakeSink();
	return { sink, state: fakeState(), ...over };
}

describe("summarizeState", () => {
	it("formats date and empty companies", () => {
		const out = summarizeState({
			date: { raw: 0, year: 1950, month: 3, day: 1 },
			companies: new Map(),
			recent: [],
			totalEvents: 0,
		towns: [],
		});
		expect(out.date).toBe("1950-03-01");
		expect(out.companies).toEqual([]);
	});

	it("decodes signed income from u64 (negatives must not show as huge u64)", () => {
		const negIncome = BigInt.asUintN(64, -21583n); // stored as u64
		const out = summarizeState({
			date: null,
			companies: new Map([
				[
					0,
					{
						info: { id: 0, name: "EX", isAi: true, inauguratedYear: 1950 } as never,
						economy: {
							id: 0,
							money: 277000n,
							loan: 300000n,
							income: negIncome,
							deliveredCargo: 0,
							companyValue: 0n,
							performanceLastYear: 0,
							performancePrevYear: 0,
						} as never,
						stats: { id: 0, vehicles: 3, stations: 2 } as never,
						lastEconomyAt: null,
						history: [],
						deliveredRun: { total: null, missing: 0, quarterChanges: 0, gaps: 0, complete: false },
					},
				],
			]),
			recent: [],
			totalEvents: 0,
		towns: [],
		});
		const c = (out.companies as Array<Record<string, unknown>>)[0]!;
		expect(c.income).toBe("-21583");
		expect(c.money).toBe("277000");
		expect(c.vehicles).toBe(3);
		expect(c.stations).toBe(2);
	});
});

describe("build_bus_route tool", () => {
	it("sends the command with company + optional towns", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = buildBusRouteTool({ sink, state: fakeState() });
		const res = await tool.execute("c1", { from_town: 6, to_town: 18, company: 0, job: 101 });
		expect(gameScript).toHaveLength(1);
		const sent = JSON.parse(gameScript[0]!);
		expect(sent).toEqual({ cmd: "build_bus_route", company: 0, townA: 6, townB: 18, job: 101 });
		expect(res.details.ok).toBe(true);
		const first = res.content[0] as { type: string; text?: string };
		expect(first.text).toContain("build_bus_route");
	});

	it("omits towns when not provided (planner picks)", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = buildBusRouteTool({ sink, state: fakeState() });
		await tool.execute("c1", {});
		const sent = JSON.parse(gameScript[0]!);
		expect(sent).toEqual({ cmd: "build_bus_route", company: 0 });
	});
});

/**
 * M3-1（2026-09-19）：车队规模是一个**双向**动作。
 *
 * 环境事实（SPEC §10.80，源码确证于 `executor-ai/main.nut:CheckAddVehicles`）：
 * `V:<count>` 在 `cur < want` 时克隆头车扩容，在 `cur > want` 时**卖车**
 * （"newest first; never the lead vehicle"）；下限是 1，`count < 1` 被当作"无请求"。
 * 而旧工具名 `add_vehicles` 与契约只讲扩容 —— **能力存在，却没被暴露成可用的动作**。
 * 现在正名为"设置车队规模"，并把下限与"0 不是退役"写进契约。
 */
/**
 * M3-2a：退役工具（SPEC §10.86）。
 *
 * 这是运输公司最有后果的动词之一：**关掉一条正在亏钱的线路**。
 * 契约必须说清三件事，因为模型据此学习因果：
 *   ① 它卖的是**整条线路**的车（含头车）——与"缩编"的下限 1 不同；
 *   ② 它只对**执行器建过**的线路有效（执行器只认本局自己建的线）；
 *   ③ 车必须**停在车库里**才卖得掉，所以是"请求 + 逐步生效"，不是瞬时。
 */
describe("retire_route tool（M3-2a）", () => {
	/** A company entry, as the admin port reports it. */
	function fleetState(n: number, phase = "EX rd s0 r0 j101"): StateReader {
		return fakeState({
			companies: new Map([
				[0, { info: { id: 0, name: phase, isAi: true }, stats: { vehicles: n, stations: 2 } }],
			]) as never,
		});
	}

	it("名字与描述讲清了「整条线路」与「与缩编不同」", () => {
		const { sink } = fakeSink();
		const tool = retireRouteTool({ sink, state: fleetState(3) });
		expect(tool.name).toBe("retire_route");
		expect(String(tool.description)).toMatch(/retire|stops? serving/i);
		// 必须点明头车也会被卖（否则模型会以为还会剩一辆在跑）
		expect(String(tool.description)).toMatch(/including the (lead|first)|also the lead/i);
	});

	it("发出 retire_route 命令，并把「请求」与「结果」分开说明", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = retireRouteTool({ sink, state: fleetState(3) });
		const res = await tool.execute("c1", { job: 101 });
		expect(JSON.parse(gameScript[0]!)).toEqual({ cmd: "retire_route", company: 0, job: 101 });
		const d = (res as { details: { ok: boolean; summary: string } }).details;
		expect(d.ok).toBe(true);
		// 不能声称已退役：只有执行器的相位能证明
		expect(d.summary).toMatch(/request|observ/i);
	});

	it("回报当前执行器阶段（生效时机的唯一线索）", async () => {
		const { sink } = fakeSink();
		const tool = retireRouteTool({ sink, state: fleetState(3, "EX R12 d0 a3 #2 j101") });
		const res = await tool.execute("c1", { job: 101 });
		const d = (res as { details: { summary: string } }).details;
		expect(d.summary).toContain("EX R12 d0 a3 #2 j101");
	});

	it("变更型工具必须串行执行（游戏按 FIFO 应用命令）", () => {
		const { sink } = fakeSink();
		expect(retireRouteTool({ sink, state: fleetState(3) }).executionMode).toBe("sequential");
	});

});

describe("set_route_vehicles tool（M3-1：正名暴露双向能力）", () => {
	/** A company entry with a given vehicle count, as the admin port reports it. */
	function stateWithVehicles(n: number): StateReader {
		return fakeState({
			companies: new Map([
				[0, { info: { id: 0, name: "EX rd s0 r0", isAi: true }, stats: { vehicles: n, stations: 2 } }],
			]) as never,
		});
	}

	it("M3-2c：能指定 job（否则永远只能调「最后一条」线路的车队）", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(6) });
		await tool.execute("c1", { job: 102, count: 4 });
		expect(JSON.parse(gameScript[0]!)).toMatchObject({ cmd: "add_vehicles", job: 102, count: 4 });
	});

	it("M3-2c：不传 job 时不替模型瞎猜（省略该字段，交由环境决定）", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(6) });
		await tool.execute("c1", { count: 4 });
		expect(JSON.parse(gameScript[0]!).job).toBeUndefined();
	});
	it("扩容：车队 3 → 请求 5，命令带 count 且说明是请求（不是结果）", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(3) });
		const res = await tool.execute("c1", { count: 5 });
		expect(JSON.parse(gameScript[0]!)).toEqual({ cmd: "add_vehicles", company: 0, count: 5 });
		const d = (res as { details: { ok: boolean; summary: string } }).details;
		expect(d.ok).toBe(true);
		// 工具报的是"请求"，世界由 observe() 报告 —— 这条语义必须留在 summary 里
		expect(d.summary).toMatch(/request/i);
	});

	it("缩编：车队 6 → 请求 2，同样发出（环境会卖掉最新的克隆）", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(6) });
		const res = await tool.execute("c1", { count: 2 });
		expect(JSON.parse(gameScript[0]!)).toEqual({ cmd: "add_vehicles", company: 0, count: 2 });
		const d = (res as { details: { ok: boolean; summary: string } }).details;
		expect(d.ok).toBe(true);
		// 契约里必须能读到"减少"的含义，否则 agent 无从知道这是允许的
		expect(d.summary).toMatch(/2|6/);
	});

	it("工具名与描述都讲清了双向语义（名字即契约）", () => {
		const { sink } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(3) });
		expect(tool.name).toBe("set_route_vehicles");
		expect(String(tool.description)).toMatch(/clone|grow|increase/i);
		expect(String(tool.description)).toMatch(/sell|reduce|decrease/i);
	});

	/**
	 * 2026-09-19 真机证伪（SPEC §10.81）：
	 * `CheckAddVehicles()` 只在 `_stage == "done"` 时被调用（`executor-ai/main.nut:115`），
	 * 于是施工期间发来的请求**不会被读**。真机上缩编请求发出后执行器再没回到 `done`，
	 * 车队全程不变 —— 我差点把"环境不支持缩编"当成结论。
	 *
	 * 因此工具必须把**当前执行器阶段**作为事实一并回报：否则模型只会看到
	 * "我请求了、什么都没变"，然后学会"请求车队没用"这种错误因果（D20）。
	 */
	it("回报当前执行器阶段（请求被延迟的原因是可观测事实）", async () => {
		const { sink } = fakeSink();
		// 阶段由公司名携带（EX <stage> …），与 observe() 看到的是同一来源
		const state = fakeState({
			companies: new Map([
				[0, { info: { id: 0, name: "EX rd s0 r12 d69 j101", isAi: true }, stats: { vehicles: 6, stations: 2 } }],
			]) as never,
		});
		const tool = setRouteVehiclesTool({ sink, state });
		const res = await tool.execute("c1", { count: 2 });
		const d = (res as { details: { ok: boolean; summary: string } }).details;
		expect(d.ok).toBe(true);
		// 阶段原样回报（它是 harness 的既有事实通道，不是新造的）
		expect(d.summary).toContain("EX rd s0 r12 d69 j101");
	});

	it("count 小于 1 被 schema 拦下（环境把 V:0 当作\"无请求\"，不是退役）", () => {
		const { sink } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(3) });
		// 用 schema 校验 0：不应通过（否则 agent 会以为能"清零"）
		const check = (tool.parameters as { safeParse?: (v: unknown) => { success: boolean } }).safeParse;
		if (check) {
			expect(check.call(tool.parameters, { count: 0 }).success).toBe(false);
		}
		expect(String(tool.description)).toMatch(/at least 1|minimum 1|1 vehicle|never sold/i);
	});

	// 2026-09-12 真实事故（用户 e2e 日志）:
	//   决策 24/25/26/27 连续 `add_vehicles ok=true`，而 `vehicles` 始终为 0。
	//   原因链:
	//   1) GS 的 ack `placed:1` 指的是**标牌放好了**，不是"放了 1 台车"；
	//   2) 执行器只在 `_stage == "done" && _vehicle >= 0` 时才读那个标牌；
	//   3) `CheckAddVehicles` 靠**克隆头车**扩容，0 台车时没有可克隆对象，直接 return。
	//   而工具无条件返回 `ok=true`（"我把命令写进 socket 了"），于是模型永远
	//   得不到"这做不到"的反馈，只能无限重试同一个动作。
	//
	// 工具**能**看见 `vehicles`（observe 用的就是它），所以不许再说谎。
	it("车队为空时拒绝，并说明为什么（克隆不出第一台车）", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(0) });
		const res = await tool.execute("c1", { count: 1 });
		const details = (res as { details: { ok: boolean; summary: string } }).details;
		expect(details.ok, "claiming success here is what made the model retry forever").toBe(false);
		expect(details.summary).toMatch(/no vehicles/i);
		expect(details.summary).toMatch(/clone|first/i);
		expect(gameScript, "an impossible command must not be sent").toEqual([]);
	});

	it("拒绝信息只陈述契约事实，不替 agent 决定下一步", async () => {
		// 用户的明确边界（2026-09-12）:框架不给策略,教训要留给 agent 自己探索。
		// 我最初写的是 "Use observe() to watch for vehicles > 0, and only then scale
		// the fleet" —— 那是**建议**,等于把该由它自己总结的教训直接剧透给它。
		// 拒绝信息应当像函数签名:说清"这个动作做不到、为什么",不说"你该做什么"。
		const { sink } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(0) });
		const res = await tool.execute("c1", { count: 4 });
		const summary = (res as { details: { summary: string } }).details.summary;
		// The contract fact that makes it impossible:
		expect(summary).toMatch(/clone/i);
		// ...and no steering:
		for (const banned of ["you should", "prefer", "only then", "use observe", "make sure"]) {
			expect(summary.toLowerCase(), `advice leaked into a tool refusal: "${banned}"`).not.toContain(banned);
		}
	});

	it("公司不存在时同样拒绝（不猜）", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: fakeState() });
		const res = await tool.execute("c1", { count: 2 });
		const details = (res as { details: { ok: boolean } }).details;
		expect(details.ok).toBe(false);
		expect(gameScript).toEqual([]);
	});

	it("允许的 count 不会因为 0 车而被误拦（3 台车要 5 台仍然照发）", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = setRouteVehiclesTool({ sink, state: stateWithVehicles(3) });
		const res = await tool.execute("c1", { count: 5 });
		expect((res as { details: { ok: boolean } }).details.ok).toBe(true);
		expect(gameScript).toHaveLength(1);
	});
});

describe("set_pause tool", () => {
	it("maps paused true/false to rcon pause/unpause", async () => {
		const { sink, rcon } = fakeSink();
		const tool = setPauseTool({ sink, state: fakeState() });
		await tool.execute("c1", { paused: true });
		await tool.execute("c2", { paused: false });
		expect(rcon).toEqual(["pause", "unpause"]);
	});

	it("无法观测回执时如实报'未确认'（不谎报成功）", async () => {
		const { sink } = fakeSink();
		const res = await setPauseTool({ sink, state: fakeState() }).execute("c1", { paused: true });
		expect((res as { details?: { ok?: boolean } }).details?.ok).toBe(false);
		expect(textOf(res)).toMatch(/UNKNOWN/);
	});

	it("能观测回执时报告游戏的原话（on 2026-09-17 起 rcon 有回执通道）", async () => {
		const { sink, rcon } = fakeSink();
		(sink as { rconAwait?: (c: string) => Promise<string | null> }).rconAwait = async (c: string) => {
			rcon.push(c);
			return "Game paused";
		};
		const res = await setPauseTool({ sink, state: fakeState() }).execute("c1", { paused: true });
		expect((res as { details?: { ok?: boolean } }).details?.ok).toBe(true);
		expect(textOf(res)).toContain("Game paused");
	});
});

describe("observe tool", () => {
	it("returns the summarized state", async () => {
		const tool = observeTool(deps());
		const res = await tool.execute("c1", {});
		expect(res.details.ok).toBe(true);
		expect((res.details.data as Record<string, unknown>).date).toBe("1950-03-01");
	});
});

describe("createTools", () => {
	it("exposes the first batch with stable names", () => {
		const names = createTools(deps()).map((t) => t.name);
		// 估价先于建造：§10.34 实测没有距离信号时 agent 只会"按人口取前二"
		expect(names).toContain("estimate_route");
		// N2-2 起 inspect_route 也在列：线路经济必须可主动查询（推送 = harness
		// 替 agent 选问题）
		expect(names).toEqual([
			"observe",
			"estimate_route",
			"inspect_route",
			"build_bus_route",
			"set_route_vehicles",
			// M3-2a：运输公司最有后果的动词之一——关掉一条正在亏钱的线路
			"retire_route",
			// M4a：按需检索自己过往的观测（"记忆有没有被用"的唯一测量入口）
			"recall",
			"set_pause",
			// AB-1：能力目录（"我现在能做什么"，D32 的正解）
			"capabilities",
		]);
	});
});

describe("observe 必须让 agent 看见可选项（SPEC §10.32）", () => {
	// M3 实验饱和的根因是 agent **看不到**它要在哪些城镇之间选。
	// observe() 的 summary 是模型唯一能读到的文本（toResult 只发 summary），
	// 所以城镇必须在 summary 里，只在 details 里等于没给。
	it("summary 里带 id / 人口 / 坐标", async () => {
		const d = deps({
			state: fakeState({
				towns: [
					{ id: 9, population: 2279, x: 97, y: 162 },
					{ id: 1, population: 1391, x: 184, y: 221 },
				],
			}),
		});
		const t = createTools(d).find((x) => x.name === "observe")!;
		const res = await t.execute("c1", {});
		// Read the model-visible TEXT, not JSON.stringify(content): stringifying
		// re-escapes the inner quotes, so a /"id":9/ pattern could never match and
		// the test would fail even when the feature works.
		const text = textOf(res);
		expect(text).toContain("towns=");
		expect(text).toMatch(/"id":9/);
		expect(text).toMatch(/"pop":2279/);
		expect(text).toMatch(/"x":97/);
		expect(text).toMatch(/"id":1/);
	});

	it("按人口降序（顺序是世界的事实，不是建议）", async () => {
		const d = deps({
			state: fakeState({
				towns: [
					{ id: 1, population: 100, x: 0, y: 0 },
					{ id: 2, population: 900, x: 1, y: 1 },
				],
			}),
		});
		const t = createTools(d).find((x) => x.name === "observe")!;
		const res = await t.execute("c1", {});
		const text = textOf(res);
		expect(text.indexOf('"id":2')).toBeLessThan(text.indexOf('"id":1'));
	});

	it("build_bus_route 的描述不再叫模型别做选择", () => {
		const t = createTools(deps()).find((x) => x.name === "build_bus_route")!;
		expect(t.description).not.toMatch(/let the planner pick/i);
	});
});

/**
 * NEXT-2 N2-2：`inspect_route` —— 让 agent 主动查一条线的经济。
 *
 * 三路径都必须有明确回答（"永远说'是'的工具毁掉学习"）：
 *   已知 job → 事实；未知 job → 拒绝并给出已知清单；无经济数据 → 明确说无。
 */
describe("inspect_route —— 线路经济查询（N2-2）", () => {
	const depsWith = (stats: () => { job: number; vehicles: number; profit: number; waiting: number; gameDate: number }[]) =>
		({ ...fakeSink(), state: fakeState(), routeStats: stats }) as unknown as AgentDeps;

	it("已知 job：返回该线事实（车辆数/等待/每日收益），不含建议", async () => {
		// gameDate 395 → 年内第 30 天（≥30 天样本，速率才有意义）
		const deps = depsWith(() => [{ job: 1, vehicles: 6, profit: 3650, waiting: 146, gameDate: 395 }]);
		const res = await inspectRouteTool(deps).execute("id", { job: 1 });
		const text = textOf(res);
		expect(text).toContain("1");
		expect(text).toMatch(/6 vehicles/);
		expect(text).toMatch(/waiting 146/);
		expect(text).toMatch(/income 122\/day/); // 3650 / 30
		for (const w of ["should", "recommend", "add more", "better", "increase"]) {
			expect(text.toLowerCase()).not.toContain(w);
		}
	});

	it("不给 job：列出全部已知线路（agent 先看有什么）", async () => {
		const deps = depsWith(() => [
			{ job: 1, vehicles: 2, profit: 100, waiting: 5, gameDate: 365 },
			{ job: 2, vehicles: 0, profit: 0, waiting: 0, gameDate: 365 },
		]);
		const res = await inspectRouteTool(deps).execute("id", {});
		expect(textOf(res)).toMatch(/1[\s\S]*2/);
	});

	it("未知 job：明确拒绝并给出已知 job 清单（不许编造一条线）", async () => {
		const deps = depsWith(() => [{ job: 7, vehicles: 1, profit: 10, waiting: 0, gameDate: 365 }]);
		const res = await inspectRouteTool(deps).execute("id", { job: 99 });
		const text = textOf(res);
		expect(text).toContain("99");
		expect(text).toContain("7");
		expect((res as { details?: { ok?: boolean } }).details?.ok).toBe(false);
	});

	it("还没有任何经济数据：明确说没有（不返回空事实冒充成功）", async () => {
		const res = await inspectRouteTool(depsWith(() => [])).execute("id", {});
		expect((res as { details?: { ok?: boolean } }).details?.ok).toBe(false);
		expect(textOf(res).toLowerCase()).toMatch(/no route|not reported|unknown/);
	});

	it("本模式没有 GS 通道：拒绝而不是静默成功", async () => {
		const deps = { ...fakeSink(), state: fakeState() } as unknown as AgentDeps;
		const res = await inspectRouteTool(deps).execute("id", { job: 1 });
		expect((res as { details?: { ok?: boolean } }).details?.ok).toBe(false);
	});

	it("工具已注册进 createTools（否则模型永远看不到它）", () => {
		const names = createTools(depsWith(() => [])).map((t) => t.name);
		expect(names).toContain("inspect_route");
	});
});

/**
 * M4a（SPEC §10.89）：`recall` —— 按需检索自己过往的观测。
 *
 * 三条契约（模型据此学因果）：
 *   ① 本局没有记忆时**具名拒绝**，不是"空结果"（空结果会被读成"没记到过"）；
 *   ② 匹配是**子串**而非语义（描述里必须写明，否则模型会高估它）；
 *   ③ 每次检索都**记账**（`recallCalls` 是"记忆到底有没有被用"的第一个测量）。
 */
describe("recall tool（M4a）", () => {
	it("把检索结果作为事实行返回，并记账", async () => {
		const { sink } = fakeSink();
		const seen: { query: string | null; hits: number; ids: string[] }[] = [];
		const tool = recallTool({
			sink,
			state: fakeState(),
			recall: () => [{ id: "abc", line: "[abc] Route job 101 lost money (money 0 -> 100)" }],
			onRecall: (r) => seen.push(r),
		});
		const res = await tool.execute("c1", { query: "money" });
		const d = (res as { details: { ok: boolean; summary: string } }).details;
		expect(d.ok).toBe(true);
		expect(d.summary).toContain("Route job 101 lost money");
		expect(seen).toEqual([{ query: "money", hits: 1, ids: ["abc"] }]);
	});

	it("本局没有记忆时具名拒绝（控制臂绝不能偷偷拿到记忆）", async () => {
		const { sink } = fakeSink();
		const tool = recallTool({ sink, state: fakeState() });
		const res = await tool.execute("c1", {});
		const d = (res as { details: { ok: boolean; summary: string } }).details;
		expect(d.ok).toBe(false);
		expect(d.summary).toMatch(/no memory|disabled/i);
	});

	it("描述里写明是**按词**匹配且不是语义检索", () => {
		const { sink } = fakeSink();
		const d = String(recallTool({ sink, state: fakeState() }).description);
		expect(d).toMatch(/per word|any of your words/i);
		expect(d).toMatch(/not semantic search/i);
	});

	it("查不到时说清是「查不到」，不编造", async () => {
		const { sink } = fakeSink();
		const tool = recallTool({ sink, state: fakeState(), recall: () => [], onRecall: () => {} });
		const res = await tool.execute("c1", { query: "zzz" });
		const d = (res as { details: { ok: boolean; summary: string } }).details;
		expect(d.ok).toBe(true);
		expect(d.summary).toMatch(/no recorded observation matches/i);
	});
});

/**
 * AB-1（SPEC §10.91）：`capabilities()` —— agent 第一次能**问**环境自己有哪些动作。
 *
 * 起因（D32）：判断"agent 能不能做 X"的唯一可靠依据是**环境暴露了哪些动作**，
 * 但此前这个清单只存在于工具 schema 里、且**当前是否可用**只能靠失败去发现
 * （`inspect_route` 无 GS 通道时拒绝、`recall` 无记忆时拒绝）。
 *
 * 三条结构性要求（守卫证明，而不是靠纪律）：
 *   ① 目录**从活的工具数组派生** ⇒ 名字不可能漂移；
 *   ② 可用性判断与工具自身的拒绝**共用同一个谓词** ⇒ 目录不可能撒谎；
 *   ③ 每个工具都必须被分类为 read/write ⇒ 新工具不能不表态。
 */
describe("capabilities tool（AB-1）", () => {
	function minimalDeps(): AgentDeps {
		const { sink } = fakeSink();
		return { sink, state: fakeState() } as AgentDeps;
	}

	it("列出全部工具，且**不多不少**（目录派生自工具数组）", async () => {
		const tools = createTools(minimalDeps());
		const cap = tools.find((t) => t.name === "capabilities")!;
		const res = await cap.execute("c1", {});
		const d = (res as unknown as { details: { ok: boolean; data: { actions: { name: string }[] } } }).details;
		const listed = d.data.actions.map((a) => a.name).sort();
		expect(listed).toEqual(tools.map((t) => t.name).sort());
	});

	it("把当前**不可用**的动作标出来，并说明原因（不是等失败才发现）", async () => {
		const tools = createTools(minimalDeps());
		const cap = tools.find((t) => t.name === "capabilities")!;
		const d = (await cap.execute("c1", {})).details as unknown as {
			data: { actions: { name: string; available: boolean; why?: string }[] };
		};
		const recall = d.data.actions.find((a) => a.name === "recall")!;
		const inspect = d.data.actions.find((a) => a.name === "inspect_route")!;
		expect(recall.available).toBe(false);
		expect(recall.why).toMatch(/memory/i);
		expect(inspect.available).toBe(false);
		expect(inspect.why).toMatch(/route economics/i);
	});

	it("目录说不可用 ⇒ 那个工具**真的**会拒绝（共用谓词，不是两套判断）", async () => {
		const deps = minimalDeps();
		const tools = createTools(deps);
		const cap = tools.find((t) => t.name === "capabilities")!;
		const d = (await cap.execute("c1", {})).details as unknown as {
			data: { actions: { name: string; available: boolean }[] };
		};
		for (const a of d.data.actions) {
			if (a.available || a.name === "capabilities") continue;
			const t = tools.find((x) => x.name === a.name)!;
			const r = (await t.execute("c1", {})).details as unknown as { ok: boolean };
			expect(r.ok, `${a.name} 目录说不可用，但它没有拒绝`).toBe(false);
		}
	});

	it("分类 read/write：有后果的动作必须被标出来（决策所需事实）", async () => {
		const cap = createTools(minimalDeps()).find((t) => t.name === "capabilities")!;
		const d = (await cap.execute("c1", {})).details as unknown as {
			data: { actions: { name: string; effect: string }[] };
		};
		const byName = new Map(d.data.actions.map((a) => [a.name, a.effect]));
		for (const w of ["build_bus_route", "set_route_vehicles", "retire_route", "set_pause"]) {
			expect(byName.get(w), `${w} 应为 write`).toBe("write");
		}
		for (const r of ["observe", "estimate_route", "inspect_route", "recall", "capabilities"]) {
			expect(byName.get(r), `${r} 应为 read`).toBe("read");
		}
	});

	it("自己也在目录里（且是 read、永远可用）——不要让 agent 猜它有没有这个工具", async () => {
		const cap = createTools(minimalDeps()).find((t) => t.name === "capabilities")!;
		const d = (await cap.execute("c1", {})).details as unknown as {
			data: { actions: { name: string; available: boolean; effect: string }[] };
		};
		const self = d.data.actions.find((a) => a.name === "capabilities")!;
		expect(self.available).toBe(true);
		expect(self.effect).toBe("read");
	});
});

/**
 * AB-1 的**结构性守卫**：每个动作都必须在 `ACTION_EFFECTS` 里表态。
 *
 * 反风险：目录若对未知动作默认成 `read`，未来某个**会改变游戏状态**的新工具
 * 会被误标为只读——agent 会据此以为"随便调没事"。默认值必须让守卫红，而不是让语义错。
 */
describe("capabilities 目录的结构性守卫（AB-1）", () => {
	it("每个暴露的工具都有 effect 分类（漏登记 = 红）", async () => {
		const { sink } = fakeSink();
		const tools = createTools({ sink, state: fakeState() } as AgentDeps);
		const unclassified = tools.map((t) => t.name).filter((n) => ACTION_EFFECTS[n] === undefined);
		expect(unclassified, `这些工具没在 ACTION_EFFECTS 里表态：${unclassified}`).toEqual([]);
	});

	it("反向：登记表里没有已经不存在的工具（清理滞留项）", () => {
		const { sink } = fakeSink();
		const live = new Set(createTools({ sink, state: fakeState() } as AgentDeps).map((t) => t.name));
		const stale = Object.keys(ACTION_EFFECTS).filter((n) => !live.has(n));
		expect(stale, `ACTION_EFFECTS 里的滞留项：${stale}`).toEqual([]);
	});
});
