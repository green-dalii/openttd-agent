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

function fakeState(snap: Partial<WorldSnapshot> = {}): StateReader {
	return {
		snapshot: () => ({
			date: { raw: 712223, year: 1950, month: 3, day: 1 },
			companies: new Map(),
			recent: [],
			totalEvents: 0,
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
					},
				],
			]),
			recent: [],
			totalEvents: 0,
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
	it("sends count + company", async () => {
		const { sink, gameScript } = fakeSink();
		const tool = addVehiclesTool({ sink, state: fakeState() });
		await tool.execute("c1", { count: 5 });
		expect(JSON.parse(gameScript[0]!)).toEqual({ cmd: "add_vehicles", company: 0, count: 5 });
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
