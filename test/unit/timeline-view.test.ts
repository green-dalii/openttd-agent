/**
 * Unit tests — the timeline view's pure logic (B3).
 *
 * 职责: 锁定"页面只画服务端给的"与"缺失写 not measured 而不是 0"。
 * 为什么值得单测:
 *   1. **缺失 ≠ 0**（D60）：服务端给 null 时页面写 "not measured"——一个"0"会
 *      读成"这一局什么也没变"。
 *   2. **页面不重算**：增量是服务端量出来的，页面只画；页面自己算一遍就会
 *      和服务端的数漂移。
 *   3. **分页**：更早的行按需加载，总数已知。
 *
 * 禁止: 在此断言模板结构。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/timeline-view.js"), "utf8");

interface TimelineView {
	tools(row: unknown): { tool: string; ok: boolean; summary: string; job: number | null }[];
	jobs(row: unknown): { job: number; command: string | null; phases: { stage: string }[] }[];
	effect(row: unknown): { label: string; text: string; known: boolean }[] | null;
	headline(row: unknown): { turn: string; trigger: string; date: string; goal: string | null };
	summary(row: unknown): string;
	rows(page: unknown): unknown[];
	hasMore(page: unknown, shown?: number): boolean;
}

function load(): TimelineView {
	const sandbox: Record<string, unknown> = { console, JSON, Object, Number, Math, Intl };
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return (sandbox.window as { TimelineView: TimelineView }).TimelineView;
}

const ROW = {
	turn: 3,
	trigger: "phase_change",
	ts: 5000,
	gameDate: "1950-02-02",
	goal: "Build the first corridor",
	tools: [{ tool: "build_bus_route", ok: true, summary: "route 11->18", job: 101 }],
	jobs: [{ job: 101, command: "build_bus_route", phases: [{ stage: "buildA", phase: "EX stA_ok j101" }] }],
	effect: { gameDays: 21, money: -9600, income: -120, vehicles: 3, stations: 1, delivered: 45 },
};

describe("TimelineView", () => {
	it("shows the tools of a decision, with the job they ordered", () => {
		const v = load();
		const tools = v.tools(ROW);
		expect(tools.length).toBe(1);
		expect(tools[0]!.tool).toBe("build_bus_route");
		expect(tools[0]!.ok).toBe(true);
		expect(tools[0]!.job).toBe(101);
	});

	it("shows the job with the phases it went through", () => {
		const v = load();
		const jobs = v.jobs(ROW);
		expect(jobs[0]!.job).toBe(101);
		expect(jobs[0]!.command).toBe("build_bus_route");
		expect(jobs[0]!.phases.map((p) => p.stage)).toEqual(["buildA"]);
	});

	it("writes the effect the server measured (the page does not compute it)", () => {
		const v = load();
		const e = v.effect(ROW)!;
		const money = e.find((x) => x.label === "Money")!;
		expect(money.text).toBe("-£9,600");
		expect(money.known).toBe(true);
		const vehicles = e.find((x) => x.label === "Vehicles")!;
		expect(vehicles.text).toBe("+3");
	});

	it("says 'not measured' for a reading the server did not have (never 0)", () => {
		const v = load();
		const e = v.effect({ ...ROW, effect: { gameDays: null, money: null, vehicles: null } })!;
		for (const reading of e) {
			expect(reading.text).toBe("not measured");
			expect(reading.known).toBe(false);
		}
	});

	it("says there is no later reading yet for the last decision", () => {
		const v = load();
		expect(v.effect({ ...ROW, effect: null })).toBeNull();
		expect(v.summary({ ...ROW, effect: null })).toContain("no later reading yet");
	});

	it("summarizes a row for the collapsed state", () => {
		const v = load();
		const s = v.summary(ROW);
		expect(s).toContain("Money");
		// The head of the row already shows the turn and the trigger; the
		// summary must not repeat them.
		expect(s).not.toContain("#3");
		expect(s).not.toContain("phase_change");
	});

	it("survives a row that is not a row", () => {
		const v = load();
		expect(v.tools(null)).toEqual([]);
		expect(v.jobs(undefined)).toEqual([]);
		expect(v.effect(null)).toBeNull();
		expect(v.headline(null).turn).toBe("—");
		expect(v.rows(null)).toEqual([]);
	});

	it("knows whether older rows are waiting", () => {
		const v = load();
		expect(v.hasMore({ rows: [1, 2], total: 7 }, 2)).toBe(true);
		expect(v.hasMore({ rows: [1, 2], total: 2 }, 2)).toBe(false);
		expect(v.hasMore(null)).toBe(false);
	});
});
