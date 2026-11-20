/**
 * Unit tests — the Compare page's view logic (B4).
 *
 * 职责: 锁定"页面只画服务端给的"与"缺失写 not measured 而不是 0"。
 * 为什么值得单测:
 *   1. **页面不下判断**：四轴的数字、配对判定、排除原因**都来自服务端**；
 *      页面只决定怎么写出来。任何页面自己算的数都会与服务端漂移。
 *   2. **缺失 ≠ 0**：没价目表的模型，费用是 `not measured`（不是 $0.00）。
 *   3. **配对判定照抄**：样本不足时显示服务端的 `not determinable`，
 *      页面**不得**自己发明一个阈值。
 *
 * 禁止: 在此断言模板结构。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/compare-view.js"), "utf8");

interface CompareView {
	modelRows(payload: unknown): {
		model: string;
		requested: string;
		runs: number;
		excluded: number;
		ability: { label: string; text: string; known: boolean }[];
		efficiency: { label: string; text: string; known: boolean }[];
		stability: { label: string; text: string; known: boolean }[];
		growth: { label: string; text: string; known: boolean };
		outcomes: { code: string; label: string; hint: string; count: number }[];
		splitMeasure: string;
		splitKnown: boolean;
	}[];
	exclusionRows(payload: unknown): { reason: string; count: number }[];
	comparison(payload: unknown): { verdict: string; message: string; pairs: number; known: boolean } | null;
	comparisonRows(payload: unknown): {
		axis: string;
		what: string;
		verdict: string;
		message: string;
		pairs: number;
		known: boolean;
		meanDiff: number | null;
		ci: [number, number] | null;
		betterModel: string | null;
		betterWhen: "higher" | "lower" | null;
		better: string;
	}[];
	runRows(payload: unknown): { id: string; model: string; seed: number; link: string }[];
	modelNames(payload: unknown): string[];
	collisionRows(payload: unknown): { id: string; dropped: number }[];
	axisCharts(payload: unknown): {
		key: string;
		title: string;
		max: number;
		bars: { model: string; label: string; text: string; value: number | null; known: boolean; width: number }[];
	}[];
	normalizedRows(payload: unknown): {
		model: string;
		lines: { text: string; known: boolean };
		deliveredPerLine: { mean: number | null; median: number | null; text: string; known: boolean };
		operatingProfitPerLine: { mean: number | null; median: number | null; text: string; known: boolean };
		deliveredPerVehicle: { mean: number | null; median: number | null; text: string; known: boolean };
		operatingProfitPerVehicle: { mean: number | null; median: number | null; text: string; known: boolean };
	}[];
	normalizedRunRows(payload: unknown): {
		id: string;
		model: string;
		seed: number;
		lines: { text: string; known: boolean };
		deliveredPerLine: { mean: number | null; median: number | null; text: string; known: boolean };
		operatingProfitPerLine: { mean: number | null; median: number | null; text: string; known: boolean };
		deliveredPerVehicle: { mean: number | null; median: number | null; text: string; known: boolean };
		operatingProfitPerVehicle: { mean: number | null; median: number | null; text: string; known: boolean };
	}[];
	planSummary(plan: unknown): { label: string; text: string; known: boolean }[];
	planCells(plan: unknown): { model: string; seed: number; costKnown: boolean }[];
	planProblems(payload: unknown): { code: string; message: string; hint: string }[];
	planQueueState(state: unknown): {
		status: string;
		text: string;
		failed: number;
		current: string;
		cells: { model: string; seed: number; status: string; error: string }[];
	};
}

describe("the comparison plan (Issue #48)", () => {
	it("the summary says how many runs, which caps, and whether the spend is measurable", () => {
		const rows = load().planSummary({
			runCount: 4,
			gameDays: 300,
			tokenLimit: null,
			costLimit: null,
			costKnown: true,
			backend: "agent",
			thinkingLevel: "off",
			toolBudget: 12,
			memoryArm: "treatment",
		});
		const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.text]));
		expect(byLabel["Runs"]).toBe("4");
		expect(byLabel["Game days"]).toBe("300");
		expect(byLabel["Token cap"]).toBe("no cap");
		expect(byLabel["Cost cap"]).toBe("no cap");
		expect(byLabel["Cost"]).toBe("measurable");
	});

	it("an unmeasurable spend reads 'not measured', never $0", () => {
		const rows = load().planSummary({ runCount: 2, costKnown: false, tokenLimit: null, costLimit: null });
		const cost = rows.find((r) => r.label === "Cost");
		expect(cost?.text).toBe("not measured");
		expect(cost?.known).toBe(false);
	});

	it("the cells list every run the plan starts", () => {
		const cells = load().planCells({
			cells: [
				{ model: "a", seed: 1, facts: { costKnown: true } },
				{ model: "b", seed: 2, facts: { costKnown: false } },
			],
		});
		expect(cells).toEqual([
			{ model: "a", seed: 1, costKnown: true },
			{ model: "b", seed: 2, costKnown: false },
		]);
	});

	it("the problems keep the server's code, message and hint", () => {
		const problems = load().planProblems({
			problems: [{ code: "unpriced_with_cost_cap", message: "no price table", hint: "drop the cap" }],
		});
		expect(problems[0]?.code).toBe("unpriced_with_cost_cap");
		expect(problems[0]?.hint).toBe("drop the cap");
	});

	it("the queue state says which cell runs and how many failed", () => {
		const state = load().planQueueState({
			status: "running",
			completed: 1,
			total: 3,
			failed: 1,
			current: { model: "b", seed: 2 },
			cells: [{ model: "a", seed: 1, status: "done", error: "" }],
		});
		expect(state.text).toBe("1/3 cells");
		expect(state.failed).toBe(1);
		expect(state.current).toBe("b (seed 2)");
		expect(state.cells[0]?.status).toBe("done");
	});
});

function load(): CompareView {
	const sandbox: Record<string, unknown> = { console, JSON, Object, Number, Math, Intl };
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return (sandbox.window as { CompareView: CompareView }).CompareView;
}

const PAYLOAD = {
	conditions: { scenario: null, horizonDays: null, seeds: [], repeats: 0 },
	models: [
		{
			model: "model-a",
			requestedModels: ["model-a"],
			runs: 4,
			excluded: 1,
			excludedReasons: ["stopped (paused)"],
			ability: {
				cargoDelivered: 120,
				passengersDelivered: 0,
				splitMeasure: "delivered to monitored towns/industries, by cargo type", runs: 4, measure: "cargo + passengers delivered", mean: 12.5, median: 12, stations: 3, vehicles: 6 },
			efficiency: {
				measure: "cargo + passengers delivered",
				deliveredPerMillionTokens: 42,
				tokensPerDecision: 1234,
				secondsPerRun: 300,
				costPerRun: null,
			},
			stability: {
				toolFailureRate: 0.1,
				gsErrorsPerRun: 1,
				outcomeDistribution: [
					{ code: "delivered", label: "Delivered", hint: "the run delivered cargo", count: 3 },
					{ code: "refused", label: "Every tool call was refused", hint: "never got to act", count: 1 },
				],
			},
			growth: { verdict: "not determinable", slopePerRun: null, message: "too few runs" },
		},
	],
	exclusions: [{ reason: "stopped (paused)", count: 1 }],
	comparison: {
		design: "paired",
		modelA: "model-a",
		modelB: "model-b",
		pairs: [{ seed: 1, repeat: 1, a: 1, b: 2, diff: -1 }],
		meanDiff: -1,
		diffCi95: null,
		verdict: "not determinable",
		message: "only 1 usable pair(s) - a paired interval needs >= 3",
	},
	runs: [
		{
			id: "20261028-120000-seed7",
			model: "model-a",
			requestedModel: "model-a",
			seed: 7,
			backend: "agent",
			status: "completed",
			excluded: null,
			deliveredPerGameDay: 12.5,
			deliveredRun: 125,
			simulatedDays: 10,
			totalTokens: 4000,
			costKnown: false,
			costTotal: 0,
			startedAt: 1,
		},
	],
};

describe("CompareView", () => {
	it("货运 F4（A6）：能力轴画出**货物/客运拆分**（服务端的数字与口径）", () => {
		const v = load();
		const rows = v.modelRows(PAYLOAD);
		const labels = rows[0]!.ability.map((a) => a.label);
		expect(labels).toContain("Cargo delivered");
		expect(labels).toContain("Passengers delivered");
		const cargo = rows[0]!.ability.find((a) => a.label === "Cargo delivered")!;
		expect(cargo.text).toBe("120");
		// 拆分的口径由服务端给（页面不写第二份措词）。
		expect(rows[0]!.splitMeasure).toBe("delivered to monitored towns/industries, by cargo type");
		expect(rows[0]!.splitKnown).toBe(true);
	});

	it("拆分没测到 ⇒ 不是 0（页面不把缺失当 0）", () => {
		const v = load();
		const payload = {
			models: [
				{
					model: "m",
					ability: { mean: 1, cargoDelivered: null, passengersDelivered: null, splitMeasure: "x" },
				},
			],
		};
		const rows = v.modelRows(payload);
		const cargo = rows[0]!.ability.find((a) => a.label === "Cargo delivered")!;
		expect(cargo.text).toBe("not measured");
		expect(cargo.known).toBe(false);
		expect(rows[0]!.splitKnown).toBe(false);
	});

	it("draws one row per model with the four axes", () => {
		const v = load();
		const rows = v.modelRows(PAYLOAD);
		expect(rows.length).toBe(1);
		expect(rows[0]!.model).toBe("model-a");
		expect(rows[0]!.runs).toBe(4);
		expect(rows[0]!.excluded).toBe(1);
		expect(rows[0]!.ability.length).toBeGreaterThan(0);
		expect(rows[0]!.efficiency.length).toBeGreaterThan(0);
		expect(rows[0]!.stability.length).toBeGreaterThan(0);
		expect(rows[0]!.growth.label).toBe("Growth");
	});

	it("writes a missing reading as 'not measured' (never 0)", () => {
		const v = load();
		const row = v.modelRows(PAYLOAD)[0]!;
		const cost = row.efficiency.find((x) => x.label === "Cost / run")!;
		expect(cost.text).toBe("not measured");
		expect(cost.known).toBe(false);
	});

	it("shows the exclusion counts by reason", () => {
		const v = load();
		expect(v.exclusionRows(PAYLOAD)).toEqual([{ reason: "stopped (paused)", count: 1 }]);
	});

	it("shows every outcome class the server counted, with the server's names", () => {
		const v = load();
		const row = v.modelRows(PAYLOAD)[0]!;
		// The page draws the classes it is given - it never reclassifies a run.
		expect(row.outcomes).toEqual([
			{ code: "delivered", label: "Delivered", hint: "the run delivered cargo", count: 3 },
			{ code: "refused", label: "Every tool call was refused", hint: "never got to act", count: 1 },
		]);
	});

	it("shows no outcome classes when the server sent none", () => {
		const v = load();
		const payload = {
			...PAYLOAD,
			models: PAYLOAD.models.map((m) => ({ ...m, stability: { ...m.stability, outcomeDistribution: [] } })),
		};
		expect(v.modelRows(payload)[0]!.outcomes).toEqual([]);
	});

	it("repeats the server's verdict instead of making one up", () => {
		const v = load();
		const c = v.comparison(PAYLOAD)!;
		expect(c.verdict).toBe("not determinable");
		expect(c.message).toContain("needs >= 3");
		expect(c.pairs).toBe(1);
		expect(c.known).toBe(false);
	});

	it("has no comparison when the server sent none", () => {
		const v = load();
		expect(v.comparison({ ...PAYLOAD, comparison: null })).toBeNull();
	});

	it("links every run into History", () => {
		const v = load();
		const rows = v.runRows(PAYLOAD);
		expect(rows[0]!.id).toBe("20261028-120000-seed7");
		expect(rows[0]!.link).toContain("/sessions");
		expect(rows[0]!.link).toContain("20261028-120000-seed7");
	});

	it("offers the models the server sent (the page does not invent one)", () => {
		const v = load();
		expect(v.modelNames(PAYLOAD)).toEqual(["model-a"]);
	});

	it("labels the delivery readings with the server's own wording", () => {
		// 交付数**同时含货物与客运**（OpenTTD 把两者记在同一个按货种的数组里），
		// 措辞归服务端 —— 页面自己写 "Delivered" 就是第二份词表，迟早漂移。
		const v = load();
		const rows = v.modelRows(PAYLOAD);
		expect(rows[0]!.ability[0]!.label).toBe("cargo + passengers delivered / game day");
		expect(rows[0]!.efficiency[0]!.label).toBe("cargo + passengers delivered / M tokens");
	});

	it("falls back to a neutral label when the server sent no wording", () => {
		const v = load();
		const payload = {
			models: [{ model: "m", ability: { mean: 1 }, efficiency: { deliveredPerMillionTokens: 1 } }],
		};
		const rows = v.modelRows(payload);
		expect(rows[0]!.ability[0]!.label).toBe("Delivered / game day");
	});

	it("draws the four axes as charts, one bar per model", () => {
		const v = load();
		const axes = v.axisCharts(PAYLOAD);
		expect(axes.map((a) => a.key)).toEqual(["ability", "efficiency", "stability", "growth"]);
		expect(axes[0]!.bars.map((b) => b.model)).toEqual(["model-a"]);
		expect(axes[0]!.bars[0]!.known).toBe(true);
	});

	it("scales each axis against its own maximum (the axes have different units)", () => {
		const v = load();
		const payload = {
			models: [
				{ model: "a", ability: { mean: 10 }, efficiency: { deliveredPerMillionTokens: 1 } },
				{ model: "b", ability: { mean: 2 }, efficiency: { deliveredPerMillionTokens: 100 } },
			],
		};
		const axes = v.axisCharts(payload);
		// 同一批模型，能力轴按 10 缩放，效率轴按 100 缩放 —— 共享刻度会说谎。
		expect(axes[0]!.bars[0]!.width).toBe(100);
		expect(axes[0]!.bars[1]!.width).toBe(20);
		expect(axes[1]!.bars[0]!.width).toBe(2);
		expect(axes[1]!.bars[1]!.width).toBe(100);
	});

	it("draws an unmeasured reading as an empty slot, never as a zero bar", () => {
		// 「没测到」画成 0 长度的实心条 = 把「没测到」说成「测到是 0」（D60）。
		const v = load();
		const payload = { models: [{ model: "a", ability: { mean: null } }] };
		const axes = v.axisCharts(payload);
		const bar = axes[0]!.bars[0]!;
		expect(bar.known).toBe(false);
		expect(bar.width).toBe(0);
		expect(bar.text).toBe("not measured");
	});

	it("reports the rows the ledger had to drop (Issue #58)", () => {
		// 样本悄悄变少是基准最容易骗人的方式 ⇒ 丢行必须**说出来**。
		const v = load();
		expect(v.collisionRows({ collisions: [{ id: "20261031-214949-seed4242", dropped: 1 }] })).toEqual([
			{ id: "20261031-214949-seed4242", dropped: 1 },
		]);
		expect(v.collisionRows({})).toEqual([]);
		expect(v.collisionRows(null)).toEqual([]);
	});

	it("survives an empty payload", () => {
		const v = load();
		expect(v.modelRows({})).toEqual([]);
		expect(v.exclusionRows(null)).toEqual([]);
		expect(v.comparison(null)).toBeNull();
		expect(v.runRows(undefined)).toEqual([]);
		expect(v.modelNames({})).toEqual([]);
	});
});

describe("CompareView: a different observation surface is disclosed, not judged", () => {
	it("says nothing when the server reports no difference", () => {
		expect(window2().surfaceDiff({ surface: { differs: false } })).toBeNull();
		expect(window2().surfaceDiff({})).toBeNull();
	});

	it("surfaces the distinct hashes when the runs answered different questions", () => {
		const d = window2().surfaceDiff({
			surface: {
				differs: true,
				scaffoldHashes: ["aaaa"],
				observationShapeHashes: ["bbbb", "cccc"],
				payloadShapeHashes: [],
			},
		});
		expect(d!.scaffold).toEqual(["aaaa"]);
		expect(d!.observation).toEqual(["bbbb", "cccc"]);
		expect(d!.text).toContain("observation surface: bbbb, cccc");
		// Only the observation surface differs ⇒ the advice must say so.
		expect(d!.text).toMatch(/across two observation surfaces/);
	});

	it("says 'not recorded' rather than implying the surfaces matched", () => {
		const d = window2().surfaceDiff({
			surface: {
				differs: true,
				scaffoldHashes: ["aaaa", "dddd"],
				observationShapeHashes: [],
				payloadShapeHashes: [],
			},
		});
		expect(d!.text).toContain("observation surface was not recorded");
		expect(d!.text).toContain("scaffold: aaaa, dddd");
	});
});

/** Load the page module the same way the other tests in this file do. */
function window2(): {
	surfaceDiff: (payload: unknown) => {
		scaffold: string[];
		observation: string[];
		policies: string[];
		payloadShape: string[];
		text: string;
	} | null;
} {
	const sandbox: Record<string, unknown> = { console, JSON, Object, Array, Number, String, Math, Date, Intl };
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return (sandbox.window as { CompareView: never })["CompareView"] as never;
}

