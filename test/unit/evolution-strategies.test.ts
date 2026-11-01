/**
 * Unit tests — strategy library (SPEC §5.2 机制 2 + §5.3 入库门槛)。
 *
 * 职责: 锁定「策略卡片」的合并与入库门槛,以及 SPEC §5.3 的人工确认 guardrail。
 * 事实来源: SPEC §5.2（策略库）、§5.3（价值>阈值 且 已验证局≥2；只读建议）,
 *   docs/EVOLUTION.md §2.2/§3。
 * 禁止: 在此调用 LLM 或读写磁盘。
 *
 * 为什么门槛要写死成测试:策略库的失败模式是**过早自信**——一局运气好就把
 * 一个模式固化,之后每局都按它来,而没有任何证据能把它推翻。SPEC 要求
 * "价值>阈值 且 已验证局≥2" 正是为了挡住这种单局噪声。
 */

import { describe, expect, it } from "vitest";
import {
	MIN_STRATEGY_PROFIT_PER_DAY,
	MIN_VERIFIED_RUNS,
	STRATEGY_ACTIONS,
	strategyIdentityProblem,
	evaluatePromotion,
	formatStrategiesForInjection,
	mergeStrategySamples,
	promoteStrategies,
	selectStrategies,
	strategyId,
	type StrategySample,
} from "../../src/evolution/strategies.js";
import type { StrategyCard } from "../../src/evolution/types.js";

const NOW = 1_700_000_000_000;

function sample(over: Partial<StrategySample> = {}): StrategySample {
	return {
		action: "build_bus_route",
		params: { cargo: "LVST", townA: 4, townB: 8 },
		profitPerDay: MIN_STRATEGY_PROFIT_PER_DAY + 10,
		evidence: ["money +18000 in 1951"],
		sessionId: "s1",
		createdAt: NOW,
		...over,
	};
}

describe("strategies: strategyId", () => {
	it("参数顺序不影响 id(同一模式必须落到同一张卡片)", () => {
		expect(strategyId("build_bus_route", { a: 1, b: 2 })).toBe(
			strategyId("build_bus_route", { b: 2, a: 1 }),
		);
	});

	it("不同 action 得到不同 id", () => {
		expect(strategyId("build_bus_route", { cargo: "LVST" })).not.toBe(
			strategyId("set_route_cargo", { cargo: "LVST" }),
		);
	});

	it("只有白名单参数参与身份：运什么货会分开，镇号/线路号不会", () => {
		// 旧实现把**全部**参数哈希进 id，于是"同一想法、不同镇号"就是新卡，
		// 跨局累积永远到不了 2 局（2026-11-01 修）。
		expect(strategyId("build_bus_route", { cargo: "LVST" })).not.toBe(
			strategyId("build_bus_route", { cargo: "PASS" }),
		);
		expect(strategyId("build_bus_route", { cargo: "LVST", townA: 4 })).toBe(
			strategyId("build_bus_route", { cargo: "LVST", townA: 8 }),
		);
	});

	it("模型自己编的 action 名字不算身份（身份归代码所有）", () => {
		expect(strategyId("build_truck_route", {})).toBe("");
		expect(strategyIdentityProblem("build_truck_route")).toMatch(/must be one of/);
		expect(strategyIdentityProblem("build_bus_route")).toBeNull();
	});

	it("缺少 action 时得到空 id(调用方据此拒绝)", () => {
		expect(strategyId("", { a: 1 })).toBe("");
		expect(strategyId(undefined, { a: 1 })).toBe("");
	});
});

