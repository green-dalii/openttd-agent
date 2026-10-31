/**
 * Unit tests — the canonical world projection (D2 / S2).
 *
 * 职责: 锁定"一个事实一处真值、一处顺序"——决策上下文与 `observe()` 读的是**同一份**
 * 投影（同样的字段、同样的排序），否则模型会看到两套互相矛盾的世界。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §2.1（观测面铁律 O1/O3）。
 * 禁止: 在此断言任何评价性文案。
 */

import { describe, expect, it } from "vitest";
import { auditState, worldFacts } from "../../src/agent/world-facts.js";
import { buildDecisionContext, emptyTracker } from "../../src/agent/decision-context.js";
import type { WorldSnapshot } from "../../src/game/world-state.js";

function snap(over: Partial<WorldSnapshot> = {}): WorldSnapshot {
	return {
		date: { raw: 0, year: 1950, month: 3, day: 1 },
		companies: new Map(),
		recent: [],
		totalEvents: 0,
		towns: [],
		townsTotal: null,
		industries: [],
		industriesTotal: null,
		cargoTotals: [],
		engines: [],
		companyCargo: null,
		...over,
	} as unknown as WorldSnapshot;
}

function company(id: number, over: Record<string, unknown> = {}) {
	return {
		info: { id, name: `C${id}`, isAi: false, inauguratedYear: 1950 },
		economy: {
			id,
			money: 100000n,
			loan: 0n,
			income: BigInt.asUintN(64, -500n),
			deliveredCargo: 0,
			companyValue: 0n,
			performanceLastYear: 0,
			performancePrevYear: 0,
		},
		stats: { id, stations: 2, vehicles: 3 },
		...over,
	};
}

describe("worldFacts（模型可见的世界投影）", () => {
	it("公司按 id 排序，读数是数字，缺失为 null", () => {
		const f = worldFacts(
			snap({
				companies: new Map([
					[1, company(1)],
					[0, company(0, { economy: null })],
				]) as unknown as WorldSnapshot["companies"],
			}),
		);
		expect(f.companies.map((c) => c.id)).toEqual([0, 1]);
		expect(f.companies[0]!.money).toBeNull();
		expect(f.companies[1]!.money).toBe(100000);
		expect(f.companies[1]!.income).toBe(-500);
	});

	it("城镇按人口降序（缺失人口排最后），同人口按 id 升序", () => {
		const f = worldFacts(
			snap({
				towns: [
					{ id: 5, population: 100, x: 1, y: 1 },
					{ id: 2, population: 900, x: 2, y: 2 },
					{ id: 7, population: null, x: 3, y: 3 },
					{ id: 3, population: 900, x: 4, y: 4 },
				],
			} as unknown as Partial<WorldSnapshot>),
		);
		expect(f.towns.map((t) => t.id)).toEqual([2, 3, 5, 7]);
		expect(f.towns[0]!.pop).toBe(900);
		expect(f.towns[3]!.pop).toBeNull();
	});

	it("同一个快照，决策上下文与 observe() 看到同样的字段与顺序（不得自相矛盾）", () => {
		const s = snap({
			companies: new Map([[0, company(0)]]) as unknown as WorldSnapshot["companies"],
			towns: [
				{ id: 5, population: 100, x: 1, y: 1 },
				{ id: 2, population: 900, x: 2, y: 2 },
			],
		} as unknown as Partial<WorldSnapshot>);
		const facts = worldFacts(s);
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: facts.date, companies: facts.companies },
			since: emptyTracker(),
			towns: facts.towns,
		});
		// 上下文的公司与城镇 = 投影本身（同一份事实、同一顺序）。
		expect(ctx.now.companies).toEqual(facts.companies);
		expect(ctx.towns?.map((t) => t.id)).toEqual(facts.towns.map((t) => t.id));
	});
});

/**
 * 2026-10-30 真实模型局（20261030-213248-seed4242）的证伪：
 * GS 早就在报 `town_list.name` / `industry_list` / `cargo_totals` / `engines`，
 * hub 早就在解析——**投影把它们丢了**。模型自己说过"observe 输出没有 cargo 标签
 * 和车型表"，随后因为看不见任何货物而建了客运线 ⇒ 分数（货物吨数）读 0。
 * 这些测试锁住"事实必须到达模型"（SPEC §10.124）。
 */
