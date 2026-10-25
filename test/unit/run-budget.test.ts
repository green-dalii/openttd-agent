/**
 * Per-run spend caps (P4 / Issue #27).
 *
 * 为什么需要：一场基准是"模型 × seed × 重复"的矩阵，而一局只能被墙钟、工具预算或
 * 人停住——**没有 token/费用闸**。于是"这轮基准要花多少"没有系统强制的答案。
 *
 * 关键取舍（都是"不骗人"的分支）：
 *   - 非法值抛错，不静默回退（否则"我们在 N 处截断"是谎话）。
 *   - 费用闸只在**有价目表**时可执行；模型无价格却设了上限 → 启动即报错，
 *     因为"静默不执行"比"拒绝启动"更糟。
 *   - 未知用量不等于超限：`null` 是"没测到"，不能当 0，也不能当超限。
 *   - 比较函数只有一处（本文件），循环用它停机、结果分类用它命名成因。
 */

import { describe, expect, it } from "vitest";
import {
	budgetStop,
	resolveRunLimits,
	assertCostCapEnforceable,
	NO_LIMITS,
} from "../../src/agent/run-budget.js";

describe("resolveRunLimits", () => {
	it("defaults to no caps at all", () => {
		expect(resolveRunLimits({})).toEqual(NO_LIMITS);
		expect(resolveRunLimits({ LLM_TOKEN_LIMIT: "", LLM_COST_LIMIT: "  " })).toEqual(NO_LIMITS);
	});

	it("reads a token cap as a positive integer", () => {
		expect(resolveRunLimits({ LLM_TOKEN_LIMIT: "5000" }).tokens).toBe(5000);
	});

	it("reads a cost cap as a positive amount (fractions are meaningful)", () => {
		expect(resolveRunLimits({ LLM_COST_LIMIT: "1.25" }).cost).toBeCloseTo(1.25, 6);
	});

	it("throws on values a benchmark could not honestly report", () => {
		// Silent fallback would let a report claim a cap that was never applied.
		expect(() => resolveRunLimits({ LLM_TOKEN_LIMIT: "abc" })).toThrow(/LLM_TOKEN_LIMIT/);
		expect(() => resolveRunLimits({ LLM_TOKEN_LIMIT: "0" })).toThrow(/positive/i);
		expect(() => resolveRunLimits({ LLM_TOKEN_LIMIT: "-10" })).toThrow(/positive/i);
		expect(() => resolveRunLimits({ LLM_TOKEN_LIMIT: "1.5" })).toThrow(/integer/i);
		expect(() => resolveRunLimits({ LLM_COST_LIMIT: "0" })).toThrow(/LLM_COST_LIMIT/);
		expect(() => resolveRunLimits({ LLM_COST_LIMIT: "cheap" })).toThrow(/LLM_COST_LIMIT/);
	});
});

describe("assertCostCapEnforceable", () => {
	it("accepts a cost cap when the model has a price table", () => {
		expect(() => assertCostCapEnforceable({ tokens: null, cost: 2 }, true)).not.toThrow();
	});

	it("accepts having no cost cap regardless of pricing", () => {
		expect(() => assertCostCapEnforceable(NO_LIMITS, false)).not.toThrow();
	});

	it("refuses to start a capped run it cannot measure", () => {
		// The model has no price table, so cost stays 0 and the cap can never fire.
		// Starting anyway would silently turn a cap into no cap.
		expect(() => assertCostCapEnforceable({ tokens: null, cost: 2 }, false)).toThrow(/price table/i);
	});
});

describe("budgetStop", () => {
	const limits = { tokens: 1000, cost: 2 };

	it("returns null while the run is under both caps", () => {
		expect(budgetStop(limits, { totalTokens: 999, costTotal: 1.99 }, true)).toBeNull();
	});

	it("fires at the cap, not only past it", () => {
		expect(budgetStop(limits, { totalTokens: 1000, costTotal: 0 }, true)).toBe("token_cap");
		expect(budgetStop(limits, { totalTokens: 0, costTotal: 2 }, true)).toBe("cost_cap");
	});

	it("prefers the token cap when both are over (deterministic, always measurable)", () => {
		expect(budgetStop(limits, { totalTokens: 5000, costTotal: 9 }, true)).toBe("token_cap");
	});

	it("ignores limits that are not set", () => {
		expect(budgetStop(NO_LIMITS, { totalTokens: 10 ** 9, costTotal: 10 ** 6 }, true)).toBeNull();
	});

	it("never fires on an unmeasured reading", () => {
		// "not measured" is not "over the cap": unknown usage must not end a run.
		expect(budgetStop(limits, { totalTokens: null, costTotal: null }, true)).toBeNull();
	});

	it("cannot enforce a cost cap without a price table", () => {
		expect(budgetStop(limits, { totalTokens: 0, costTotal: 0 }, false)).toBeNull();
	});
});
