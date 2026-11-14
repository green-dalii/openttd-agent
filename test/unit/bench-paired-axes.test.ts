/**
 * Unit tests — the paired comparison on every axis (issue #87).
 *
 * 职责: 锁定"配对统计**按轴**给结论"的诚实性——轴要说清是哪个轴、单位是什么、
 *   一侧缺失的配对不计入、配对太少不可判定、同一份数据两次算出的区间必须一样。
 * 为什么存在: 旧实现把指标写死成"每游戏日交付"，于是次级轴（每 1M token 交付、
 *   工具失败率）**没有配对区间** ⇒ 看起来分得开 ≠ 判定成立。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §3（配对统计按轴给结论）。
 * 禁止: 在此断言任何"哪个模型更好"的评语（那是读报告的人的事）。
 */

import { describe, expect, it } from "vitest";
import {
	PAIRED_METRICS,
	pairedComparison,
	pairedComparisons,
	pairedMetric,
} from "../../src/evolution/bench-stats.js";
import { buildScorecard } from "../../src/evolution/scorecard.js";
import { renderReportMarkdown } from "../../src/evolution/bench-report.js";
import type { GameMetric } from "../../src/evolution/metrics.js";

function row(over: Partial<GameMetric> = {}): GameMetric {
	return {
		id: "r1",
		seed: 11,
		mode: "agent",
		status: "completed",
		startedAt: 1_000,
		durationMs: 60_000,
		appVersion: "t",
		llmKind: "real",
		llmModel: "model-a",
		constructionDone: true,
		money: 0,
		income: -10,
		netCashFlow: null,
		netCashFlowVerified: null,
		profitPerDay: null,
		operatingProfit: null,
		operatingProfitPerDay: null,
		operatingProfitComplete: null,
		delivered: 10,
		deliveredRun: 120,
		deliveredRunComplete: true,
		deliveredByCargo: null,
		gsErrors: 0,
		toolBudgetBlocks: 0,
		worldFrozenMs: null,
		simulatedDays: 100,
		horizonDays: 300,
		reachedHorizon: true,
		scenario: "prebuilt",
		scenarioReason: null,
		deliveredAtReady: 0,
		vehicles: 3,
		stations: 2,
		decisions: 5,
		toolCalls: 10,
		toolFailures: 1,
		totalTokens: 100_000,
		costTotal: 0.5,
		peakRequestTokens: 5000,
		peakRequestTurn: 1,
		memory: { lessonsInjected: 0, strategiesInjected: 0, routeFactsInjected: 0 },
		...over,
	};
}

/** Three seeds; A delivers 2x what B delivers, per game day. */
function separated(): GameMetric[] {
	return [1, 2, 3].flatMap((seed) => [
		row({ llmModel: "a", seed, deliveredRun: 200, simulatedDays: 100 }),
		row({ llmModel: "b", seed, deliveredRun: 100, simulatedDays: 100 }),
	]);
}

describe("配对指标的目录（轴 = 逐局能取标量的轴）", () => {
	it("三个轴各有主指标，且成长轴不在其中（它的主指标是跨局斜率）", () => {
		const axes = new Set(PAIRED_METRICS.map((m) => m.axis));
		expect([...axes].sort()).toEqual(["ability", "efficiency", "stability"]);
		expect(PAIRED_METRICS.map((m) => m.axis as string)).not.toContain("growth");
	});

	it("每个指标都说清：标签、单位、逐局取值", () => {
		for (const m of PAIRED_METRICS) {
			expect(m.label.length).toBeGreaterThan(0);
			expect(m.unit.length).toBeGreaterThan(0);
			expect(typeof m.value).toBe("function");
		}
	});

	it("每个指标都说清哪个方向更好（或者明说它没有好坏）", () => {
		for (const m of PAIRED_METRICS) {
			expect(["higher", "lower", null]).toContain(m.betterWhen);
		}
		// 效率轴：多花 token、多花时间 ⇒ 差；能力轴：多交付 ⇒ 好。
		expect(pairedMetric("efficiency.tokensPerDecision").betterWhen).toBe("lower");
		expect(pairedMetric("efficiency.secondsPerRun").betterWhen).toBe("lower");
		expect(pairedMetric("ability.deliveredPerGameDay").betterWhen).toBe("higher");
		// 站点数/车辆数不带好坏（多不一定好）。
		expect(pairedMetric("ability.stations").betterWhen).toBeNull();
	});

	it("货运轴也有配对指标（monitor 的货物交付量/游戏日）", () => {
		const m = pairedMetric("ability.cargoDeliveredPerGameDay");
		expect(m.axis).toBe("ability");
		expect(m.betterWhen).toBe("higher");
		expect(m.unit).toBe("per game day");
		// monitor 的口径：只有货物那一半（PASS 是旅客，不算货物）。
		const cargo = row({
			deliveredByCargo: [
				{ label: "COAL", amount: 120 },
				{ label: "PASS", amount: 40 },
			],
			simulatedDays: 250,
		});
		expect(m.value(cargo)).toBeCloseTo(120 / 250, 10);
	});

	it("没测到货物拆分 ⇒ 货物轴读数是 null（不是 0）", () => {
		const m = pairedMetric("ability.cargoDeliveredPerGameDay");
		expect(m.value(row({ deliveredByCargo: null }))).toBeNull();
		expect(m.value(row({ deliveredByCargo: [] }))).toBeNull();
	});

	it("未知指标 id 报出来（不静默退回主轴）", () => {
		expect(() => pairedMetric("nope")).toThrow(/nope/);
	});
});

