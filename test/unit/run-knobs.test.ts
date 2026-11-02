/**
 * Run knobs — the rules the page's knob form is held to.
 *
 * 这些测试锁的是**规则本身**（不是实现细节）：
 *   - 非法值 → 一条可执行的原因（不是静默回退）
 *   - 缺省 → 沿用进程配置（页面不碰的旋钮不改变行为）
 *   - 思考档/工具预算/花费上限复用 CLI 的同一套校验（不另写一份）
 *   - harness 后端只有进程允许时才可选（不变量：harness 默认关）
 */
import { describe, expect, it } from "vitest";
import {
	knobInputFrom,
	previewRunKnobs,
	resolveRunKnobs,
	type RunKnobDefaults,
} from "../../src/agent/run-knobs.js";

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

function codes(input: Parameters<typeof resolveRunKnobs>[0], defaults = DEFAULTS): string[] {
	return previewRunKnobs(input, defaults, ["agent"]).problems.map((p) => p.code);
}

describe("resolveRunKnobs", () => {
	it("keeps the process defaults when the page names nothing", () => {
		const knobs = resolveRunKnobs({}, DEFAULTS, ["agent"]);
		expect(knobs).toEqual({
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
		});
	});

	it("takes the page's values when it names them", () => {
		const knobs = resolveRunKnobs(
			{
				seed: 7,
		model: null,
				gameDays: 180,
				scenario: "prebuilt",
				memoryArm: "control",
				thinkingLevel: "high",
				toolBudget: 5,
				tokenLimit: 120_000,
				costLimit: 2.5,
				backend: "agent",
			},
			DEFAULTS,
			["agent"],
		);
		expect(knobs.seed).toBe(7);
		expect(knobs.gameDays).toBe(180);
		expect(knobs.scenario).toBe("prebuilt");
		expect(knobs.memoryArm).toBe("control");
		expect(knobs.thinkingLevel).toBe("high");
		expect(knobs.toolBudget).toBe(5);
		expect(knobs.tokenLimit).toBe(120_000);
		expect(knobs.costLimit).toBe(2.5);
	});

	it("parses the page's strings strictly (a typo is an error, not a rounding)", () => {
		// The page forwards what the user typed; the server decides what it means.
		const knobs = resolveRunKnobs({ seed: "7", toolBudget: "5" }, DEFAULTS, ["agent"]);
		expect(knobs.seed).toBe(7);
		expect(knobs.toolBudget).toBe(5);

		expect(codes({ seed: "12abc" })).toEqual(["invalid_knob"]);
		expect(codes({ toolBudget: "12.5" })).toEqual(["invalid_knob"]);
		expect(codes({ gameDays: "0" })).toEqual(["invalid_knob"]);
		expect(codes({ tokenLimit: "-5" })).toEqual(["invalid_knob"]);
	});

	it("treats an empty field as 'not set' (the page sends '' for a blank input)", () => {
		const knobs = resolveRunKnobs({ seed: "", toolBudget: "" }, DEFAULTS, ["agent"]);
		expect(knobs.seed).toBe(4242);
		expect(knobs.toolBudget).toBe(12);
	});

	it("refuses the harness backend unless the process allows it", () => {
		// The invariant: the dashboard cannot turn the harness on behind the
		// operator's back (ROADMAP §3).
		const refused = previewRunKnobs({ backend: "harness" }, DEFAULTS, ["agent"]);
		expect(refused.knobs).toBeNull();
		expect(refused.problems[0]!.code).toBe("invalid_knob");
		expect(refused.problems[0]!.hint).toContain("AGENT_HARNESS=1");

		const allowed = resolveRunKnobs({ backend: "harness" }, DEFAULTS, ["agent", "harness"]);
		expect(allowed.backend).toBe("harness");
	});

	it("rejects an unknown thinking level with the list of valid ones", () => {
		const bad = previewRunKnobs({ thinkingLevel: "turbo" }, DEFAULTS, ["agent"]);
		expect(bad.knobs).toBeNull();
		expect(bad.problems[0]!.message).toContain("LLM_THINKING");
		expect(bad.problems[0]!.hint).toContain("xhigh");
	});

	it("rejects a non-positive tool budget", () => {
		const bad = previewRunKnobs({ toolBudget: 0 }, DEFAULTS, ["agent"]);
		expect(bad.knobs).toBeNull();
		expect(bad.problems[0]!.code).toBe("invalid_knob");
	});

	it("collects every problem at once (the page shows them all, not one per reload)", () => {
		const bad = previewRunKnobs({ seed: "x", toolBudget: "-1", scenario: "weird" }, DEFAULTS, [
			"agent",
		]);
		expect(bad.problems.length).toBe(3);
		expect(bad.problems.every((p) => p.code === "invalid_knob")).toBe(true);
	});

	it("keeps the CLI's rules for the spend caps (a cost cap may be fractional)", () => {
		const knobs = resolveRunKnobs({ costLimit: "0.25" }, DEFAULTS, ["agent"]);
		expect(knobs.costLimit).toBe(0.25);
	});
});

describe("knobInputFrom", () => {
	it("passes text and numbers through untouched", () => {
		expect(knobInputFrom({ seed: "7", toolBudget: 5 })).toEqual({ seed: "7", toolBudget: 5 });
	});

	it("keeps a wrong-typed value visible instead of dropping it (a dropped knob would silently fall back)", () => {
		const parsed = knobInputFrom({ seed: { a: 1 } });
		expect(String(parsed.seed)).toContain("a");
	});
});