describe("strategies: mergeStrategySamples", () => {
	it("把同一模式的多次采样合并成一张卡片,每次一局一个样本", () => {
		const cards = mergeStrategySamples([sample(), sample({ profitPerDay: 9000, sessionId: "s2" })], [], NOW);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.profitPerDayPerRun).toEqual([MIN_STRATEGY_PROFIT_PER_DAY + 10, 9000]);
	});

	it("合并已有卡片(跨局累积,不重置)", () => {
		const first = mergeStrategySamples([sample()], [], NOW);
		const second = mergeStrategySamples([sample({ profitPerDay: 7000, sessionId: "s2" })], first, NOW);
		expect(second).toHaveLength(1);
		expect(second[0]!.profitPerDayPerRun).toHaveLength(2);
	});

	it("合并证据与来源局,并去重", () => {
		const a = mergeStrategySamples([sample({ evidence: ["e1"], sessionId: "s1" })], [], NOW);
		const b = mergeStrategySamples(
			[sample({ evidence: ["e1", "e2"], sessionId: "s1" })],
			a,
			NOW,
		);
		expect(b[0]!.evidence).toEqual(["e1", "e2"]);
		expect(b[0]!.sourceSessionIds).toEqual(["s1"]);
	});

	it("不同模式各自成卡（白名单参数不同 = 不同的模式）", () => {
		const cards = mergeStrategySamples(
			[sample(), sample({ action: "set_route_cargo", params: { cargo: "PASS" } })],
			[],
			NOW,
		);
		expect(cards).toHaveLength(2);
	});

	it("同一模式换了镇号仍是同一张卡（否则跨局门槛不可达）", () => {
		const cards = mergeStrategySamples(
			[sample({ sessionId: "s1" }), sample({ params: { cargo: "LVST", townA: 12, townB: 3 }, sessionId: "s2" })],
			[],
			NOW,
		);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.profitPerDayPerRun).toHaveLength(2);
	});

	it("丢弃无效采样(无 action / 非有限 value / 无证据 / 无来源局)", () => {
		const cards = mergeStrategySamples(
			[
				sample({ action: "" }),
				sample({ profitPerDay: Number.NaN }),
				sample({ evidence: [] }),
				sample({ sessionId: "" }),
				null as unknown as StrategySample,
			],
			[],
			NOW,
		);
		expect(cards).toEqual([]);
	});

	it("新卡片默认 enabled=false(SPEC §5.3:只读建议,人工确认后才生效)", () => {
		const cards = mergeStrategySamples([sample()], [], NOW);
		expect(cards[0]!.enabled).toBe(false);
	});

	it("不丢已有卡片的人工确认状态", () => {
		const existing: StrategyCard[] = [
			{
				...mergeStrategySamples([sample()], [], NOW)[0]!,
				enabled: true,
			},
		];
		const merged = mergeStrategySamples([sample({ profitPerDay: 8000, sessionId: "s2" })], existing, NOW);
		expect(merged[0]!.enabled).toBe(true);
	});

	it("输入与输出都是确定性的(与采样顺序无关)", () => {
		const s1 = sample({ profitPerDay: 100 });
		const s2 = sample({ profitPerDay: 200, sessionId: "s2" });
		const x = mergeStrategySamples([s1, s2], [], NOW);
		const y = mergeStrategySamples([s2, s1], [], NOW);
		expect(JSON.stringify(x)).toBe(JSON.stringify(y));
	});
});

describe("strategies: evaluatePromotion(SPEC §5.3 双重门槛)", () => {
	const card = (over: Partial<StrategyCard> = {}): StrategyCard => ({
		id: strategyId("build_bus_route", { a: 1 }),
		name: "build_bus_route",
		action: "build_bus_route",
		params: { a: 1 },
		profitPerDayPerRun: [],
		evidence: ["e1"],
		sourceSessionIds: ["s1", "s2"],
		createdAt: NOW,
		...over,
	});

	it("价值不够高 -> 拒绝(即使已验证多局)", () => {
		const r = evaluatePromotion(card({ profitPerDayPerRun: [1, 2, 3] }));
		expect(r.promoted).toBe(false);
		expect(r.reason).toMatch(/profit|阈值/i);
	});

	it("验证局数不足 -> 拒绝(即使单局价值很高)", () => {
		const r = evaluatePromotion(card({ profitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY * 10] }));
		expect(r.promoted).toBe(false);
		expect(r.reason).toMatch(/verified|run|局/i);
	});

	it("价值过阈值 且 已验证>=2局 -> 通过", () => {
		const r = evaluatePromotion(card({ profitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY + 1, MIN_STRATEGY_PROFIT_PER_DAY + 2] }));
		expect(r.promoted).toBe(true);
		expect(r.value).toBeGreaterThan(MIN_STRATEGY_PROFIT_PER_DAY);
	});

	it("门槛可覆盖(便于实验)", () => {
		const r = evaluatePromotion(card({ profitPerDayPerRun: [100] }), { minValue: 50, minRuns: 1 });
		expect(r.promoted).toBe(true);
	});

	it("空样本 -> 拒绝且不抛异常", () => {
		const r = evaluatePromotion(card({ profitPerDayPerRun: [] }));
		expect(r.promoted).toBe(false);
		expect(r.value).toBe(0);
	});

	it("非有限样本被忽略,不污染均值", () => {
		const r = evaluatePromotion(
			card({ profitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY + 1000, Number.NaN, MIN_STRATEGY_PROFIT_PER_DAY + 2000] }),
		);
		expect(r.promoted).toBe(true);
		expect(Number.isFinite(r.value)).toBe(true);
	});

	it("MIN_VERIFIED_RUNS 就是 SPEC 的 2", () => {
		expect(MIN_VERIFIED_RUNS).toBe(2);
	});
});

