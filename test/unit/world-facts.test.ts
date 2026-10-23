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
