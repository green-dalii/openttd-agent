/**
 * Unit tests — the benchmark scorecard and report (D5b).
 *
 * 职责: 锁定四轴分数卡的**诚实性**——缺失就是 null（不是 0）、被排除的局要报出来、
 *   每个数字都带着它的测量条件。基准报告最容易骗人的方式就是"平均值不带 n"。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §3（分数卡的四个正交轴）。
 * 禁止: 在此断言任何"哪个模型更好"的评语（那是读报告的人的事）。
 */

import { describe, expect, it } from "vitest";
import { projectManifest } from "../../src/agent/manifest.js";
import { buildScorecard } from "../../src/evolution/scorecard.js";
import { renderReportMarkdown } from "../../src/evolution/bench-report.js";
import { pairedComparison } from "../../src/evolution/bench-stats.js";
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
		delivered: 10,
		deliveredRun: 120,
		deliveredRunComplete: true,
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

describe("buildScorecard（四轴，缺失不折零）", () => {
	it("按模型分组，能力轴给每游戏日交付的中位与均值", () => {
		const card = buildScorecard([
			row({ llmModel: "a", deliveredRun: 100, simulatedDays: 100 }),
			row({ llmModel: "a", deliveredRun: 300, simulatedDays: 100 }),
			row({ llmModel: "b", deliveredRun: 50, simulatedDays: 100 }),
		]);
		const a = card.models.find((m) => m.model === "a")!;
		expect(a.runs).toBe(2);
		expect(a.ability.mean).toBe(2); // (1 + 3)/2
		expect(a.ability.median).toBe(2);
		const b = card.models.find((m) => m.model === "b")!;
		expect(b.ability.mean).toBe(0.5);
	});

	it("效率轴：每 1M token 的交付（分母为 0 时 null，不是 Infinity）", () => {
		const card = buildScorecard([
			row({ llmModel: "a", deliveredRun: 1000, simulatedDays: 100, totalTokens: 500_000 }),
			row({ llmModel: "b", deliveredRun: 1000, simulatedDays: 100, totalTokens: 0 }),
		]);
		expect(card.models.find((m) => m.model === "a")!.efficiency.deliveredPerMillionTokens).toBe(2000);
		expect(card.models.find((m) => m.model === "b")!.efficiency.deliveredPerMillionTokens).toBeNull();
	});

	it("两条轴都自报「交付」到底算什么（服务端措辞，页面照抄）", () => {
		// admin 的 deliveredCargo 是 OpenTTD **按货种的交付数组的求和**，客运也在里面
		// ⇒ 它**已经**同时计入货物与客运；写 "cargo" 是在说谎（SPEC §10.65）。
		const card = buildScorecard([row({ llmModel: "a" })]);
		const a = card.models.find((m) => m.model === "a")!;
		expect(a.ability.measure).toBe("cargo + passengers delivered");
		expect(a.efficiency.measure).toBe("cargo + passengers delivered");
	});

	it("「没测到」时仍然报出计量口径（口径是事实，不随数值消失）", () => {
		const card = buildScorecard([row({ llmModel: "a", deliveredRun: null, simulatedDays: 0 })]);
		const a = card.models.find((m) => m.model === "a")!;
		expect(a.ability.mean).toBeNull();
		expect(a.ability.measure).toBe("cargo + passengers delivered");
	});

	it("稳定性轴：结果分类分布 + 工具失败率", () => {
		const card = buildScorecard([
			row({ llmModel: "a", deliveredRun: 0, constructionDone: false, toolCalls: 4, toolFailures: 4 }),
			row({ llmModel: "a", deliveredRun: 10 }),
		]);
		const a = card.models.find((m) => m.model === "a")!;
		expect(a.stability.outcomes.refused).toBe(1);
		expect(a.stability.outcomes.delivered).toBe(1);
		// calls = 4 + 10, failures = 4 + 1 (the second row's default failure counts too)
		expect(a.stability.toolFailureRate).toBeCloseTo(5 / 14, 5);
	});

	it("被排除的局单独计数并说明原因（不能静默消失）", () => {
		const card = buildScorecard([
			row({ llmModel: "a" }),
			row({ llmModel: "a", blockedByPause: true }),
			row({ llmModel: "a", llmKind: "faux" }),
		]);
		const a = card.models.find((m) => m.model === "a")!;
		expect(a.runs).toBe(1);
		expect(a.excluded).toBe(2);
		expect(a.excludedReasons.some((r) => r.includes("stopped"))).toBe(true);
		expect(a.excludedReasons.some((r) => r.includes("demo"))).toBe(true);
	});

	it("一个模型都没测到 → 该轴为 null（不是 0）", () => {
		const card = buildScorecard([row({ llmModel: "a", deliveredRun: null, simulatedDays: null })]);
		const a = card.models.find((m) => m.model === "a")!;
		expect(a.ability.mean).toBeNull();
	});

	it("报告带上测量条件（没有条件的数字不发布）", () => {
		const card = buildScorecard([row({ llmModel: "a" })], {
			conditions: { scenario: "prebuilt", horizonDays: 300, seeds: [11], repeats: 1 },
		});
		expect(card.conditions).toEqual({ scenario: "prebuilt", horizonDays: 300, seeds: [11], repeats: 1 });
	});

	it("增长轴：给每模型的学习曲线判决（不可判定也要写出来）", () => {
		const card = buildScorecard([
			row({ llmModel: "a", deliveredRun: 10, simulatedDays: 100, startedAt: 1 }),
			row({ llmModel: "a", deliveredRun: 12, simulatedDays: 100, startedAt: 2 }),
		]);
		const a = card.models.find((m) => m.model === "a")!;
		// 两局不足以判趋势 → not determinable（不是「没有增长」）
		expect(a.growth.verdict).toBe("not determinable");
	});
});

