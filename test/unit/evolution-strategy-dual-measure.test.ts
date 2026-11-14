/**
 * Unit tests — the promotion gate reads the RIGHT measure (2026-11-14).
 *
 * 背景（第一性原理）：闸问的是"这条策略赚钱吗"，旧实现却用**净现金流**
 * （含基建/购车/利息）来答 ⇒ 只要这一局还在建线买车，净现金流按构造为负 ⇒
 * 闸对**任何含建线的策略**永远打不开。真机证据（M3.1-Flash，seed 11，151 日）：
 * 净现金流 -1499.28/日 vs 运营利润 **+14.13/日** —— 差额 1513/日 全部是基建/购车。
 *
 * 方案（所有者 2026-11-14 拍板，方案 C）：**双口径并存**
 *   - 卡上存**两个数**：运营利润速率（策略质量）与净现金流速率（公司健康）；
 *   - **闸用运营利润**（它才是"这条策略赚不赚钱"）；
 *   - 两者都是"没测到"就**不折叠成 0**。
 *
 * 事实来源: MEMORY.md §0.5；docs/EVOLUTION.md §2.2；SPEC §5.3。
 */

import { describe, expect, it } from "vitest";
import {
	MIN_STRATEGY_PROFIT_PER_DAY,
	evaluatePromotion,
	mergeStrategySamples,
	promoteStrategies,
	type StrategySample,
} from "../../src/evolution/strategies.js";
import type { StrategyCard } from "../../src/evolution/types.js";

const NOW = 1_700_000_000_000;

/** A sample carrying both measures (the shape the reflection now produces). */
function sample(over: Partial<StrategySample> = {}): StrategySample {
	return {
		action: "build_freight_route",
		params: { cargo: "COAL" },
		profitPerDay: 20, // net cash flow per game day
		operatingProfitPerDay: 25, // operating profit per game day
		evidence: ["IORE 80 tons delivered"],
		sessionId: "s1",
		createdAt: NOW,
		...over,
	};
}

function card(over: Partial<StrategyCard> = {}): StrategyCard {
	return {
		id: "s_test",
		name: "build_freight_route",
		action: "build_freight_route",
		params: { cargo: "COAL" },
		profitPerDayPerRun: [],
		evidence: ["e1"],
		sourceSessionIds: ["s1", "s2"],
		createdAt: NOW,
		...over,
	};
}

describe("策略库：双口径（运营利润 = 闸的度量，净现金流 = 公司健康）", () => {
	it("样本带两个读数，卡上两个数组都存下来", () => {
		const cards = mergeStrategySamples(
			[sample({ sessionId: "s1" }), sample({ sessionId: "s2", profitPerDay: 30, operatingProfitPerDay: 40 })],
			[],
			NOW,
		);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.operatingProfitPerDayPerRun).toEqual([25, 40]);
		expect(cards[0]!.profitPerDayPerRun).toEqual([20, 30]);
	});

	it("闸用运营利润：净现金流为负但运营利润为正 ⇒ 晋升（这正是真机那局）", () => {
		// 真机形状：净现金流 -1499.28/日（建线买车），运营利润 +14.13/日。
		const r = evaluatePromotion(
			card({
				profitPerDayPerRun: [-1499.28, -1200],
				operatingProfitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY + 1, MIN_STRATEGY_PROFIT_PER_DAY + 2],
			}),
		);
		expect(r.promoted).toBe(true);
		// 闸报的值是**运营利润**，不是净现金流。
		expect(r.value).toBeCloseTo(MIN_STRATEGY_PROFIT_PER_DAY + 1.5, 5);
		// 净现金流仍被报出来（公司健康），但不参与判定。
		expect(r.netCashFlowPerDay).toBeCloseTo((-1499.28 + -1200) / 2, 5);
	});

	it("运营利润不过阈值 ⇒ 拒绝，即使净现金流为正（反方向也不能漏）", () => {
		const r = evaluatePromotion(
			card({
				profitPerDayPerRun: [500, 500],
				operatingProfitPerDayPerRun: [1, 2],
			}),
		);
		expect(r.promoted).toBe(false);
		expect(r.reason).toMatch(/operating|运营/i);
	});

	it("没有运营利润读数 ⇒ 不可判定（不是 0），拒绝并说清缺哪个读数", () => {
		const r = evaluatePromotion(card({ profitPerDayPerRun: [500, 500] }));
		expect(r.promoted).toBe(false);
		expect(r.reason).toMatch(/operating|运营/i);
		expect(r.runs).toBe(0);
	});

	it("运营利润读数不足 2 局 ⇒ 拒绝（老闸的『已验证局≥2』仍然有效）", () => {
		const r = evaluatePromotion(
			card({
				profitPerDayPerRun: [500, 500],
				operatingProfitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY + 100],
				sourceSessionIds: ["s1", "s2"],
			}),
		);
		expect(r.promoted).toBe(false);
		expect(r.runs).toBe(1);
		expect(r.reason).toMatch(/verified|run|局/i);
	});

	it("两个口径都报出来：缺净现金流读数时它是 null（没测到），不是 0", () => {
		const r = evaluatePromotion(
			card({
				profitPerDayPerRun: [],
				operatingProfitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY + 1, MIN_STRATEGY_PROFIT_PER_DAY + 2],
			}),
		);
		expect(r.promoted).toBe(true);
		expect(r.netCashFlowPerDay).toBeNull();
	});

	it("阈值可覆盖（便于实验）", () => {
		const r = evaluatePromotion(
			card({
				profitPerDayPerRun: [1, 1],
				operatingProfitPerDayPerRun: [30, 30],
			}),
			{ minValue: 20, minRuns: 1 },
		);
		expect(r.promoted).toBe(true);
	});

	it("promoteStrategies 用运营利润挑卡（净现金流为负的那张也能过）", () => {
		const good = sample({ sessionId: "s1", profitPerDay: -1500, operatingProfitPerDay: 40 });
		const good2 = sample({ sessionId: "s2", profitPerDay: -1400, operatingProfitPerDay: 50 });
		const weak = sample({ sessionId: "s3", params: { cargo: "OIL_" }, operatingProfitPerDay: 1 });
		const cards = promoteStrategies([good, good2, weak], [], { now: NOW });
		expect(cards).toHaveLength(1);
		expect(cards[0]!.operatingProfitPerDayPerRun).toEqual([40, 50]);
	});

	it("旧的卡（只有净现金流读数）不被误判为可晋升", () => {
		// 存量卡（2026-11-14 之前写的）没有运营利润读数 ⇒ 不可判定，而不是"通过"。
		const legacy = card({
			profitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY + 100, MIN_STRATEGY_PROFIT_PER_DAY + 200],
		});
		expect(evaluatePromotion(legacy).promoted).toBe(false);
	});
});
