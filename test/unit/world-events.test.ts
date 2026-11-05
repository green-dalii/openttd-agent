/**
 * 推送事件（Issue #13 S7d）：引擎推给 GameScript 的事件以前被**整个丢掉**。
 *
 * 职责: 守住三件事 —— ① GS 把引擎的事件类型映射到**封闭词表**；② 世界状态按序
 *   记住它们（有界）；③ 观测面把它们交给模型。
 * 为什么: 模型以前看不到"我的车到了 / 我的车被报废了" —— 观测面只有周期采样。
 * 事实来源: docs/PER-LINE-DELIVERY-FEASIBILITY.md 同源的引擎事实；
 *   `src/game/world-state.ts` / `src/agent/world-facts.ts`。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WorldState, WORLD_EVENT_KINDS, type WorldEventFact } from "../../src/game/world-state.js";
import { worldFacts } from "../../src/agent/world-facts.js";

const GS = path.join("src", "game", "squirrel", "bridge-gs", "main.nut");

describe("推送事件：GS 侧（封闭词表）", () => {
	const src = readFileSync(GS, "utf8");

	it("GS 处理了引擎推的事件（以前只处理 admin 端口事件，其余全丢）", () => {
		// 引擎的推事件类型 → 我们封闭词表里的名字。
		expect(src).toContain("GSEvent.ET_VEHICLE_LOST");
		expect(src).toContain("GSEvent.ET_STATION_FIRST_VEHICLE");
		expect(src).toContain("GSEvent.ET_VEHICLE_WAITING_IN_DEPOT");
		expect(src).toContain("GSEvent.ET_INDUSTRY_OPEN");
		expect(src).toContain("GSEvent.ET_INDUSTRY_CLOSE");
	});

	it("事件通过 GSAdmin.Send 上报，形状恒定（缺的就是 null），且先 rawin 再读", () => {
		expect(src).toMatch(/kind\s*=\s*"game_event"/);
		// **读不存在的键会抛**（MEMORY D95）⇒ 先问 rawin，再读。
		expect(src).toMatch(/vehicle\s*=\s*\(ev\.rawin\("vehicle"\)/);
		expect(src).toMatch(/station\s*=\s*\(ev\.rawin\("station"\)/);
		expect(src).toMatch(/industry\s*=\s*\(ev\.rawin\("industry"\)/);
		expect(src).toMatch(/town\s*=\s*\(ev\.rawin\("town"\)/);
	});

	it("上报失败要报错，不许静默（丢一条事件 = 模型少知道一件事）", () => {
		expect(src).toMatch(/kind\s*=\s*"err",\s*cmd\s*=\s*"game_event"/);
	});

	it("词表是封闭的：GS 报的事件名都在 WORLD_EVENT_KINDS 里", () => {
		const reported = [...src.matchAll(/event\s*=\s*"([a-z_]+)"/g)].map((m) => m[1]!);
		expect(reported.length).toBeGreaterThan(0);
		for (const name of reported) {
			expect(WORLD_EVENT_KINDS as readonly string[]).toContain(name);
		}
	});
});

describe("推送事件：世界状态", () => {
	it("按序记住，seq 单调", () => {
		const w = new WorldState();
		w.pushWorldEvent({ kind: "vehicle_lost", vehicle: 3, station: null, industry: null, town: null });
		w.pushWorldEvent({ kind: "industry_open", vehicle: null, station: null, industry: 7, town: null });
		const events = w.snapshot().worldEvents!;
		expect(events.map((e) => e.kind)).toEqual(["vehicle_lost", "industry_open"]);
		expect(events.map((e) => e.seq)).toEqual([0, 1]);
	});

	it("不认识的词表项被丢掉（不造名字）", () => {
		const w = new WorldState();
		w.pushWorldEvent({ kind: "meteor_strike", vehicle: null, station: null, industry: null, town: null });
		expect(w.snapshot().worldEvents).toEqual([]);
	});

	it("列表有界（最新的留下）", () => {
		const w = new WorldState();
		for (let i = 0; i < 80; i++) {
			w.pushWorldEvent({ kind: "vehicle_lost", vehicle: i, station: null, industry: null, town: null });
		}
		const events = w.snapshot().worldEvents!;
		expect(events.length).toBeLessThanOrEqual(50);
		// 留下的是**最新**的那些（seq 连续，末尾最大）。
		expect(events[events.length - 1]!.seq).toBe(79);
	});

	it("缺失的字段保持 null（不折成 0）", () => {
		const w = new WorldState();
		w.pushWorldEvent({ kind: "vehicle_lost", vehicle: 3, station: null, industry: null, town: null });
		const e = w.snapshot().worldEvents![0]!;
		expect(e.vehicle).toBe(3);
		expect(e.station).toBeNull();
		expect(e.industry).toBeNull();
		expect(e.town).toBeNull();
	});
});

describe("推送事件：观测面", () => {
	it("投影带着事件（模型看得到）", () => {
		const w = new WorldState();
		w.pushWorldEvent({ kind: "station_first_vehicle", vehicle: 5, station: 2, industry: null, town: null });
		const facts = worldFacts(w.snapshot());
		expect(facts.events).toHaveLength(1);
		expect(facts.events[0]!.kind).toBe("station_first_vehicle");
		expect(facts.events[0]!.station).toBe(2);
	});

	it("没有事件时是空数组（不是 null、也不是「有坏事发生」）", () => {
		const w = new WorldState();
		const facts = worldFacts(w.snapshot());
		expect(facts.events).toEqual([]);
	});

	it("事件的形状进入观测面结构指纹（字段变了 ⇒ 指纹变了）", () => {
		const base: WorldEventFact = { seq: 0, kind: "vehicle_lost", vehicle: 1, station: null, industry: null, town: null };
		expect(base.station).toBeNull();
	});
});