describe("worldFacts：管道里本来就有、但模型看不见的那几类事实", () => {
	it("城镇名字：有名字就带上，没名字是 null（绝不退化成 id 字符串）", () => {
		const f = worldFacts(
			snap({
				towns: [
					{ id: 23, name: "Plunbury", population: 2419, x: 40, y: 169 },
					{ id: 11, population: 1615, x: 42, y: 58 },
					{ id: 12, name: "   ", population: 100, x: 1, y: 1 },
				],
			} as unknown as Partial<WorldSnapshot>),
		);
		expect(f.towns.find((t) => t.id === 23)!.name).toBe("Plunbury");
		expect(f.towns.find((t) => t.id === 11)!.name).toBeNull();
		// 空白名 = 没有名字，不是 id。
		expect(f.towns.find((t) => t.id === 12)!.name).toBeNull();
	});

	it("产业：货种标签/名字/产量/运量/库存都带上，缺失读数是 null（不是 0）", () => {
		const f = worldFacts(
			snap({
				industries: [
					{ id: 13, cargo: "COAL", name: "Lonningbury Coal Mine", produced: 168, transported: 0, stock: null },
					{ id: 44, cargo: "OIL_", name: "", produced: null, transported: null, stock: 12 },
				],
			} as unknown as Partial<WorldSnapshot>),
		);
		expect(f.industries[0]).toEqual({
			id: 13,
			cargo: "COAL",
			name: "Lonningbury Coal Mine",
			produced: 168,
			transported: 0,
			stock: null,
		});
		// GS 的 -1（不适用）已经由 hub 归一成 null；这里再兜一层。
		expect(f.industries[1]!.produced).toBeNull();
		expect(f.industries[1]!.stock).toBe(12);
	});

	it("按货种聚合的产量/运量与车型目录都进投影", () => {
		const f = worldFacts(
			snap({
				cargoTotals: [{ label: "LVST", produced: 768, transported: 0 }],
				engines: [{ id: 153, name: "Balogh Armoured Truck", speed: 48 }],
			} as unknown as Partial<WorldSnapshot>),
		);
		expect(f.cargoTotals).toEqual([{ label: "LVST", produced: 768, transported: 0 }]);
		expect(f.engines).toEqual([{ id: 153, name: "Balogh Armoured Truck", speed: 48 }]);
	});

	it("没有这些事实时是空数组（不是 null、不是 0），上下文里不出现空块", () => {
		const f = worldFacts(snap());
		expect(f.industries).toEqual([]);
		expect(f.cargoTotals).toEqual([]);
		expect(f.engines).toEqual([]);
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: f.date, companies: f.companies },
			since: emptyTracker(),
			towns: f.towns,
		});
		expect(ctx.cargo).toBeUndefined();
		expect(ctx.engines).toBeUndefined();
	});

	it("决策上下文带着货物世界与车型（与 observe() 同一份投影）", () => {
		const s = snap({
			towns: [{ id: 23, name: "Plunbury", population: 2419, x: 40, y: 169 }],
			industries: [{ id: 13, cargo: "COAL", name: "Lonningbury Coal Mine", produced: 168, transported: 0, stock: null }],
			cargoTotals: [{ label: "COAL", produced: 624, transported: 0 }],
			engines: [{ id: 153, name: "Balogh Armoured Truck", speed: 48 }],
		} as unknown as Partial<WorldSnapshot>);
		const facts = worldFacts(s);
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: facts.date, companies: facts.companies },
			since: emptyTracker(),
			towns: facts.towns,
			cargo: { totals: facts.cargoTotals, industries: facts.industries },
			engines: facts.engines,
		});
		expect(ctx.cargo?.industries[0]!.cargo).toBe("COAL");
		expect(ctx.cargo?.totals[0]!.produced).toBe(624);
		expect(ctx.engines?.[0]!.id).toBe(153);
	});
});

describe("auditState（审计侧的世界快照）", () => {
	it("保留审计需要的显示字段（name/isAi）与事件计数，且读数与投影同源", () => {
		const s = snap({ companies: new Map([[0, company(0)]]) as unknown as WorldSnapshot["companies"], recent: [{ kind: "x" }, { kind: "y" }] as never, totalEvents: 7 });
		const state = auditState(s) as {
			date: string | null;
			companies: { id: number; name: string; money: string }[];
			recentEventCount: number;
			totalEvents: number;
		};
		expect(state.date).toBe("1950-03-01");
		expect(state.companies[0]!.name).toBe("C0");
		expect(state.companies[0]!.money).toBe("100000");
		expect(state.recentEventCount).toBe(2);
		expect(state.totalEvents).toBe(7);
	});
});