describe("pairedComparison（按轴）", () => {
	it("默认仍是主轴（每游戏日交付）——旧调用方行为不变", () => {
		const cmp = pairedComparison(separated(), "a", "b");
		expect(cmp.metricId).toBe("ability.deliveredPerGameDay");
		expect(cmp.pairs).toHaveLength(3);
		expect(cmp.meanDiff).toBeCloseTo(1, 5);
	});

	it("同一批行在另一个轴上给另一个结论（效率轴：每 1M token）", () => {
		const rows = [
			row({ llmModel: "a", seed: 1, deliveredRun: 200, simulatedDays: 100, totalTokens: 100_000 }),
			row({ llmModel: "b", seed: 1, deliveredRun: 100, simulatedDays: 100, totalTokens: 100_000 }),
			row({ llmModel: "a", seed: 2, deliveredRun: 200, simulatedDays: 100, totalTokens: 100_000 }),
			row({ llmModel: "b", seed: 2, deliveredRun: 100, simulatedDays: 100, totalTokens: 100_000 }),
			row({ llmModel: "a", seed: 3, deliveredRun: 200, simulatedDays: 100, totalTokens: 100_000 }),
			row({ llmModel: "b", seed: 3, deliveredRun: 100, simulatedDays: 100, totalTokens: 100_000 }),
		];
		const cmp = pairedComparison(rows, "a", "b", "efficiency.deliveredPerMillionTokens");
		expect(cmp.pairs).toHaveLength(3);
		// A: 200 delivered over 100_000 tokens => 2000 per 1M tokens.
		// B: 100 over 100_000 tokens => 1000 per 1M tokens ⇒ the difference is 1000.
		expect(cmp.meanDiff).toBeCloseTo(1000, 5);
		expect(cmp.unit).toMatch(/1M tokens/);
	});

	it("工具失败率也能配对（稳定性轴）", () => {
		const rows = [1, 2, 3].flatMap((seed) => [
			row({ llmModel: "a", seed, toolCalls: 10, toolFailures: 5 }),
			row({ llmModel: "b", seed, toolCalls: 10, toolFailures: 1 }),
		]);
		const cmp = pairedComparison(rows, "a", "b", "stability.toolFailureRate");
		expect(cmp.pairs).toHaveLength(3);
		expect(cmp.meanDiff).toBeCloseTo(0.4, 5);
	});

	it("一侧没测到的配对不计入（不是 0 差异）", () => {
		const rows = [
			row({ llmModel: "a", seed: 1, toolCalls: 10, toolFailures: 5 }),
			row({ llmModel: "b", seed: 1, toolCalls: 0, toolFailures: 0 }),
			row({ llmModel: "a", seed: 2, toolCalls: 10, toolFailures: 5 }),
			row({ llmModel: "b", seed: 2, toolCalls: 10, toolFailures: 1 }),
			row({ llmModel: "a", seed: 3, toolCalls: 10, toolFailures: 5 }),
			row({ llmModel: "b", seed: 3, toolCalls: 10, toolFailures: 1 }),
		];
		const cmp = pairedComparison(rows, "a", "b", "stability.toolFailureRate");
		expect(cmp.pairs).toHaveLength(2);
		expect(cmp.pairs.every((p) => p.diff > 0)).toBe(true);
	});

	it("配对是按「局」定的，不随轴变（一个轴缺读数不许把两局错配）", () => {
		// A 的第 1 局没有稳定性读数（toolCalls = 0 ⇒ 没测到）。
		// 若配对按「有读数的行」编号，A 的第 1 局会被挤到槽 1，于是与 B 的
		// 第 1 局配对 ⇒ 差值变成 0.4 - 0.1 = 0.3（错的）。
		// 按「局」定配对时，这一格被**整格丢掉**（n=2），剩下的两格差值不变。
		const rows = [
			row({ llmModel: "a", seed: 1, toolCalls: 0, toolFailures: 0 }),
			row({ llmModel: "b", seed: 1, toolCalls: 10, toolFailures: 1 }),
			row({ llmModel: "a", seed: 2, toolCalls: 10, toolFailures: 5 }),
			row({ llmModel: "b", seed: 2, toolCalls: 10, toolFailures: 1 }),
			row({ llmModel: "a", seed: 3, toolCalls: 10, toolFailures: 5 }),
			row({ llmModel: "b", seed: 3, toolCalls: 10, toolFailures: 1 }),
		];
		const cmp = pairedComparison(rows, "a", "b", "stability.toolFailureRate");
		expect(cmp.pairs).toHaveLength(2);
		expect(cmp.pairs.map((p) => p.seed)).toEqual([2, 3]);
		expect(cmp.pairs.every((p) => Math.abs(p.diff - 0.4) < 1e-9)).toBe(true);
		// 主轴的配对集合不受影响（三个种子都在）。
		expect(pairedComparison(rows, "a", "b").pairs).toHaveLength(3);
	});

	it("判定方向与指标的好坏方向分开：效率轴上「b 更高」= b 更差", () => {
		// B 在「每决策 token」上比 A **高**（B 更差）⇒ verdict 是 b_higher，
		// 但 betterModel 必须是 **A** ⇒ 页面不会把方向读成胜负。
		const rows = [1, 2, 3].flatMap((seed) => [
			row({ llmModel: "a", seed, decisions: 10, totalTokens: 10_000 }),
			row({ llmModel: "b", seed, decisions: 10, totalTokens: 20_000 }),
		]);
		const cmp = pairedComparison(rows, "a", "b", "efficiency.tokensPerDecision");
		expect(cmp.verdict).toBe("b_higher");
		expect(cmp.betterModel).toBe("a");
	});

	it("没有好坏方向的指标不给「谁更好」", () => {
		const rows = [1, 2, 3].flatMap((seed) => [
			row({ llmModel: "a", seed, stations: 5 }),
			row({ llmModel: "b", seed, stations: 2 }),
		]);
		const cmp = pairedComparison(rows, "a", "b", "ability.stations");
		expect(cmp.verdict).toBe("a_higher");
		expect(cmp.betterModel).toBeNull();
	});

	it("不可判定时不给「谁更好」", () => {
		const cmp = pairedComparison(separated().slice(0, 2), "a", "b");
		expect(cmp.verdict).toBe("not determinable");
		expect(cmp.betterModel).toBeNull();
	});

	it("配对太少 → 不可判定（不是「无差异」）", () => {
		const cmp = pairedComparison(separated().slice(0, 2), "a", "b");
		expect(cmp.verdict).toBe("not determinable");
		expect(cmp.diffCi95).toBeNull();
		expect(cmp.message).toMatch(/pair/i);
	});

	it("区间是确定的：同一份数据两次算出来一样", () => {
		const first = pairedComparison(separated(), "a", "b");
		const second = pairedComparison(separated(), "a", "b");
		expect(first.diffCi95).toEqual(second.diffCi95);
	});

	it("报告写清轴、单位与 n（读者要知道在比什么）", () => {
		const cmp = pairedComparison(separated(), "a", "b");
		expect(cmp.axisLabel.length).toBeGreaterThan(0);
		expect(cmp.unit.length).toBeGreaterThan(0);
		expect(cmp.message).toMatch(/n=3/);
	});

	it("没有可用的配对时说清是哪个轴", () => {
		const cmp = pairedComparison([], "a", "b", "efficiency.deliveredPerMillionTokens");
		expect(cmp.verdict).toBe("not determinable");
		expect(cmp.meanDiff).toBeNull();
		expect(cmp.message).toMatch(/1M tokens|token/i);
	});
});

