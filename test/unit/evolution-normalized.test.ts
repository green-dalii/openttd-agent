/**
 * 归一化读数（ROADMAP 待办 #4）—— 纯函数 + 口径纪律。
 *
 * 这些断言锁的是**纪律**而不是数字：
 * - "没测到"不折叠成 0；
 * - "一条线都没建"在每线轴上是**不可比**，不是"每线产出 0"；
 * - 分子用公司级读数（干净），分母用干净的计数。
 */
import { describe, expect, it } from "vitest";
import { normalizeRun } from "../../src/evolution/normalized.js";
import type { GameMetric } from "../../src/evolution/metrics.js";

/** 一局度量行的最小形状（其余字段与归一化无关）。 */
function metric(over: Partial<GameMetric>): GameMetric {
	return {
		id: "s1",
		seed: 11,
		mode: "agent",
		status: "done",
		startedAt: 0,
		durationMs: 1000,
		appVersion: "test",
		llmKind: "real",
		llmModel: "m",
		constructionDone: true,
		money: 0,
		income: null,
		netCashFlow: null,
		netCashFlowVerified: null,
		profitPerDay: null,
		operatingProfit: null,
		operatingProfitPerDay: null,
		operatingProfitComplete: null,
		delivered: null,
		deliveredRun: null,
		deliveredByCargo: null,
		deliveredRunComplete: null,
		gsErrors: 0,
		toolBudgetBlocks: 0,
		simulatedDays: 100,
		vehicles: 0,
		stations: 0,
		decisions: 1,
		toolCalls: 1,
		toolFailures: 0,
		totalTokens: 1000,
		costTotal: 0,
		...over,
	} as GameMetric;
}

describe("normalizeRun —— 归一化读数", () => {
	it("按线：整局累计交付 ÷ 线路数", () => {
		const n = normalizeRun(metric({ lines: 4, deliveredRun: 900, operatingProfit: 400 }));
		expect(n.lines).toBe(4);
		expect(n.deliveredPerLine).toBe(225);
		expect(n.operatingProfitPerLine).toBe(100);
	});

	it("按车：整局累计交付 ÷ 车辆数", () => {
		const n = normalizeRun(metric({ lines: 2, deliveredRun: 900, operatingProfit: 400, vehicles: 9 }));
		expect(n.deliveredPerVehicle).toBe(100);
		expect(n.operatingProfitPerVehicle).toBeCloseTo(400 / 9, 10);
	});

	it("一条线都没建 ⇒ 每线读数是 null（不可比），不是 0", () => {
		// "模型没动手"答的是另一个问题；记成 0 会说"它建的线产出 0"。
		const n = normalizeRun(metric({ lines: 0, deliveredRun: 0, operatingProfit: 0, vehicles: 0 }));
		expect(n.lines).toBe(0); // 线路数 0 是**真的读数**
		expect(n.deliveredPerLine).toBeNull();
		expect(n.operatingProfitPerLine).toBeNull();
		expect(n.deliveredPerVehicle).toBeNull();
	});

	it("没记线路数（老局）⇒ 每线读数 null（分子有、分母没有 ⇒ 比值无从谈起）", () => {
		const n = normalizeRun(metric({ deliveredRun: 900, vehicles: 9 }));
		expect(n.lines).toBeNull();
		expect(n.deliveredPerLine).toBeNull();
		expect(n.operatingProfitPerLine).toBeNull();
		// 按车的读数仍然可用（它不依赖线路数）
		expect(n.deliveredPerVehicle).toBe(100);
	});

	it("分子没测到 ⇒ 比值 null，不是 0（0 会被读成『这条线不赚钱』）", () => {
		const n = normalizeRun(metric({ lines: 4, deliveredRun: null, operatingProfit: null, vehicles: 9 }));
		expect(n.deliveredPerLine).toBeNull();
		expect(n.operatingProfitPerLine).toBeNull();
		expect(n.deliveredPerVehicle).toBeNull();
		expect(n.operatingProfitPerVehicle).toBeNull();
	});

	it("负的运营利润照实为负（亏损线不是『没测到』）", () => {
		const n = normalizeRun(metric({ lines: 2, deliveredRun: 0, operatingProfit: -500 }));
		expect(n.operatingProfitPerLine).toBe(-250);
	});
});
