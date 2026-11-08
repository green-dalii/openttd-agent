/**
 * 货运 F4 / A5：台账与事实的**记录形状**装得下货运线。
 *
 * 为什么这件事单独存在：真机（真实模型货运局）留下的 `route-facts.jsonl` 里，
 * 5 条货运线是 `from:null,to:null` ⇒ 注入模型的句子成了
 * `route towns null->null was ordered at decision 2` —— **垃圾进上下文**。
 * 根因不是"忘了填字段"，是**容器的形状装不下它要记的事实**（台账只有“城镇对”）。
 *
 * 修法：**两种线两种记录**（显式分开），不是"字段留空兼容"：
 *   - 客运线：`kind: "passenger"` + 两端城镇；
 *   - 货运线：`kind: "freight"` + 两端产业 + 货种。
 *
 * 事实来源: `docs/SCAFFOLD-CONTRACT.md`（逐线路交付量）；MEMORY D98；SPEC §10.126。
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RouteLedger } from "../../src/agent/route-ledger.js";
import { makeSignalHub } from "../../src/agent/signal-hub.js";
import {
	formatRouteFactsForInjection,
	loadRouteFacts,
	routeFactsFromLedger,
	saveRouteFacts,
} from "../../src/evolution/route-facts.js";
import type { GameEvent } from "../../src/types.js";

function freightAck(job: number, cargo: string, producer: number, consumer: number) {
	return {
		kind: "gamescript",
		payload: {
			kind: "ack",
			cmd: "build_freight_route",
			job,
			cargo,
			producer,
			consumer,
			tileA: 10,
			tileB: 20,
			company: 0,
			queued: 1,
		},
	} as unknown as GameEvent;
}

function hubFor(ledger: RouteLedger) {
	const world = {
		ingest: vi.fn(),
		setTowns: vi.fn(),
		setIndustries: vi.fn(),
		setCargoTotals: vi.fn(),
		setCompanyCargo: vi.fn(),
		snapshot: () => ({ companyCargo: null }),
	};
	return makeSignalHub({
		world: world as never,
		getWeb: () => null,
		getSession: () => null,
		routeLedger: ledger,
		getDecisionCount: () => 3,
		onPhaseChange: () => {},
		onNotableEvent: () => {},
	});
}

describe("台账：货运线有自己的记录形状", () => {
	it("货运 ack 进台账，带上两端产业与货种", () => {
		const ledger = new RouteLedger();
		const hub = hubFor(ledger);
		hub.onEvent(freightAck(1000, "COAL", 28, 53));
		const lines = ledger.all();
		expect(lines).toHaveLength(1);
		expect(lines[0]!.order).toMatchObject({
			kind: "freight",
			job: 1000,
			fromIndustry: 28,
			toIndustry: 53,
			cargo: "COAL",
		});
	});

	it("客运 ack 仍是“城镇对”（两种形状互不干扰）", () => {
		const ledger = new RouteLedger();
		const hub = hubFor(ledger);
		hub.onEvent({
			kind: "gamescript",
			payload: { kind: "ack", cmd: "build_bus_route", job: 900, townA: 9, townB: 12 },
		} as unknown as GameEvent);
		hub.onEvent(freightAck(1000, "COAL", 28, 53));
		const lines = ledger.all();
		expect(lines[0]!.order).toMatchObject({ kind: "passenger", fromTown: 9, toTown: 12 });
		expect(lines[1]!.order).toMatchObject({ kind: "freight", fromIndustry: 28 });
	});

	it("端点缺一 ⇒ 不记（不写半条事实，也不编）", () => {
		const ledger = new RouteLedger();
		const hub = hubFor(ledger);
		hub.onEvent({
			kind: "gamescript",
			payload: { kind: "ack", cmd: "build_freight_route", job: 1001, cargo: "COAL" },
		} as unknown as GameEvent);
		expect(ledger.all()).toHaveLength(0);
	});

	it("注入模型的句子各说各的（绝不说 “towns null->null”）", () => {
		const ledger = new RouteLedger();
		const hub = hubFor(ledger);
		hub.onEvent(freightAck(1000, "COAL", 28, 53));
		const text = ledger.lines().join(" ");
		expect(text).toContain("COAL");
		expect(text).toContain("28->53");
		expect(text).not.toMatch(/null/);
	});
});

describe("事实文件：两种线两种记录（且不互相覆盖）", () => {
	it("货运事实带的是产业对 + 货种（不是城镇字段）", () => {
		const ledger = new RouteLedger();
		hubFor(ledger).onEvent(freightAck(1000, "COAL", 28, 53));
		const facts = routeFactsFromLedger(ledger.all());
		expect(facts[0]).toMatchObject({
			kind: "freight",
			fromIndustry: 28,
			toIndustry: 53,
			cargo: "COAL",
		});
		expect(facts[0]!.from).toBeUndefined();
		expect(facts[0]!.to).toBeUndefined();
	});

	it("客运线与货运线**不会互相覆盖**（键里带种类与两端）", () => {
		const dir = mkdtempSync(join(tmpdir(), "rf-a5-"));
		saveRouteFacts(dir, [
			{ kind: "passenger", from: 9, to: 12, decision: 1, completed: true },
			{ kind: "freight", fromIndustry: 28, toIndustry: 53, cargo: "COAL", decision: 1, completed: true },
		]);
		const loaded = loadRouteFacts(dir);
		expect(loaded).toHaveLength(2);
		expect(loaded.map((f) => f.kind).sort()).toEqual(["freight", "passenger"]);
	});

	it("注入句子里有“运了多少”（推导值），归不出来时明说归不出来", () => {
		const dir = mkdtempSync(join(tmpdir(), "rf-a5b-"));
		saveRouteFacts(dir, [
			{
				kind: "freight",
				fromIndustry: 28,
				toIndustry: 53,
				cargo: "COAL",
				decision: 2,
				completed: true,
				delivered: 160,
			},
			{
				kind: "freight",
				fromIndustry: 30,
				toIndustry: 53,
				cargo: "COAL",
				decision: 3,
				completed: true,
				delivered: null,
				deliveredReason: "2 routes share COAL at industry 53",
			},
		]);
		const lines = formatRouteFactsForInjection(loadRouteFacts(dir));
		expect(lines[0]).toContain("160");
		expect(lines[0]).toContain("derived");
		expect(lines[1]).toMatch(/could not be attributed/);
		expect(lines[1]).toContain("2 routes share");
		// 红线：不得出现策略词，也不得出现 null。
		expect(lines.join(" ")).not.toMatch(/prefer|should|better|choose|null/i);
	});

	it("落盘的事实没有 null 端点（旧的垃圾行不会再产生）", () => {
		const dir = mkdtempSync(join(tmpdir(), "rf-a5c-"));
		const ledger = new RouteLedger();
		hubFor(ledger).onEvent(freightAck(1000, "COAL", 28, 53));
		saveRouteFacts(dir, routeFactsFromLedger(ledger.all()));
		const raw = readFileSync(join(dir, "evolution", "route-facts.jsonl"), "utf8");
		expect(raw).not.toMatch(/"from":null/);
		expect(raw).not.toMatch(/"to":null/);
	});
});
