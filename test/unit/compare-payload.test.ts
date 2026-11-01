/**
 * The Compare payload (server side) — B4/B5.
 *
 * 职责: 锁定 `buildCompareView` 的**搬运**性质与**缺失**语义。
 * 为什么值得单测:
 *   1. **它不重算**：四轴来自 `buildScorecard`，配对判定来自 `pairedComparison`，
 *      排除原因来自 `metricExclusion`；本模块只搬运（页面也不许重算）。
 *   2. **缺失 ≠ 0**：没价目表的模型 `costPerRun` 是 `null`（"没测到"），不是 $0。
 *   3. **结局词表是服务端的**（B5）：十类成因按服务端给的 `code/label/hint` 出现在
 *      载荷里，页面照抄即可，不必自己再写一份词表。
 *
 * 禁止: 在此断言页面的 DOM 结构。
 */

import { describe, expect, it } from "vitest";
import { buildCompareView } from "../../src/evolution/compare-view.js";
import type { GameMetric } from "../../src/evolution/metrics.js";

/** One metric row; the fields the compare view reads. */
function row(over: Partial<GameMetric> = {}): GameMetric {
	return {
		id: "run-1",
		seed: 7,
		mode: "agent",
		status: "completed",
		startedAt: 1,
		durationMs: 1000,
		appVersion: "test",
		llmKind: "real",
		llmModel: "model-a",
		constructionDone: true,
		money: 1000,
		income: 100,
		delivered: 50,
		deliveredRun: 50,
		deliveredRunComplete: true,
		gsErrors: 0,
		toolBudgetBlocks: 0,
		worldFrozenMs: null,
		simulatedDays: 10,
		horizonDays: 10,
		reachedHorizon: true,
		scenario: "freeform",
		stations: 2,
		vehicles: 3,
		decisions: 4,
		toolCalls: 8,
		toolFailures: 1,
		totalTokens: 1000,
		costTotal: 0.5,
		costKnown: true,
		manifest: { servedModel: "model-a", backend: "agent" },
		...over,
	} as unknown as GameMetric;
}

describe("buildCompareView", () => {
	it("groups the runs by the model that served them", () => {
		const payload = buildCompareView([
			row({ id: "r1" }),
			row({ id: "r2", llmModel: "model-b", manifest: { servedModel: "model-b", backend: "agent" } as never }),
		]);
		expect(payload.models.map((m) => m.model).sort()).toEqual(["model-a", "model-b"]);
		expect(payload.runs.length).toBe(2);
	});

	it("lists the excluded runs with a reason (never silently drops them)", () => {
		const payload = buildCompareView([
			row({ id: "r1" }),
			row({ id: "r2", blockedByPause: true, pausedBy: "agent" }),
		]);
		expect(payload.exclusions.length).toBeGreaterThan(0);
		expect(payload.exclusions[0]!.reason).toMatch(/paused/i);
		expect(payload.exclusions[0]!.count).toBe(1);
	});

	it("reports an unpriced model's cost as missing, not as zero", () => {
		const payload = buildCompareView([row({ costKnown: false, costTotal: 0 })]);
		expect(payload.models[0]!.efficiency.costPerRun).toBeNull();
	});

	it("carries the outcome classes with the server's own names", () => {
		const payload = buildCompareView([
			row({ id: "r1", deliveredRun: 50 }),
			row({ id: "r2", deliveredRun: 0, constructionDone: true }),
			row({ id: "r3", deliveredRun: 0, constructionDone: false }),
			row({ id: "r4", deliveredRun: 0, toolCalls: 3, toolFailures: 3 }),
			row({ id: "r5", blockedByPause: true }),
			row({ id: "r6", worldFrozen: true }),
			row({ id: "r7", reachedHorizon: false }),
			row({ id: "r8", reachedHorizon: false, totalTokens: 120, manifest: { servedModel: "model-a", backend: "agent", tokenLimit: 100 } as never }),
			row({ id: "r9", reachedHorizon: false, costTotal: 2, costKnown: true, manifest: { servedModel: "model-a", backend: "agent", costLimit: 1 } as never }),
			row({ id: "r10", deliveredRun: null }),
		]);
		const dist = payload.models[0]!.stability.outcomeDistribution;
		const codes = dist.map((d) => d.code).sort();
		expect(codes).toEqual([
			"cost_cap",
			"delivered",
			"delivered_nothing",
			"no_construction",
			"paused_by_agent",
			"refused",
			"token_cap",
			"unknown",
			"wall_clock_cap",
			"world_frozen",
		]);
		// Every class carries a name and an explanation: the page shows them verbatim.
		for (const d of dist) {
			expect(d.label.trim().length).toBeGreaterThan(0);
			expect(d.hint.trim().length).toBeGreaterThan(0);
		}
	});

	it("filters by model, seed and backend (the same set the axes describe)", () => {
		const rows = [
			row({ id: "r1", seed: 7 }),
			row({ id: "r2", seed: 8 }),
			row({ id: "r3", seed: 7, manifest: { servedModel: "model-a", backend: "harness" } as never }),
		];
		expect(buildCompareView(rows, { seed: 7 }).runs.map((r) => r.id)).toEqual(["r1", "r3"]);
		expect(buildCompareView(rows, { backend: "harness" }).runs.map((r) => r.id)).toEqual(["r3"]);
		expect(buildCompareView(rows, { models: ["model-a"] }).runs.length).toBe(3);
		expect(buildCompareView(rows, { models: ["nope"] }).runs.length).toBe(0);
	});
});

/**
 * 2026-11-01 评估结论：观测面**不进** `scaffoldHash`（它在跑之前算不出来，
 * 且会让哈希随 seed 变化、毁掉预览），而由 `payloadShapeHash` 覆盖。
 * 缺的从来不是哈希，而是**比较**——Compare 现在把它说出来。
 */
describe("Compare: did the compared runs answer the same question?", () => {
	function run(id: string, model: string, scaffold: string | null, shape: string | null) {
		return {
			id,
			seed: 7,
			llmModel: model,
			status: "completed",
			deliveredRun: 100,
			simulatedDays: 300,
			manifest: {
				backend: "native",
				...(scaffold ? { scaffoldHash: scaffold } : {}),
				...(shape ? { payloadShapeHash: shape } : {}),
			},
		} as never;
	}

	it("reports no difference when every run shares both hashes", () => {
		const view = buildCompareView([
			run("a", "m1", "aaaa1111", "bbbb2222"),
			run("b", "m2", "aaaa1111", "bbbb2222"),
		]);
		expect(view.surface.differs).toBe(false);
		expect(view.surface.payloadShapeHashes).toEqual(["bbbb2222"]);
	});

	it("flags a different observation surface even when the scaffold hash matches", () => {
		const view = buildCompareView([
			run("a", "m1", "aaaa1111", "bbbb2222"),
			run("b", "m2", "aaaa1111", "cccc3333"),
		]);
		expect(view.surface.differs).toBe(true);
		expect(view.surface.payloadShapeHashes).toEqual(["bbbb2222", "cccc3333"]);
	});

	it("ignores runs that recorded no hash (not measured is not a difference)", () => {
		const view = buildCompareView([
			run("a", "m1", "aaaa1111", "bbbb2222"),
			run("b", "m2", null, null),
		]);
		expect(view.surface.differs).toBe(false);
		expect(view.surface.scaffoldHashes).toEqual(["aaaa1111"]);
	});
});