describe("CompareView：配对判定按轴（Issue #87）", () => {
	it("每个轴一行：轴、指标、单位、判定、n、区间", () => {
		const v = load();
		const rows = v.comparisonRows({
			comparisons: [
				{
					metricId: "ability.deliveredPerGameDay",
					axisLabel: "Result",
					label: "cargo + passengers delivered",
					unit: "per game day",
					modelA: "a",
					modelB: "b",
					pairs: [{ seed: 1, repeat: 1, a: 1, b: 2, diff: -1 }],
					meanDiff: -0.5,
					diffCi95: [-1.2, 0.3],
					verdict: "not determinable",
					message: "the interval includes 0",
					betterWhen: "higher",
					betterModel: null,
				},
				{
					metricId: "stability.toolFailureRate",
					axisLabel: "Reliability",
					label: "tool calls that failed",
					unit: "share of tool calls",
					modelA: "a",
					modelB: "b",
					pairs: [],
					meanDiff: null,
					diffCi95: null,
					verdict: "not determinable",
					message: "no usable pair",
					betterWhen: "lower",
					betterModel: null,
				},
			],
		});
		expect(rows).toHaveLength(2);
		expect(rows[0]!.axis).toBe("Result");
		expect(rows[0]!.what).toContain("per game day");
		expect(rows[0]!.pairs).toBe(1);
		expect(rows[0]!.known).toBe(false);
		expect(rows[0]!.ci).toEqual([-1.2, 0.3]);
		expect(rows[1]!.pairs).toBe(0);
		expect(rows[1]!.meanDiff).toBeNull();
	});

	it("「谁更好」是服务端的答案：页面只透传，不自己判断方向", () => {
		const v = load();
		const rows = v.comparisonRows({
			comparisons: [
				{
					metricId: "efficiency.secondsPerRun",
					axisLabel: "Efficiency",
					label: "wall clock",
					unit: "seconds per run",
					modelA: "a",
					modelB: "b",
					pairs: [{ seed: 1, repeat: 1, a: 1, b: 2, diff: -1 }],
					meanDiff: -1,
					diffCi95: [-2, -0.1],
					verdict: "b_higher",
					message: "excludes 0",
					betterWhen: "lower",
					betterModel: "a",
				},
				{
					metricId: "ability.stations",
					axisLabel: "Result",
					label: "stations",
					unit: "at the end of the run",
					modelA: "a",
					modelB: "b",
					pairs: [{ seed: 1, repeat: 1, a: 5, b: 2, diff: 3 }],
					meanDiff: 3,
					diffCi95: [1, 5],
					verdict: "a_higher",
					message: "excludes 0",
					betterWhen: null,
					betterModel: null,
				},
			],
		});
		// B 的数字更大，但「更少墙钟」才好 ⇒ 服务端说是 a。
		expect(rows[0]!.verdict).toBe("b_higher");
		expect(rows[0]!.betterModel).toBe("a");
		expect(rows[0]!.betterWhen).toBe("lower");
		expect(rows[0]!.better).toBe("a (lower is better)");
		// 不带好坏方向的指标：没有「谁更好」。
		expect(rows[1]!.verdict).toBe("a_higher");
		expect(rows[1]!.betterModel).toBeNull();
		expect(rows[1]!.betterWhen).toBeNull();
		expect(rows[1]!.better).toBe("no quality");
	});

	it("指标有好坏方向但判定不出来时，说「不可判定」（服务端的话）", () => {
		const v = load();
		const rows = v.comparisonRows({
			comparisons: [
				{
					metricId: "ability.deliveredPerGameDay",
					axisLabel: "Result",
					label: "cargo + passengers delivered",
					unit: "per game day",
					pairs: [],
					meanDiff: null,
					diffCi95: null,
					verdict: "not determinable",
					message: "the interval includes 0",
					betterWhen: "higher",
					betterModel: null,
				},
			],
		});
		expect(rows[0]!.better).toBe("not determinable");
	});

	it("没有逐轴判定时是空数组（不是猜一条出来）", () => {
		const v = load();
		expect(v.comparisonRows({})).toEqual([]);
		expect(v.comparisonRows(null)).toEqual([]);
	});
});

