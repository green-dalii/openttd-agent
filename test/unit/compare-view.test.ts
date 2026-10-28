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
	}[];
	exclusionRows(payload: unknown): { reason: string; count: number }[];
	comparison(payload: unknown): { verdict: string; message: string; pairs: number; known: boolean } | null;
	runRows(payload: unknown): { id: string; model: string; seed: number; link: string }[];
	modelNames(payload: unknown): string[];
}

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
			ability: { runs: 4, mean: 12.5, median: 12, stations: 3, vehicles: 6 },
			efficiency: {
				deliveredPerMillionTokens: 42,
				tokensPerDecision: 1234,
				secondsPerRun: 300,
				costPerRun: null,
			},
			stability: { toolFailureRate: 0.1, outcomes: { delivered: 3 }, gsErrorsPerRun: 1 },
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

	it("survives an empty payload", () => {
		const v = load();
		expect(v.modelRows({})).toEqual([]);
		expect(v.exclusionRows(null)).toEqual([]);
		expect(v.comparison(null)).toBeNull();
		expect(v.runRows(undefined)).toEqual([]);
		expect(v.modelNames({})).toEqual([]);
	});
});
