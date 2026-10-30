/**
 * The outcome vocabulary — "every outcome has a name, and the name is the server's".
 *
 * 背景（B5 / CoDesign F5）：后端早就有 10 类成因（`src/evolution/outcome.ts`），但页面
 * 只报得出一部分，最可行动的一类（`refused`：所有工具调用被拒）**完全不可见**——
 * 它恰恰是"模型在乱试"的信号。
 *
 * 这组断言锁三件事：
 *   ① 词表就是那 10 类，**不多不少**（少一类 = 有一类局永远说不清自己）。
 *   ② 每一类都有**可显示的名字**和**可执行的解释**（"这是什么意思、该做什么"）。
 *   ③ 每一类都能从事实**构造出来**（不是理论上的枚举值）。
 *
 * 为什么名字与解释由服务端给：页面自己写一份词表，就等于把"这个结果意味着什么"
 * 变成两份实现，迟早漂移（MEMORY C1 的同款机制）。
 */

import { describe, expect, it } from "vitest";
import {
	OUTCOME_CLASSES,
	classifyOutcome,
	describeOutcome,
	type OutcomeClass,
} from "../../src/evolution/outcome.js";

/** Facts that must produce each of the ten classes. */
const FACTS: Record<OutcomeClass, Record<string, unknown>> = {
	delivered: { deliveredRun: 12, constructionDone: true },
	delivered_nothing: { deliveredRun: 0, constructionDone: true },
	no_construction: { deliveredRun: 0, constructionDone: false },
	refused: { deliveredRun: 0, toolCalls: 3, toolFailures: 3 },
	paused_by_agent: { blockedByPause: true, deliveredRun: 5 },
	world_frozen: { worldFrozen: true, deliveredRun: 5 },
	wall_clock_cap: { reachedHorizon: false, deliveredRun: 0 },
	token_cap: {
		reachedHorizon: false,
		deliveredRun: 0,
		totalTokens: 120,
		manifest: { tokenLimit: 100 },
	},
	cost_cap: {
		reachedHorizon: false,
		deliveredRun: 0,
		costTotal: 2,
		costKnown: true,
		manifest: { costLimit: 1 },
	},
	unknown: {},
};

describe("the outcome vocabulary", () => {
	it("names exactly the ten classes the backend knows", () => {
		expect([...OUTCOME_CLASSES]).toEqual([
			"delivered",
			"delivered_nothing",
			"no_construction",
			"refused",
			"paused_by_agent",
			"world_frozen",
			"wall_clock_cap",
			"token_cap",
			"cost_cap",
			"unknown",
		]);
	});

	it("gives every class a name and an actionable explanation", () => {
		for (const code of OUTCOME_CLASSES) {
			const d = describeOutcome(code);
			expect(d.code).toBe(code);
			expect(d.label.trim().length).toBeGreaterThan(0);
			expect(d.hint.trim().length).toBeGreaterThan(0);
		}
	});

	it("does not give two classes the same name", () => {
		const labels = OUTCOME_CLASSES.map((c) => describeOutcome(c).label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("can name every class from facts", () => {
		for (const code of OUTCOME_CLASSES) {
			expect(classifyOutcome(FACTS[code])).toBe(code);
		}
	});

	it("still reports 'unknown' when the readings are missing", () => {
		// A missing reading is not "nothing happened" (D60).
		expect(classifyOutcome(null)).toBe("unknown");
		expect(classifyOutcome({})).toBe("unknown");
	});
});