describe("strategies: promoteStrategies", () => {
	it("只返回通过门槛的卡片", () => {
		const s1 = sample({ profitPerDay: MIN_STRATEGY_PROFIT_PER_DAY + 1000 });
		const s2 = sample({ profitPerDay: MIN_STRATEGY_PROFIT_PER_DAY + 2000, sessionId: "s2" });
		const weak = sample({ params: { from: "X", to: "Y" }, profitPerDay: 1 });
		const cards = promoteStrategies([s1, s2, weak], [], { now: NOW });
		expect(cards).toHaveLength(1);
		expect(cards[0]!.profitPerDayPerRun).toHaveLength(2);
	});

	it("单局样本即使价值极高也不入库", () => {
		expect(promoteStrategies([sample({ profitPerDay: 10_000_000 })], [], { now: NOW })).toEqual([]);
	});

	it("容忍空输入", () => {
		expect(promoteStrategies([], [], { now: NOW })).toEqual([]);
	});
});

describe("strategies: selectStrategies(注入前的 guardrail)", () => {
	const mk = (id: string, enabled: boolean): StrategyCard => ({
		id,
		name: id,
		action: "build_bus_route",
		params: {},
		profitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY + 1, MIN_STRATEGY_PROFIT_PER_DAY + 2],
		evidence: ["e"],
		sourceSessionIds: ["s1"],
		createdAt: NOW,
		enabled,
	});

	it("只注入被人工确认(enabled)的卡片", () => {
		const out = selectStrategies([mk("a", true), mk("b", false)]);
		expect(out.map((c) => c.id)).toEqual(["a"]);
	});

	it("全部未确认 -> 一条都不注入(默认不学)", () => {
		expect(selectStrategies([mk("a", false), mk("b", false)])).toEqual([]);
	});

	it("限量,且按价值降序", () => {
		const low: StrategyCard = { ...mk("low", true), profitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY + 1, MIN_STRATEGY_PROFIT_PER_DAY + 2] };
		const high: StrategyCard = { ...mk("high", true), profitPerDayPerRun: [MIN_STRATEGY_PROFIT_PER_DAY * 9, MIN_STRATEGY_PROFIT_PER_DAY * 9] };
		const out = selectStrategies([low, high], { limit: 1 });
		expect(out.map((c) => c.id)).toEqual(["high"]);
	});

	it("容忍空输入", () => {
		expect(selectStrategies([])).toEqual([]);
		expect(selectStrategies(undefined as unknown as StrategyCard[])).toEqual([]);
	});
});

describe("strategies: formatStrategiesForInjection", () => {
	it("每条一行,含动作与参数", () => {
		const cards = mergeStrategySamples([sample(), sample({ profitPerDay: 9000, sessionId: "s2" })], [], NOW);
		const out = formatStrategiesForInjection(cards);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("build_bus_route");
		expect(out[0]).not.toContain("\n");
	});

	it("空输入得到空数组", () => {
		expect(formatStrategiesForInjection([])).toEqual([]);
	});
});

/**
 * 身份归代码所有（2026-11-01）：词表必须与**真实动作目录**一致，
 * 否则模型可以记录一个"它其实做不到的模式"，而晋升闸会把它当经验累积。
 */
describe("strategies: the identity vocabulary belongs to the code", () => {
	it("STRATEGY_ACTIONS 就是工具目录里的写动作（不多不少）", async () => {
		const { ACTION_EFFECTS } = await import("../../src/agent/tools/catalog.js");
		const writes = Object.entries(ACTION_EFFECTS)
			.filter(([, effect]) => effect === "write")
			.map(([name]) => name)
			.sort();
		expect([...STRATEGY_ACTIONS].sort()).toEqual(writes);
	});

	it("白名单参数之外的字段不进入身份（镇号/线路号每局都不同）", () => {
		expect(strategyId("build_bus_route", { cargo: "LVST", townA: 1, from: "A" })).toBe(
			strategyId("build_bus_route", { cargo: "LVST", townB: 9, to: "B" }),
		);
	});
});
