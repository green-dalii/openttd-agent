/**
 * The problem vocabulary — "one code, one hint, everywhere".
 *
 * 背景（B5 / CoDesign F8）：错误曾经是 `{error: string}`，页面用**正则**猜"401 该做什么"
 * （`providers-view.js` 的 `refreshHint()`）。于是同一个 401 在 Providers、启动失败、
 * 门禁结果里出现三种不同文案——每个页面都在自己猜。
 *
 * 这组断言锁三件事：
 *   ① 该有的 code 都在（401 / 404 / 无凭据 / 未知模型 …）。
 *   ② **每个 code 只有一个规范 hint**（一句话说清下一步做什么）——这是"同一个错
 *      在任何地方都长一个样"的实现方式。
 *   ③ `problem()` 造出来的 problem 自带这个 hint（生产方只写"发生了什么"）。
 */

import { describe, expect, it } from "vitest";
import { PROBLEM_CODES, problem, problemHint } from "../../src/agent/problems.js";

describe("the problem vocabulary", () => {
	it("covers every case the dashboard must be able to render", () => {
		for (const code of [
			"unknown_model",
			"no_credential",
			"endpoint_401",
			"endpoint_403",
			"no_model_endpoint",
			"unpriced_with_cost_cap",
			"invalid_knob",
			"unknown_provider",
			"invalid_base_url",
			"provider_unavailable",
		]) {
			expect(PROBLEM_CODES).toContain(code);
		}
	});

	it("gives every code one canonical, actionable hint", () => {
		for (const code of PROBLEM_CODES) {
			const hint = problemHint(code);
			expect(hint.trim().length).toBeGreaterThan(0);
		}
	});

	it("builds a problem that carries the canonical hint", () => {
		const p = problem("endpoint_401", "the provider answered 401");
		expect(p.code).toBe("endpoint_401");
		expect(p.message).toBe("the provider answered 401");
		expect(p.hint).toBe(problemHint("endpoint_401"));
	});

	it("lets a producer add specifics without losing the action", () => {
		const p = problem("no_credential", 'no credential for "minimax-cn"', "enter the API key below, then save");
		expect(p.hint).toContain("API key");
	});
});