describe("基准报告：配对判定按轴写出来", () => {
	it("Markdown 里有每个轴的判定（轴、单位、n）", () => {
		const rows = separated();
		const md = renderReportMarkdown(
			buildScorecard(rows),
			new Date("2026-11-08T00:00:00Z"),
			pairedComparisons(rows, "a", "b"),
		);
		expect(md).toMatch(/Paired comparison/i);
		expect(md).toMatch(/per game day/);
		expect(md).toMatch(/per 1M tokens/);
		expect(md).toMatch(/share of tool calls/);
		expect(md).toMatch(/n=3/);
	});

	it("报告写清哪个模型更好（效率轴方向相反时也不会写反）", () => {
		const rows = [1, 2, 3].flatMap((seed) => [
			row({ llmModel: "a", seed, decisions: 10, totalTokens: 10_000 }),
			row({ llmModel: "b", seed, decisions: 10, totalTokens: 20_000 }),
		]);
		const md = renderReportMarkdown(
			buildScorecard(rows),
			new Date("2026-11-08T00:00:00Z"),
			pairedComparisons(rows, "a", "b"),
		);
		expect(md).toMatch(/a \(lower is better\)/);
	});

	it("没有配对时也写清楚（不是空白章节）", () => {
		const md = renderReportMarkdown(
			buildScorecard(separated()),
			new Date("2026-11-08T00:00:00Z"),
			[],
		);
		expect(md).toMatch(/no paired comparison/i);
	});
});