describe("renderReportMarkdown（人读报告）", () => {
	it("列出每个模型的四轴与测量条件", () => {
		const card = buildScorecard([row({ llmModel: "a" })], {
			conditions: { scenario: "prebuilt", horizonDays: 300, seeds: [11], repeats: 1 },
		});
		const md = renderReportMarkdown(card);
		expect(md).toContain("a");
		expect(md).toContain("prebuilt");
		expect(md).toContain("300");
		// 缺失/未知必须显式写出，而不是留空
		expect(md).toMatch(/not measured|unknown|—/);
	});

	it("没有模型时也给出可读的空态（不是空白文件）", () => {
		const md = renderReportMarkdown(buildScorecard([]));
		expect(md.length).toBeGreaterThan(20);
		expect(md).toMatch(/no runs|no model/i);
	});
});

/**
 * D5c / #11：同 seed 配对比较。
 *
 * 两个模型跑在**同一张地图**上时，结果相关——不配对就等于把可消掉的方差又付一遍。
 * 这里锁三件事：配对按 (seed, repeat)、缺失的配对**不冒充 0 差异**、CI 用差异算。
 */
describe("pairedComparison（同 seed 配对）", () => {
	it("按 (seed, repeat) 配对，差异是每游戏日交付之差", () => {
		const rows = [
			row({ llmModel: "a", seed: 1, deliveredRun: 100, simulatedDays: 100 }),
			row({ llmModel: "b", seed: 1, deliveredRun: 150, simulatedDays: 100 }),
			row({ llmModel: "a", seed: 2, deliveredRun: 200, simulatedDays: 100 }),
			row({ llmModel: "b", seed: 2, deliveredRun: 200, simulatedDays: 100 }),
		];
		const cmp = pairedComparison(rows, "a", "b");
		expect(cmp.pairs).toHaveLength(2);
		// A delivered 1.0 and 2.0 per game day; B delivered 1.5 and 2.0.
		// diff = A - B ⇒ negative where A did less.
		expect(cmp.pairs.map((p) => p.diff)).toEqual([-0.5, 0]);
		expect(cmp.meanDiff).toBeCloseTo(-0.25, 5);
	});

	it("一侧缺失的配对不计入（不能当成 0 差异）", () => {
		const rows = [
			row({ llmModel: "a", seed: 1, deliveredRun: 100, simulatedDays: 100 }),
			row({ llmModel: "b", seed: 2, deliveredRun: 100, simulatedDays: 100 }),
		];
		const cmp = pairedComparison(rows, "a", "b");
		expect(cmp.pairs).toHaveLength(0);
		expect(cmp.meanDiff).toBeNull();
	});

	it("配对 CI 用差异算；点太少 → 不可判定（不是「无差异」）", () => {
		const rows = [
			row({ llmModel: "a", seed: 1, deliveredRun: 100, simulatedDays: 100 }),
			row({ llmModel: "b", seed: 1, deliveredRun: 150, simulatedDays: 100 }),
		];
		const cmp = pairedComparison(rows, "a", "b");
		expect(cmp.verdict).toBe("not determinable");
		expect(cmp.message).toMatch(/pair/i);
	});

	it("报告里写明用了配对设计（否则读者会按独立样本理解 n）", () => {
		const rows = [1, 2, 3, 4, 5, 6].flatMap((seed) => [
			row({ llmModel: "a", seed, deliveredRun: 100 + seed * 10, simulatedDays: 100 }),
			row({ llmModel: "b", seed, deliveredRun: 100, simulatedDays: 100 }),
		]);
		const cmp = pairedComparison(rows, "a", "b");
		expect(cmp.design).toBe("paired");
		expect(cmp.pairs.length).toBe(6);
	});
});

describe("未定价的模型不得进入效率轴", () => {
	it("excludes cost from runs whose model has no price table", () => {
		// Without this, a custom endpoint's 0 would be averaged in as "$0.00 per
		// run" - a claim about price that nobody measured.
		const stated = row({ id: "a", costTotal: 2, costKnown: true });
		const unpriced = row({ id: "b", costTotal: 0, costKnown: false });
		const card = buildScorecard([stated, unpriced]);
		const model = card.models[0]!;
		expect(model.efficiency.costPerRun).toBeCloseTo(2, 6);
	});

	it("reports not measured when every run is unpriced", () => {
		const card = buildScorecard([row({ id: "b", costTotal: 0, costKnown: false })]);
		expect(card.models[0]!.efficiency.costPerRun).toBeNull();
	});
});

describe("网关替换可见（D5b × S9）", () => {
	it("两个请求被服务成同一个模型 → 合并，但把请求列表写出来（不静默合并）", () => {
		const card = buildScorecard([
			row({ llmModel: "req-a", manifest: projectManifest({ servedModel: "real-x" }) }),
			row({ llmModel: "req-b", manifest: projectManifest({ servedModel: "real-x" }) }),
		]);
		expect(card.models).toHaveLength(1);
		expect(card.models[0]!.model).toBe("real-x");
		expect(card.models[0]!.requestedModels).toEqual(["req-a", "req-b"]);
		const md = renderReportMarkdown(card);
		expect(md).toContain("requested: req-a, req-b");
	});
});
