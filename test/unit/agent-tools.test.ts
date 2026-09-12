/**
 * Unit tests — agent tools (pure logic, no network/game).
 * 事实来源: SPEC §4.3; src/agent/tools/index.ts contracts.
 */
import { describe, expect, it } from "vitest";
import {
	addVehiclesTool,
	buildBusRouteTool,
	createTools,
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

describe("add_vehicles tool", () => {
	/** A company entry with a given vehicle count, as the admin port reports it. */
	function stateWithVehicles(n: number): StateReader {
		return fakeState({
			companies: new Map([
				[0, { info: { id: 0, name: "EX rd s0 r0", isAi: true }, stats: { vehicles: n, stations: 2 } }],
			]) as never,
		});
	}

	it("sends count + company when the route already has vehicles", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = addVehiclesTool({ sink, state: stateWithVehicles(3) });
		await tool.execute("c1", { count: 5 });
		expect(JSON.parse(gameScript[0]!)).toEqual({ cmd: "add_vehicles", company: 0, count: 5 });
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
		const tool = addVehiclesTool({ sink, state: stateWithVehicles(0) });
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
		const tool = addVehiclesTool({ sink, state: stateWithVehicles(0) });
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
		const tool = addVehiclesTool({ sink, state: fakeState() });
		const res = await tool.execute("c1", { count: 2 });
		const details = (res as { details: { ok: boolean } }).details;
		expect(details.ok).toBe(false);
		expect(gameScript).toEqual([]);
	});

	it("允许的 count 不会因为 0 车而被误拦（3 台车要 5 台仍然照发）", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = addVehiclesTool({ sink, state: stateWithVehicles(3) });
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
		expect(names).toEqual(["observe", "build_bus_route", "add_vehicles", "set_pause"]);
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