/* ==========================================================================
 * 归一化读数（阶段 D）：每条线 / 每辆车的交付量与运营利润。
 *
 * 为什么值得单测:
 *   1. **分母不同 ⇒ 单位不同**：这四条轴与"交付量/游戏日"不是同一个量，
 *      放在同一把尺子上就是撒谎（Compare 页自己的规矩）。
 *   2. **"没建线"不是 0**：一条线都没建的局在这四条轴上**不可比** ⇒ 显示 "—"。
 *   3. 页面只画服务端给的均值/中位数，不自己算。
 * ====================================================================== */
describe("compare-view: 归一化读数（每条线 / 每辆车）", () => {
	const NORMALIZED_PAYLOAD = {
		models: [
			{
				model: "MiniMax-M3.1-Flash",
				runs: 3,
				ability: {
					normalized: {
						lines: 8,
						deliveredPerLine: { mean: 192.29, median: 85.55 },
						operatingProfitPerLine: { mean: 4.56, median: 2.1 },
						deliveredPerVehicle: { mean: 66.0, median: 30.2 },
						operatingProfitPerVehicle: { mean: 1.55, median: 0.8 },
					},
				},
			},
			{
				model: "MiniMax-M2.5",
				runs: 2,
				ability: {
					normalized: {
						lines: 7,
						deliveredPerLine: { mean: null, median: null },
						operatingProfitPerLine: { mean: null, median: null },
						deliveredPerVehicle: { mean: 12.5, median: 12.5 },
						operatingProfitPerVehicle: { mean: null, median: null },
					},
				},
			},
		],
	};

	it("给出每条线 / 每辆车的读数（均值 + 中位数）", () => {
		const v = load();
		const rows = v.normalizedRows(NORMALIZED_PAYLOAD);
		expect(rows).toHaveLength(2);
		expect(rows[0]!.model).toBe("MiniMax-M3.1-Flash");
		expect(rows[0]!.lines.text).toBe("8.0");
		expect(rows[0]!.deliveredPerLine.mean).toBeCloseTo(192.29, 2);
		expect(rows[0]!.deliveredPerLine.median).toBeCloseTo(85.55, 2);
		expect(rows[0]!.deliveredPerLine.known).toBe(true);
	});

	it("没测到的读数是 —,不是 0", () => {
		const v = load();
		const rows = v.normalizedRows(NORMALIZED_PAYLOAD);
		const b = rows[1]!;
		expect(b.deliveredPerLine.known).toBe(false);
		expect(b.deliveredPerLine.mean).toBeNull();
		expect(b.deliveredPerLine.text).toBe("—");
		expect(b.operatingProfitPerVehicle.known).toBe(false);
	});

	it("服务端没给 normalized 块时页面不炸", () => {
		const v = load();
		expect(v.normalizedRows({ models: [{ model: "x" }] })).toHaveLength(1);
		expect(v.normalizedRows({})).toEqual([]);
	});
});

