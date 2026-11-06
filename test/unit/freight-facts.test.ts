/**
 * 货运 F1：模型看得见"谁产、谁收、在哪儿、哪辆车拉"。
 *
 * 背景（`docs/FREIGHT-LINE-FEASIBILITY.md` 的真机探针）：
 *   - 车站收什么货是**引擎按集货区算**的：矿场旁边的车站**不接受煤**
 *     （煤矿不收煤），电站旁边的才接受 ⇒ 只报"哪里有煤"选不出线路。
 *   - 产业此前**一个坐标都没有** ⇒ "哪座矿 → 哪座厂"无法表达。
 *   - 车型此前只报名字 ⇒ "哪辆车拉煤"要靠猜（Balogh Coal Truck / Talbott Livestock Van）。
 *
 * 这些断言锁住三件事：
 *   1. GS 真的在采这些事实（且**不用动态键的表**——Squirrel 的表是严格的，D95）。
 *   2. hub 真的把它们解析进世界状态。
 *   3. 它们真的**到达模型**（决策上下文 + observe() 的 summary —— summary 才是
 *      模型读到的文本，`details` 看不见，A7）。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeSignalHub } from "../../src/agent/signal-hub.js";
import { buildDecisionContext, emptyTracker } from "../../src/agent/decision-context.js";
import { worldFacts } from "../../src/agent/world-facts.js";
import { observeTool } from "../../src/agent/tools/index.js";
import type { GameEvent } from "../../src/types.js";
import type { WorldSnapshot } from "../../src/game/world-state.js";

const GS = readFileSync(new URL("../../src/game/squirrel/bridge-gs/main.nut", import.meta.url), "utf8");

describe("GS：货运事实真的被采集（且不踩 Squirrel 严格表的老坑）", () => {
	it("货种目录：是不是货运、谁产、谁收（引擎算出的事实）", () => {
		expect(GS).toContain("GSIndustryList_CargoAccepting(c)");
		expect(GS).toContain("GSIndustryList_CargoProducing(c)");
		expect(GS).toContain("GSCargo.IsFreight(c)");
	});

	it("产业坐标与名字：全部产业（线路要选'哪座矿 → 哪座厂'）", () => {
		expect(GS).toContain("GSIndustry.GetLocation(iid)");
		expect(GS).toContain("GSMap.GetTileX(loc)");
		expect(GS).toContain("industry_index = industry_index");
	});

	it("车型带它能拉的货（不是从名字里猜）", () => {
		expect(GS).toContain("GSEngine.GetCargoType(eid)");
	});

	it("累加/收集用**数组**而不是动态键的表（D95：写不存在的键会抛，整个事实表停更）", () => {
		// 形如 `table[key] = value` 的动态键写入；Squirrel 的表是严格的。
		// （累加器的同款守卫在 `squirrel-api-guard.test.ts`；这里盯的是新加的货运事实。）
		expect(GS).toContain("producers.append(iid)");
		expect(GS).toContain("consumers.append(cid)");
		const collectFacts = GS.slice(GS.indexOf("function CollectFacts("), GS.indexOf("function Start("));
		expect(collectFacts).not.toMatch(/\b(producers|consumers)\s*\[\s*[A-Za-z_]/);
	});
});

describe("hub：GS 的货运事实进世界状态", () => {
	function fakeWorld() {
		return {
			ingest: vi.fn(),
			setTowns: vi.fn(),
			setIndustries: vi.fn(),
			setIndustrySites: vi.fn(),
			setCargoCatalog: vi.fn(),
			setEngines: vi.fn(),
			setDateFromRaw: vi.fn(),
			setCargoTotals: vi.fn(),
			setCompanyCargo: vi.fn(),
			pushWorldEvent: vi.fn(),
			snapshot: () => ({ date: { year: 1950, month: 1, day: 1 } }),
		};
	}
	function hub(w: unknown) {
		return makeSignalHub({
			world: w as never, getWeb: () => null, getSession: () => null,
			routeLedger: { markDone: vi.fn(), record: vi.fn(), recordVehicleJobs: vi.fn(), noteVehicleEvent: vi.fn() } as never,
			getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
	}

	it("cargo_catalog / industry_index / engines[].cargo 都进世界状态", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: {
				cmd: "state", date: 1, industries: 2,
				industry_index: [
					{ id: 28, name: "Tratborough Coal Mine", x: 40, y: 169 },
					{ id: 53, name: "Lunningville Power Station", x: 60, y: 120 },
				],
				cargo_catalog: [{ label: "COAL", freight: true, producers: [28], consumers: [53] }],
				engines: [{ id: 8, name: "Balogh Coal Truck", speed: 40, cargo: "COAL" }],
			},
		} as unknown as GameEvent);
		expect(w.setIndustrySites).toHaveBeenCalledWith([
			{ id: 28, name: "Tratborough Coal Mine", x: 40, y: 169 },
			{ id: 53, name: "Lunningville Power Station", x: 60, y: 120 },
		]);
		expect(w.setCargoCatalog).toHaveBeenCalledWith([
			{ label: "COAL", freight: true, producers: [28], consumers: [53] },
		]);
		expect(w.setEngines).toHaveBeenCalledWith([
			{ id: 8, name: "Balogh Coal Truck", speed: 40, cargo: "COAL" },
		]);
	});

	it("引擎没报车型能拉什么货 → null（不是'什么都拉'）", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: { cmd: "state", date: 1, engines: [{ id: 9, name: "Unknown", speed: 10 }] },
		} as unknown as GameEvent);
		expect(w.setEngines).toHaveBeenCalledWith([{ id: 9, name: "Unknown", speed: 10, cargo: null }]);
	});
});

describe("模型看得见货运事实（投影 → 决策上下文 / observe）", () => {
	const snap = {
		date: { raw: 0, year: 1950, month: 1, day: 1 },
		companies: new Map(),
		recent: [],
		totalEvents: 0,
		towns: [],
		townsTotal: 0,
		industries: [],
		industriesTotal: 0,
		industrySites: [{ id: 28, name: "Tratborough Coal Mine", x: 40, y: 169 }],
		cargoCatalog: [{ label: "COAL", freight: true, producers: [28], consumers: [53] }],
		cargoTotals: [{ label: "COAL", produced: 100, transported: 0 }],
		engines: [{ id: 8, name: "Balogh Coal Truck", speed: 40, cargo: "COAL" }],
		companyCargo: null,
	} as unknown as WorldSnapshot;

	it("投影里带着目录与坐标", () => {
		const f = worldFacts(snap);
		expect(f.cargoCatalog[0]).toEqual({ label: "COAL", freight: true, producers: [28], consumers: [53] });
		expect(f.industrySites[0]).toEqual({ id: 28, name: "Tratborough Coal Mine", x: 40, y: 169 });
		expect(f.engines[0]!.cargo).toBe("COAL");
	});

	it("决策上下文带着目录与坐标（不必等模型自己去调工具）", () => {
		const facts = worldFacts(snap);
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: facts.date, companies: facts.companies },
			since: emptyTracker(),
			cargo: {
				totals: facts.cargoTotals,
				industries: facts.industries,
				catalog: facts.cargoCatalog,
				industrySites: facts.industrySites,
			},
		});
		expect(ctx.cargo?.catalog?.[0]?.consumers).toEqual([53]);
		expect(ctx.cargo?.industrySites?.[0]?.x).toBe(40);
	});

	it("observe() 的 summary 里看得见（summary 才是模型读到的文本）", async () => {
		const tool = observeTool({ state: { snapshot: () => snap } } as never);
		const res = await tool.execute("c1", {});
		const text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
		expect(text).toContain("cargoCatalog");
		expect(text).toContain("Tratborough Coal Mine");
		expect(text).toContain("industrySites");
	});
});
