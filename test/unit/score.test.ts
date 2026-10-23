/**
 * Unit tests — the agent's own score facts (S1).
 *
 * 职责: 锁定「模型看到的分 = 最终被记的分」这条契约，以及「缺失不折零」。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §2.1（score 块）；度量口径见 SPEC.md §10.65。
 * 禁止: 在此断言任何评价性文案（"做得好/落后"不是事实）。
 */

import { describe, expect, it } from "vitest";
import { projectScore } from "../../src/agent/score.js";
import { buildDecisionContext, emptyTracker } from "../../src/agent/decision-context.js";

describe("projectScore（模型可见的成绩事实）", () => {
	it("给出的 delivered 就是累计读数，速率按已历游戏日算", () => {
		const s = projectScore({
			deliveredTotal: 300,
			gameDay: 100,
			horizonDays: 300,
			scoredFromGameDay: null,
			windowOpened: true,
		});
		expect(s.delivered).toBe(300);
		expect(s.elapsedGameDays).toBe(100);
		expect(s.deliveredPerGameDay).toBe(3);
		expect(s.horizonDays).toBe(300);
	});

	it("没有交付读数 → delivered 为 null（不是 0）", () => {
		const s = projectScore({
			deliveredTotal: null,
			gameDay: 10,
			horizonDays: 300,
			scoredFromGameDay: null,
			windowOpened: true,
		});
		expect(s.delivered).toBeNull();
		expect(s.deliveredPerGameDay).toBeNull();
	});

	it("还没过一天 → 每游戏日速率未知（null），不是 0 也不是 Infinity", () => {
		const s = projectScore({
			deliveredTotal: 0,
			gameDay: 0,
			horizonDays: 300,
			scoredFromGameDay: null,
			windowOpened: true,
		});
		expect(s.delivered).toBe(0);
		expect(s.deliveredPerGameDay).toBeNull();
	});

	it("计分窗口未开启 → windowOpened=false，窗口起点仍然是一个事实", () => {
		const s = projectScore({
			deliveredTotal: 0,
			gameDay: 12,
			horizonDays: 300,
			scoredFromGameDay: 30,
			windowOpened: false,
		});
		expect(s.windowOpened).toBe(false);
		expect(s.scoredFromGameDay).toBe(30);
	});

	it("horizon 未设 → null（不是 0 天）", () => {
		const s = projectScore({
			deliveredTotal: 10,
			gameDay: 10,
			horizonDays: null,
			scoredFromGameDay: null,
			windowOpened: true,
		});
		expect(s.horizonDays).toBeNull();
	});
});

describe("决策上下文携带 score 块", () => {
	it("score 块出现在上下文里（否则模型看不到自己的分）", () => {
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: "1950-05-01", companies: [{ id: 0, money: 100, loan: null, income: -5, vehicles: 2, stations: 2 }] },
			since: emptyTracker(),
			gameDay: 50,
			score: {
				delivered: 120,
				deliveredPerGameDay: 2.4,
				elapsedGameDays: 50,
				horizonDays: 300,
				scoredFromGameDay: null,
				windowOpened: true,
			},
		});
		expect(ctx.score).toBeDefined();
		expect(ctx.score!.delivered).toBe(120);
		expect(ctx.score!.deliveredPerGameDay).toBe(2.4);
		expect(ctx.score!.horizonDays).toBe(300);
	});

	it("没有 score 事实时不凭空造一个（字段缺席 ≠ 0）", () => {
		const ctx = buildDecisionContext({
			trigger: "start",
			now: { date: "1950-01-01", companies: [] },
			since: emptyTracker(),
		});
		expect(ctx.score).toBeUndefined();
	});
});
