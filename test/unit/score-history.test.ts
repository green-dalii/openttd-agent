/**
 * Unit tests — the agent's own past scores as facts (S5).
 *
 * 职责: 锁定「跨局成绩以数字形式注入，并带上它的测量条件」这条契约。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §2.1 与契约 §4 的 S5。
 * 禁止: 在此断言任何评价性文案（框架不得引导）。
 */

import { describe, expect, it } from "vitest";
import { pastRunScores, renderScoreHistory } from "../../src/evolution/score-history.js";
import type { GameMetric } from "../../src/evolution/metrics.js";

function metric(over: Partial<GameMetric> = {}): GameMetric {
	return {
		id: "m1",
		seed: 11,
		mode: "agent",
		status: "completed",
		startedAt: 1_000,
		durationMs: 1_000,
		appVersion: "test",
		llmKind: "real",
		llmModel: "test-model",
		constructionDone: true,
		money: 100,
		income: -10,
		delivered: 10,
		deliveredRun: 120,
		deliveredRunComplete: true,
		gsErrors: 0,
		toolBudgetBlocks: 0,
		simulatedDays: 100,
		horizonDays: 300,
		reachedHorizon: true,
		scenario: "prebuilt",
		scenarioReason: null,
		deliveredAtReady: 0,
		worldFrozen: false,
		worldFrozenMs: null,
		vehicles: 3,
		stations: 2,
		decisions: 5,
		toolCalls: 10,
		toolFailures: 0,
		totalTokens: 1000,
		costTotal: 0.01,
		peakRequestTokens: 100,
		peakRequestTurn: 1,
		memory: { lessonsInjected: 0, strategiesInjected: 0, routeFactsInjected: 0 },
		...over,
	};
}

describe("pastRunScores（可比的历史成绩）", () => {
	it("只收同场景同 horizon 的可局，并给出每游戏日速率", () => {
		const rows = [
			metric({ id: "a", seed: 11, deliveredRun: 120, simulatedDays: 100 }),
			metric({ id: "b", seed: 22, deliveredRun: 300, simulatedDays: 150 }),
		];
		const h = pastRunScores(rows, { scenario: "prebuilt", horizonDays: 300 });
		expect(h.runs).toHaveLength(2);
		expect(h.runs[0]!.deliveredPerGameDay).toBe(1.2);
		expect(h.runs[1]!.deliveredPerGameDay).toBe(2);
		expect(h.conditions).toEqual({ scenario: "prebuilt", horizonDays: 300 });
	});

	it("场景/horizon 不同的局不算可比，但要报出来（不能静默丢）", () => {
		const rows = [
			metric({ id: "a", scenario: "prebuilt" }),
			metric({ id: "b", scenario: "freeform" }),
			metric({ id: "c", horizonDays: 180 }),
		];
		const h = pastRunScores(rows, { scenario: "prebuilt", horizonDays: 300 });
		expect(h.runs).toHaveLength(1);
		expect(h.excluded).toBe(2);
		expect(h.excludedReasons).toEqual(["different scenario or horizon", "different scenario or horizon"]);
	});

	it("被暂停/世界冻结的局不参与比较（它们不是「没学会」）", () => {
		const rows = [
			metric({ id: "a" }),
			metric({ id: "b", blockedByPause: true }),
		];
		const h = pastRunScores(rows, { scenario: "prebuilt", horizonDays: 300 });
		expect(h.runs).toHaveLength(1);
		expect(h.excludedReasons.some((r) => r.includes("stopped"))).toBe(true);
	});

	it("没有成绩读数的局不可比 → 被排除并报出来（而不是当作 0 分）", () => {
		const h = pastRunScores([metric({ deliveredRun: null })], { scenario: "prebuilt", horizonDays: 300 });
		expect(h.runs).toEqual([]);
		expect(h.excluded).toBe(1);
		expect(h.excludedReasons).toContain("outcome not measured");
	});

	it("交付量为 0 是**真实读数** → 速率为 0 并列出", () => {
		const h = pastRunScores([metric({ deliveredRun: 0, simulatedDays: 100 })], {
			scenario: "prebuilt",
			horizonDays: 300,
		});
		expect(h.runs).toHaveLength(1);
		expect(h.runs[0]!.deliveredPerGameDay).toBe(0);
	});

	it("没有可比的过去局 → runs 为空（注入时就不出现这一块）", () => {
		const h = pastRunScores([], { scenario: "prebuilt", horizonDays: 300 });
		expect(h.runs).toEqual([]);
	});
});

describe("renderScoreHistory（注入用的事实块）", () => {
	it("写出每个局的速率与测量条件", () => {
		const h = pastRunScores([metric({ seed: 11, deliveredRun: 120, simulatedDays: 100 })], {
			scenario: "prebuilt",
			horizonDays: 300,
		});
		const text = renderScoreHistory(h)!;
		expect(text).toContain("11");
		expect(text).toContain("1.2");
		expect(text).toContain("prebuilt");
		expect(text).toContain("300");
	});

	it("没有历史局 → null（不注入空块）", () => {
		const h = pastRunScores([], { scenario: "prebuilt", horizonDays: 300 });
		expect(renderScoreHistory(h)).toBeNull();
	});
});