/* ==========================================================================
 * Compare 页归一化表的**逐局模式**：均值背后的每一局是什么。
 *
 * 为什么值得单测:
 *   1. 均值只说"平均每条线运多少"，读者要核对的是**每一局** ⇒ 两种模式共用
 *      一张表，不新开一张（表格宽度是稀缺资源）。
 *   2. 不可比的局（没建线 / 老局没记分母）是 "—"，不是 0。
 * ====================================================================== */
describe("compare-view: 归一化表的逐局模式", () => {
	it("逐局行带着它自己的读数（缺读数是 —）", () => {
		const v = load();
		const rows = v.normalizedRunRows({
			runs: [
				{
					id: "run-1",
					model: "model-a",
					seed: 11,
					lines: 4,
					deliveredPerLine: 100,
					operatingProfitPerLine: 300,
					deliveredPerVehicle: 50,
					operatingProfitPerVehicle: 150,
				},
				{
					id: "run-2",
					model: "model-a",
					seed: 22,
					lines: 0,
					deliveredPerLine: null,
					operatingProfitPerLine: null,
					deliveredPerVehicle: null,
					operatingProfitPerVehicle: null,
				},
			],
		});
		expect(rows).toHaveLength(2);
		expect(rows[0]!.id).toBe("run-1");
		expect(rows[0]!.deliveredPerLine.text).toBe("100.0");
		expect(rows[0]!.deliveredPerLine.known).toBe(true);
		expect(rows[1]!.deliveredPerLine.text).toBe("—");
		expect(rows[1]!.deliveredPerLine.known).toBe(false);
		expect(rows[1]!.lines.text).toBe("0");
	});

	it("没有逐局读数的载荷 ⇒ 空表（不炸）", () => {
		const v = load();
		expect(v.normalizedRunRows({})).toEqual([]);
	});
});
