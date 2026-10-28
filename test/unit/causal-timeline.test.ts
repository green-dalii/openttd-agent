/**
 * Unit tests — the causal timeline (one row per decision, four pieces joined by `job`).
 *
 * 职责: 锁定"一行 = 一次决策"与"四段证据同屏且由 job 连接"这两条硬约束。
 * 为什么值得单测:
 *   1. **归属不能靠时间猜**：一次决策的工具调用属于**它自己那一段**（上一次决策之后、
 *      下一次决策之前），不是"离它最近的"。
 *   2. **缺失 ≠ 0**（D60）：最后一个决策还没有"下一个快照"，它的效果是**没测到**
 *      （null），不是 0 增量。
 *   3. **job 是连接键**：工具下的单 → GS job → 相位，靠 `job` 连，不靠时间戳。
 *
 * 禁止: 在此断言页面的排版（那是模板的事）。
 */

import { describe, expect, it } from "vitest";
import { buildCausalTimeline } from "../../src/agent/causal-timeline.js";

/** A decision record as the audit trail writes it. */
function decision(turn: number, trigger: string, ts: number, state: Record<string, unknown>): unknown {
	return { type: "decision", ts, turn, trigger, state };
}

/** A tool result; `job` is what ties the tool to the GS work it ordered. */
function action(tool: string, ok: boolean, ts: number, job?: number): unknown {
	return {
		type: "action_result",
		ts,
		tool,
		ok,
		summary: `${tool} summary`,
		data: job === undefined ? {} : { job },
	};
}

function plan(ts: number, goal: string): unknown {
	return { type: "plan", ts, plan: { goal, plan: ["step"] } };
}

function gsExec(ts: number, job: number, stage: string): unknown {
	return { type: "gs_exec", ts, job, stage, phase: `EX ${stage} j${job}` };
}

const STATE_A = {
	date: "1950-01-12",
	companies: [{ id: 0, money: "100000", income: "0", vehicles: 2, stations: 1 }],
	delivered: 10,
};
const STATE_B = {
	date: "1950-02-02",
	companies: [{ id: 0, money: "90400", income: "-120", vehicles: 5, stations: 2 }],
	delivered: 55,
};

describe("causal timeline: one row per decision", () => {
	it("makes a row for every decision, in order", () => {
		const rows = buildCausalTimeline([
			decision(1, "start", 1000, STATE_A),
			decision(2, "phase_change", 5000, STATE_B),
		]);
		expect(rows.length).toBe(2);
		expect(rows.map((r) => r.turn)).toEqual([1, 2]);
		expect(rows.map((r) => r.trigger)).toEqual(["start", "phase_change"]);
	});

	it("gives each decision the tools that happened in ITS window (not the nearest ones)", () => {
		const rows = buildCausalTimeline([
			decision(1, "start", 1000, STATE_A),
			action("build_bus_route", true, 1500, 101),
			decision(2, "phase_change", 5000, STATE_B),
			action("set_route_vehicles", true, 5500, 101),
		]);
		expect(rows[0]!.tools.map((t) => t.tool)).toEqual(["build_bus_route"]);
		expect(rows[1]!.tools.map((t) => t.tool)).toEqual(["set_route_vehicles"]);
	});

	it("carries the goal the model stated for that decision", () => {
		const rows = buildCausalTimeline([
			decision(1, "start", 1000, STATE_A),
			plan(1200, "Build the first corridor"),
			decision(2, "phase_change", 5000, STATE_B),
		]);
		expect(rows[0]!.goal).toBe("Build the first corridor");
		expect(rows[1]!.goal).toBeNull();
	});

	it("joins the tool, the job and the phases BY JOB, not by time", () => {
		const rows = buildCausalTimeline([
			decision(1, "start", 1000, STATE_A),
			action("build_bus_route", true, 1500, 101),
			gsExec(1600, 101, "buildA"),
			gsExec(1700, 101, "road"),
			// A phase of ANOTHER job (not ordered by this decision).
			gsExec(1800, 77, "buildA"),
			decision(2, "phase_change", 5000, STATE_B),
		]);
		const job = rows[0]!.jobs[0]!;
		expect(job.job).toBe(101);
		expect(job.command).toBe("build_bus_route");
		expect(job.phases.map((p) => p.stage)).toEqual(["buildA", "road"]);
		// The phases of a job this decision did not order are not its evidence.
		expect(rows[0]!.jobs.map((j) => j.job)).toEqual([101]);
	});

	it("measures the effect as the delta to the NEXT decision's snapshot", () => {
		const rows = buildCausalTimeline([
			decision(1, "start", 1000, STATE_A),
			decision(2, "phase_change", 5000, STATE_B),
		]);
		const effect = rows[0]!.effect!;
		expect(effect.money).toBe(-9600);
		expect(effect.vehicles).toBe(3);
		expect(effect.stations).toBe(1);
		expect(effect.delivered).toBe(45);
		expect(effect.gameDays).toBe(21);
	});

	it("says 'not measured' for the last decision instead of reporting a zero delta", () => {
		// The last decision has no later snapshot yet — that is "not measured",
		// not "nothing changed" (D60).
		const rows = buildCausalTimeline([decision(1, "start", 1000, STATE_A)]);
		expect(rows[0]!.effect).toBeNull();
	});

	it("leaves a reading unknown rather than folding it to zero", () => {
		const rows = buildCausalTimeline([
			decision(1, "start", 1000, { date: "1950-01-12", companies: [], delivered: null }),
			decision(2, "phase_change", 5000, { date: "1950-02-02", companies: [], delivered: 5 }),
		]);
		const effect = rows[0]!.effect!;
		expect(effect.delivered).toBeNull();
		expect(effect.money).toBeNull();
		expect(effect.vehicles).toBeNull();
	});

	it("ignores records that are not part of the chain (unknown types)", () => {
		const rows = buildCausalTimeline([
			{ type: "recall", ts: 900, query: "x" },
			{ type: "note", ts: 950, message: "agent session start" },
			decision(1, "start", 1000, STATE_A),
			{ type: "step", ts: 1100, id: "s1", kind: "message" },
		]);
		expect(rows.length).toBe(1);
		expect(rows[0]!.tools).toEqual([]);
	});

	it("survives a record that does not have the shape it claims", () => {
		const rows = buildCausalTimeline([
			{ type: "decision", ts: 1000 },
			{ type: "action_result", ts: 1100 },
			{ type: "gs_exec", ts: 1200 },
			"not an object at all",
			null,
		]);
		expect(rows.length).toBe(1);
		expect(rows[0]!.turn).toBeNull();
		expect(rows[0]!.tools).toEqual([]);
	});
});
