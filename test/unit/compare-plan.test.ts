/**
 * Unit tests — the comparison plan (Issue #48).
 *
 * 职责: 守住"计划里有什么、计划承诺什么、计划什么时候必须被拒绝"。
 * 关键性质:
 *   - 计划**不预测结果**：它估的是运行（几局、封顶、花费能不能测）。
 *   - "能不能测花费"是**逐格**的事实：只要有一格没有价目表，整份计划就是
 *     "not measured"（部分可知不是一个数字）。
 *   - 非法输入（空模型、非整数 seed、重复项、超上限）必须**报错并给出下一步**，
 *     不能悄悄少跑一格。
 */

import { describe, expect, it } from "vitest";
import {
	assembleComparePlan,
	parseComparePlan,
	planCells,
	planKnobs,
	MAX_PLAN_MODELS,
	MAX_PLAN_SEEDS,
	type ComparePlanModelFacts,
} from "../../src/agent/compare-plan.js";
import type { RunKnobDefaults } from "../../src/agent/run-knobs.js";

const DEFAULTS: RunKnobDefaults = {
	seed: 4242,
	model: null,
	gameDays: null,
	scenario: "freeform",
	memoryArm: "treatment",
	thinkingLevel: "off",
	toolBudget: 12,
	tokenLimit: null,
	costLimit: null,
	backend: "agent",
};

function facts(model: string, costKnown = true): ComparePlanModelFacts {
	return {
		providerId: "minimax",
		model,
		api: "anthropic-messages",
		contextWindow: 204800,
		maxTokens: 4096,
		costKnown,
	};
}

describe("compare plan: parsing", () => {
	it("reads the models and the seeds the page sent", () => {
		const parsed = parseComparePlan({ models: ["a", "b"], seeds: [7, 8] });
		expect(parsed.problems).toEqual([]);
		expect(parsed.models).toEqual(["a", "b"]);
		expect(parsed.seeds).toEqual([7, 8]);
	});

	it("refuses an empty plan (no models, no seeds)", () => {
		const parsed = parseComparePlan({ models: [], seeds: [] });
		expect(parsed.problems.length).toBeGreaterThanOrEqual(2);
		expect(parsed.problems.every((p) => p.code === "invalid_knob")).toBe(true);
	});

	it("refuses a seed that is not a whole number", () => {
		const parsed = parseComparePlan({ models: ["a"], seeds: ["7.5"] });
		expect(parsed.problems.length).toBe(1);
		expect(parsed.problems[0]?.message).toContain("not a whole number");
		expect(parsed.seeds).toEqual([]);
	});

	it("refuses a duplicate model or seed instead of running it twice", () => {
		const parsed = parseComparePlan({ models: ["a", "a"], seeds: [7, 7] });
		expect(parsed.problems.length).toBe(2);
		expect(parsed.models).toEqual(["a"]);
		expect(parsed.seeds).toEqual([7]);
	});

	it("refuses a plan that is too big (a refusal, not a clamp)", () => {
		const many = Array.from({ length: MAX_PLAN_MODELS + 1 }, (_, i) => `m${i}`);
		const parsed = parseComparePlan({ models: many, seeds: [1] });
		expect(parsed.problems.some((p) => p.message.includes("the limit is"))).toBe(true);
		const manySeeds = Array.from({ length: MAX_PLAN_SEEDS + 1 }, (_, i) => i + 1);
		const parsed2 = parseComparePlan({ models: ["a"], seeds: manySeeds });
		expect(parsed2.problems.some((p) => p.message.includes("the limit is"))).toBe(true);
	});

	it("enumerates the cells model-major (every seed of model 1, then model 2)", () => {
		expect(planCells(["a", "b"], [1, 2])).toEqual([
			{ model: "a", seed: 1 },
			{ model: "a", seed: 2 },
			{ model: "b", seed: 1 },
			{ model: "b", seed: 2 },
		]);
	});
});

describe("compare plan: knobs", () => {
	it("uses the same knob rules as a single run", () => {
		const parsed = planKnobs({ tokenLimit: "1000", gameDays: 30 }, DEFAULTS, ["agent"]);
		expect(parsed.problems).toEqual([]);
		expect(parsed.knobs?.tokenLimit).toBe(1000);
		expect(parsed.knobs?.gameDays).toBe(30);
	});

	it("refuses an illegal knob with the knob rule's own code", () => {
		const parsed = planKnobs({ tokenLimit: "12abc" }, DEFAULTS, ["agent"]);
		expect(parsed.problems.length).toBe(1);
		expect(parsed.problems[0]?.code).toBe("invalid_knob");
		expect(parsed.knobs).toBeNull();
	});

	it("refuses the harness backend when the process does not allow it", () => {
		const parsed = planKnobs({ backend: "harness" }, DEFAULTS, ["agent"]);
		expect(parsed.problems.length).toBe(1);
		expect(parsed.problems[0]?.hint).toContain("AGENT_HARNESS=1");
	});
});

describe("compare plan: assembly", () => {
	const knobs = {
		seed: 1,
		model: null,
		gameDays: 300,
		scenario: "freeform" as const,
		memoryArm: "treatment" as const,
		thinkingLevel: "off" as const,
		toolBudget: 12,
		tokenLimit: null,
		costLimit: null,
		backend: "agent" as const,
	};

	it("counts the runs and carries the caps", () => {
		const plan = assembleComparePlan({
			cells: planCells(["a", "b"], [1, 2]),
			knobs,
			factsByModel: new Map([
				["a", facts("a")],
				["b", facts("b")],
			]),
		});
		expect(plan.runCount).toBe(4);
		expect(plan.cells.length).toBe(4);
		expect(plan.gameDays).toBe(300);
		expect(plan.scaffoldHash).toMatch(/^[0-9a-f]{16}$/);
		expect(plan.problems).toEqual([]);
	});

	it("the spend is measurable only when EVERY cell's model is priced", () => {
		const plan = assembleComparePlan({
			cells: planCells(["a", "b"], [1]),
			knobs,
			factsByModel: new Map([
				["a", facts("a", true)],
				["b", facts("b", false)],
			]),
		});
		// "Partly known" is not a number.
		expect(plan.costKnown).toBe(false);
	});

	it("an unresolved model is priced 'unknown', never free", () => {
		const plan = assembleComparePlan({
			cells: planCells(["ghost"], [1]),
			knobs,
			factsByModel: new Map(),
		});
		expect(plan.cells[0]?.facts.costKnown).toBe(false);
		expect(plan.costKnown).toBe(false);
	});
});
