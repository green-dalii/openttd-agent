import { describe, expect, it } from "vitest";
import { WorldState } from "../../src/game/world-state.js";
import type { GameEvent } from "../../src/types.js";

function ev(kind: GameEvent["kind"], payload: unknown, seq: number): GameEvent {
	return { seq, kind, ts: 1000 + seq, payload };
}

describe("WorldState", () => {
	it("tracks date from date events", () => {
		const ws = new WorldState();
		ws.ingest(ev("date", { raw: 712223, year: 1950, month: 1, day: 1 }, 1));
		ws.ingest(ev("date", { raw: 712224, year: 1950, month: 1, day: 2 }, 2));
		expect(ws.snapshot().date).toEqual({ raw: 712224, year: 1950, month: 1, day: 2 });
	});

	it("registers company on company_new and fills from info", () => {
		const ws = new WorldState();
		ws.ingest(ev("company_new", { id: 0 }, 1));
		ws.ingest(
			ev("company_info", { id: 0, name: "Acme", manager: "M", colour: 2, passwordProtected: false, inauguratedYear: 1950, isAi: true }, 2),
		);
		const snap = ws.snapshot();
		expect(snap.companies.has(0)).toBe(true);
		expect(snap.companies.get(0)?.info?.name).toBe("Acme");
		expect(snap.companies.get(0)?.info?.isAi).toBe(true);
	});

	it("accumulates economy into the company state", () => {
		const ws = new WorldState();
		ws.ingest(ev("company_new", { id: 3 }, 1));
		ws.ingest(
			ev("company_economy", { id: 3, money: 100000n, loan: 50000n, income: -2000n, deliveredCargo: 10, companyValue: 0n }, 2),
		);
		const s = ws.snapshot().companies.get(3)!;
		expect(s.economy?.money).toBe(100000n);
		expect(s.economy?.loan).toBe(50000n);
		expect(s.lastEconomyAt).not.toBeNull();
	});

	it("keeps only recentLimit recent events but counts all", () => {
		const ws = new WorldState({ recentLimit: 3 });
		for (let i = 0; i < 10; i++) ws.ingest(ev("date", { raw: i }, i));
		expect(ws.getTotalEvents()).toBe(10);
		expect(ws.snapshot().recent.length).toBe(3);
	});

	it("removes company on company_remove", () => {
		const ws = new WorldState();
		ws.ingest(ev("company_new", { id: 1 }, 1));
		ws.ingest(ev("company_remove", { id: 1 }, 2));
		expect(ws.snapshot().companies.has(1)).toBe(false);
	});

	it("lastEvent finds most recent of a kind", () => {
		const ws = new WorldState();
		ws.ingest(ev("date", { raw: 1 }, 1));
		ws.ingest(ev("date", { raw: 2 }, 2));
		ws.ingest(ev("company_new", { id: 0 }, 3));
		const last = ws.lastEvent("date");
		expect(last?.payload).toEqual({ raw: 2 });
		expect(ws.lastEvent("company_remove")).toBeNull();
	});
});

describe("world state: towns（Bridge GS 上报的候选城镇）", () => {
	it("按人口降序保存，并记住 GS 报的总数", () => {
		const w = new WorldState();
		w.setTowns(
			[
				{ id: 1, population: 100, x: 1, y: 1 },
				{ id: 2, population: 300, x: 2, y: 2 },
			],
			17,
		);
		const snap = w.snapshot();
		expect(snap.towns.map((t) => t.id)).toEqual([2, 1]);
		expect(snap.townsTotal).toBe(17);
	});

	it("没收到总数时是 null（而不是 0）", () => {
		const w = new WorldState();
		w.setTowns([{ id: 3, population: 5, x: 0, y: 0 }]);
		expect(w.snapshot().townsTotal).toBeNull();
	});

	it("后续只带取样列表、不带总数的帧，不会把已知总数抹掉", () => {
		const w = new WorldState();
		w.setTowns([{ id: 1, population: 1, x: 0, y: 0 }], 9);
		w.setTowns([{ id: 2, population: 2, x: 0, y: 0 }]);
		expect(w.snapshot().townsTotal).toBe(9);
	});
});

describe("world state: 产业与货种（GS 上报的原始计数）", () => {
	it("保存产业样本与货种合计，并记住产业总数", () => {
		const w = new WorldState();
		w.setIndustries(
			[
				{ id: 5, cargo: "PASS", name: "Town", produced: 100, transported: 40, stock: null },
				{ id: 9, cargo: "COAL", name: "Coal Mine", produced: 900, transported: 600, stock: 120 },
			],
			37,
		);
		w.setCargoTotals([
			{ label: "COAL", produced: 900, transported: 600 },
			{ label: "PASS", produced: 100, transported: 40 },
		]);
		const snap = w.snapshot();
		expect(snap.industriesTotal).toBe(37);
		// 样本按产量降序（顺序是世界事实，不是建议）
		expect(snap.industries.map((i) => i.id)).toEqual([9, 5]);
		expect(snap.cargoTotals).toHaveLength(2);
	});

	it("垃圾/缺失输入被丢掉而不是变成 0（0 会被读成「该产业不产东西」）", () => {
		const w = new WorldState();
		w.setIndustries([{ id: "x" } as never, { id: 3, produced: Number.NaN } as never], null);
		expect(w.snapshot().industries).toEqual([]);
		expect(w.snapshot().industriesTotal).toBeNull();
	});

	it("公司口径运量：本会话累计 + 季度总量 + 被监视的目的地数", () => {
		const w = new WorldState();
		w.setCompanyCargo({
			byCargo: [{ label: "PASS", amount: 120 }],
			quarterDelivered: 5000,
			monitored: { towns: 10, industries: 0 },
		});
		const c = w.snapshot().companyCargo;
		expect(c?.byCargo[0]).toEqual({ label: "PASS", amount: 120 });
		expect(c?.quarterDelivered).toBe(5000);
		expect(c?.monitored).toEqual({ towns: 10, industries: 0 });
	});

	it("没收到公司口径数据时是 null（不是 0 —— 那等于说「一辆货都没送」）", () => {
		expect(new WorldState().snapshot().companyCargo).toBeNull();
	});

	it("城镇可以带主货种（原始计数，比率由前端派生）", () => {
		const w = new WorldState();
		w.setTowns([{ id: 1, population: 100, x: 1, y: 2, cargo: [{ label: "PASS", produced: 30, transported: 12 }] } as never]);
		expect(w.snapshot().towns[0]!.cargo).toEqual([{ label: "PASS", produced: 30, transported: 12 }]);
	});
});
