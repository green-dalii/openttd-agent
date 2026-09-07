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
