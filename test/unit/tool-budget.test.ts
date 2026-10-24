/**
 * Tool budget semantics (SPEC §4.1 / ADR §10.74).
 *
 * 为什么这些断言值得存在：预算的两种失效都会静默毁掉一局实验 ——
 * 拒绝时也扣预算 ⇒ 模型以为 5 次就用完了；不记拒绝次数 ⇒ "代理停止探索"
 * 与"预算把它掐住"无法区分。两者都不报错，只改变结果。
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_TOOL_CALLS_PER_DECISION,
	ToolBudget,
	budgetRefusal,
} from "../../src/agent/tool-budget.js";

describe("ToolBudget", () => {
	it("admits up to the limit, then refuses", () => {
		const b = new ToolBudget(3);
		expect(b.admit()).toBeUndefined();
		expect(b.admit()).toBeUndefined();
		expect(b.admit()).toBeUndefined();
		expect(b.admit()).toBe(budgetRefusal(3));
		expect(b.used).toBe(3);
		expect(b.blocked).toBe(1);
	});

	it("does not consume budget on a refused call", () => {
		// If a refusal consumed budget, a model that retries once would have one
		// fewer usable call than a model that does not — the budget would become
		// a function of the model's mistakes rather than of the decision window.
		const b = new ToolBudget(2);
		b.admit();
		b.admit();
		for (let i = 0; i < 5; i++) expect(b.admit()).toBeTypeOf("string");
		expect(b.used).toBe(2);
		expect(b.blocked).toBe(5);
	});

	it("resets the window but keeps the cumulative block count", () => {
		const b = new ToolBudget(1);
		b.admit();
		expect(b.admit()).toBeTypeOf("string");
		b.reset();
		expect(b.used).toBe(0);
		expect(b.admit()).toBeUndefined();
		// The run-level number must survive: it is the health signal.
		expect(b.blocked).toBe(1);
	});

	it("treats a non-positive limit as unlimited", () => {
		const b = new ToolBudget(0);
		for (let i = 0; i < 50; i++) expect(b.admit()).toBeUndefined();
		expect(b.blocked).toBe(0);
	});

	it("defaults to the measured budget", () => {
		expect(DEFAULT_MAX_TOOL_CALLS_PER_DECISION).toBe(12);
		const b = new ToolBudget();
		for (let i = 0; i < DEFAULT_MAX_TOOL_CALLS_PER_DECISION; i++) expect(b.admit()).toBeUndefined();
		expect(b.admit()).toBe(budgetRefusal(DEFAULT_MAX_TOOL_CALLS_PER_DECISION));
	});

	it("states the limit and the fresh-budget promise in the refusal", () => {
		// The model's only feedback is this string; both facts have to be in it.
		const text = budgetRefusal(7);
		expect(text).toContain("7 calls used");
		expect(text).toContain("fresh budget next decision");
	});
});
