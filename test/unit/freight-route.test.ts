/**
 * 货运 F3：动作面（`build_freight_route`）。
 *
 * 分工（`docs/FREIGHT-LINE-FEASIBILITY.md` §3.2）：**模型决定运什么货、运去哪**；
 * 脚手架负责**怎么落地**（找站址 ⇒ 铺路 ⇒ 建车库 ⇒ 买车改装 ⇒ 挂路线）。
 *
 * 这组断言锁住四件事：
 *   1. **站址按引擎规则选**（收货 >= 8）——车站收什么货是引擎按集货区算的，
 *      矿场旁的站**不收煤**（真机探针）⇒ 自己猜"产方旁边就能装"就是错的。
 *   2. **货车站**（`ROADVEHTYPE_TRUCK`）——引擎规定货车只能停货车站
 *      （`station.cpp` 的 `GetPrimaryRoadStop`），客车站不收货。
 *   3. **铺路复用客运那套**（`LayPath`）——探针自己重写的铺路在 97 格链上留了
 *      40 个断口（`docs/FREIGHT-LINE-FEASIBILITY.md` §2.2b）。
 *   4. **模型看得见"哪里能装货"**（`freight_links`）并能下这个命令。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeSignalHub } from "../../src/agent/signal-hub.js";
import { buildDecisionContext, emptyTracker } from "../../src/agent/decision-context.js";
import { worldFacts } from "../../src/agent/world-facts.js";
import { buildFreightRouteTool, observeTool } from "../../src/agent/tools/index.js";
import { ACTION_EFFECTS } from "../../src/agent/tools/catalog.js";
import { routeWireFacts } from "../../src/agent/route-stats.js";
import { STRATEGY_ACTIONS } from "../../src/evolution/strategies.js";
import type { GameEvent } from "../../src/types.js";
import type { WorldSnapshot } from "../../src/game/world-state.js";

const GS = readFileSync(new URL("../../src/game/squirrel/bridge-gs/main.nut", import.meta.url), "utf8");

/** ExecCore 的源码（施工状态机在 GS 里）。 */
function execCore(): string {
	return GS.slice(GS.indexOf("class ExecCore"), GS.indexOf("class BridgeV1"));
}

describe("GS：货运站址按引擎规则选（装货与卸货的条件不同）", () => {
	it("卸货侧的收货判定用引擎自己的 API，门槛 8（station_cmd.cpp 的 `amt >= 8`）", () => {
		expect(GS).toContain("GSTile.GetCargoAcceptance(tile, cargo, 1, 1, r)");
		expect(GS).toMatch(/acc == null \|\| acc < 8/);
	});

	it("装货侧**不要求收货**（真机 2026-11-08 证伪了旧结论）", () => {
		// 产业把货交给车站看的是**车站的 rating**（`CanMoveGoodsToStation` ⇒
		// `rating == 0` 才拒收），新车站的 rating 是 175 ⇒ 车站收不收这个货
		// 不影响交货。旧结论"矿场旁的站不收煤 ⇒ 煤运不走"**不成立**：
		// 货会到站上等着，车装走即可（真机：煤 ⇒ 电站，交付 5 吨）。
		const fn = GS.slice(GS.indexOf("function TryBuildFreightStation("), GS.indexOf("/* Next pax-ranked candidate"));
		expect(fn).toContain('local needAcc = (slot.label == "B");');
		// 装货侧（slot A）⇒ 不要求收货。
		expect(fn).not.toMatch(/needAcc = \(slot\.label == "A"\)/);
	});

	it("卸货侧**要求收货**（车在不收货的站卸不下来 ⇒ 货被退回，不算交付）", () => {
		const fn = GS.slice(GS.indexOf("function BuildFreightRoute("), GS.indexOf("/* Find a depot site between station tiles"));
		expect(fn).toContain("FreightSite(indA, cargo, false, 0)");
		expect(fn).toContain("FreightSite(indB, cargo, true, 0)");
	});

	it("扫描半径 = 集货半径 ⇒ 站址必然罩住锚点产业（集货区是方形扩张）", () => {
		const fn = GS.slice(GS.indexOf("function FreightSite("), GS.indexOf("function FreightLinks("));
		expect(fn).toContain("local r = this.FreightRadius();");
		expect(fn).toMatch(/for \(local ring = 0; ring <= r; ring\+\+\)/);
	});

	it("可运链路：产方附近要有**可建的地**（地形），不是'附近有收方'（收货不是装货前提）", () => {
		expect(GS).toContain("function FreightLinks()");
		const fn = GS.slice(GS.indexOf("function FreightLinks("), GS.indexOf("function BuildFreightRoute("));
		expect(fn).toContain("FreightSite(loc, c, false, 0) == null");
		expect(fn).toContain("GSCargo.IsFreight(c)");
	});
});

describe("GS：货运线路是货车站 + 货车（引擎规则，不是选择）", () => {
	it("建站用 ROADVEHTYPE_TRUCK（货车只能停货车站）", () => {
		expect(GS).toContain("local vtype = freight ? GSRoad.ROADVEHTYPE_TRUCK : GSRoad.ROADVEHTYPE_BUS;");
		expect(GS).toContain("BuildRoadStation(tile, front, vtype, GSStation.STATION_NEW)");
	});

	it("车型按 CanRefitCargo 选（这个车型能拉这个货），不是按名字猜", () => {
		const fn = execCore().slice(execCore().indexOf("function PickRoadEngine("));
		expect(fn).toContain("GSEngine.CanRefitCargo");
		expect(fn).toContain("GSEngine.GetRoadType");
	});

	it("车真的改装到这条线的货（否则拉的是空车/别的货）", () => {
		const fn = execCore().slice(execCore().indexOf("function PhaseTruck("), execCore().indexOf("function PickRoadEngine("));
		expect(fn).toContain("GSVehicle.RefitVehicle(v, cargo)");
		expect(fn).toContain("GSOrder.AppendOrder(v, stA");
		expect(fn).toContain("GSOrder.AppendOrder(v, stB");
		expect(fn).toContain("GSVehicle.StartStopVehicle(v)");
	});

	it("铺路**复用**客运那套 LayPath（不重写铺路：探针重写留了 40 个断口）", () => {
		// 货运分支里不许出现自己的铺路调用。
		const freight = execCore().slice(execCore().indexOf("function TryBuildFreightStation("), execCore().indexOf("/* Next pax-ranked candidate"));
		expect(freight).not.toContain("BuildRoad(");
		expect(freight).not.toContain("LayPath(");
		// 阶段机是共用的：road → depot → vehicle。
		expect(execCore()).toContain('this._stage = "road";');
		expect(execCore()).toContain('this._stage = "depot";');
		expect(execCore()).toContain('this._stage = "bus";');
	});

	it("货运 job 的号段与客运**分开**（job 是台账主键，撞号会把两条线并成一条）", () => {
		expect(GS).toContain("_freight_seq = 0;");
		expect(GS).toContain("(1000 + this._freight_seq)");
		expect(GS).toContain("(100 + this._route_seq)");
	});
});

describe("GS：货运命令的校验是引擎事实，拒绝要说清原因", () => {
	it("命令在 Dispatch 里可达（D43：声明了没接线是最贵的失败形态）", () => {
		expect(GS).toContain('cmd == "build_freight_route"');
		expect(GS).toContain("function BuildFreightRoute(");
	});

	it("产/收关系用引擎自己的清单", () => {
		const fn = GS.slice(GS.indexOf("function BuildFreightRoute("), GS.indexOf("/* Find a depot site between station tiles"));
		expect(fn).toContain("GSIndustryList_CargoProducing(cargo)");
		expect(fn).toContain("GSIndustryList_CargoAccepting(cargo)");
		expect(fn).toContain("GSCargo.IsFreight(cargo)");
	});

	it("每种拒绝都有具名原因（静默会让模型学错因果，D20）", () => {
		const fn = GS.slice(GS.indexOf("function BuildFreightRoute("), GS.indexOf("/* Find a depot site between station tiles"));
		for (const reason of [
			"unknown cargo",
			"cargo is not freight",
			"unknown producer industry",
			"unknown consumer industry",
			"does not produce",
			"does not accept",
			"no loading site",
			"no unloading site",
		]) {
			expect(fn, `缺少具名拒绝：${reason}`).toContain(reason);
		}
	});
});

describe("hub：货运事实与拒绝都进模型看得到的地方", () => {
	function fakeWorld() {
		return {
			ingest: vi.fn(), setTowns: vi.fn(), setIndustries: vi.fn(), setIndustrySites: vi.fn(),
			setCargoCatalog: vi.fn(), setEngines: vi.fn(), setDateFromRaw: vi.fn(),
			setCargoTotals: vi.fn(), setCompanyCargo: vi.fn(), setFreightLinks: vi.fn(),
			pushWorldEvent: vi.fn(), snapshot: () => ({ date: { year: 1950, month: 1, day: 1 } }),
		};
	}
	function hub(w: unknown, onNotableEvent: (s: string) => void = () => {}) {
		return makeSignalHub({
			world: w as never, getWeb: () => null, getSession: () => null,
			routeLedger: { markDone: vi.fn(), record: vi.fn(), recordVehicleJobs: vi.fn(), noteVehicleEvent: vi.fn() } as never,
			getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent,
		});
	}

	it("freight_links 进世界状态（GS 的引擎事实）", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: {
				cmd: "state", date: 1,
				freight_links: [
					{ cargo: "COAL", producer: 28 },
					{ cargo: "GRAIN", producer: 31 },
				],
			},
		} as unknown as GameEvent);
		expect(w.setFreightLinks).toHaveBeenCalledWith([
			{ cargo: "COAL", producer: 28 },
			{ cargo: "GRAIN", producer: 31 },
		]);
	});

	it("GS 拒绝了命令 ⇒ 模型必须看见原因（否则它只会重复同一个命令）", () => {
		const seen: string[] = [];
		const w = fakeWorld();
		hub(w, (s) => seen.push(s)).onEvent({
			kind: "gamescript",
			payload: {
				kind: "err", cmd: "build_freight_route",
				reason: "no loading site: no accepting industry near industry 28",
			},
		} as unknown as GameEvent);
		expect(seen.join(" ")).toContain("build_freight_route");
		expect(seen.join(" ")).toContain("no loading site");
	});
});

describe("模型看得见'哪里能装货'（投影 → 决策上下文 / observe）", () => {
	const snap = {
		date: { raw: 0, year: 1950, month: 1, day: 1 },
		companies: new Map(), recent: [], totalEvents: 0,
		towns: [], townsTotal: 0, industries: [], industriesTotal: 0, industrySites: [],
		cargoCatalog: [{ label: "COAL", freight: true, producers: [28], consumers: [53] }],
		cargoTotals: [{ label: "COAL", produced: 100, transported: 0 }],
		freightLinks: [{ cargo: "COAL", producer: 28 }],
		engines: [], companyCargo: null,
	} as unknown as WorldSnapshot;

	it("投影里带着可运链路", () => {
		const f = worldFacts(snap);
		expect(f.freightLinks).toEqual([{ cargo: "COAL", producer: 28 }]);
	});

	it("决策上下文带着它（不必等模型自己去调工具）", () => {
		const facts = worldFacts(snap);
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: facts.date, companies: facts.companies },
			since: emptyTracker(),
			cargo: {
				totals: facts.cargoTotals,
				industries: facts.industries,
				links: facts.freightLinks,
			},
		});
		expect(ctx.cargo?.links?.[0]).toEqual({ cargo: "COAL", producer: 28 });
	});

	it("observe() 的 summary 里看得见（summary 才是模型读到的文本）", async () => {
		const tool = observeTool({ state: { snapshot: () => snap } } as never);
		const res = await tool.execute("c1", {});
		const text = (res as { content?: { text?: string }[] }).content?.[0]?.text ?? "";
		expect(text).toContain("freightLinks");
		expect(text).toContain("COAL");
	});
});

describe("看板接线：这条线运的货（货运 F3）", () => {
	function fakeWorldForHub() {
		return {
			ingest: vi.fn(), setTowns: vi.fn(), setIndustries: vi.fn(), setIndustrySites: vi.fn(),
			setCargoCatalog: vi.fn(), setEngines: vi.fn(), setDateFromRaw: vi.fn(),
			setCargoTotals: vi.fn(), setCompanyCargo: vi.fn(), setFreightLinks: vi.fn(),
			pushWorldEvent: vi.fn(), snapshot: () => ({ date: { year: 1950, month: 1, day: 1 } }),
		};
	}
	function hubForHub(w: unknown) {
		return makeSignalHub({
			world: w as never, getWeb: () => null, getSession: () => null,
			routeLedger: { markDone: vi.fn(), record: vi.fn(), recordVehicleJobs: vi.fn(), noteVehicleEvent: vi.fn() } as never,
			getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
	}

	it("GS 在 route-stats 里报 cargoCarried（客运线 = PASS，货运线 = 货种）", () => {
		expect(GS).toContain('payload.rawset("cargoCarried"');
		// 与"后来改装指令的生效值"（cargoApplied）是两个事实。
		expect(GS).toContain('payload.rawset("cargoApplied"');
	});

	it("hub 解析 cargoCarried（缺席 = 字段缺席，不是空串）", () => {
		const w = fakeWorldForHub();
		const hub = hubForHub(w);
		hub.onEvent({
			kind: "gamescript",
			payload: {
				kind: "route-stats", job: 1000, vehicles: 2, profit: 900, waiting: 30,
				gameDate: 712260, cargoCarried: "COAL",
			},
		} as unknown as GameEvent);
		const rows = hub.getRouteStats();
		expect(rows[0]!.cargoCarried).toBe("COAL");
		// 老 GS 没报 ⇒ 字段缺席（不是空串：空串会被页面读成"不运货"）。
		hub.onEvent({
			kind: "gamescript",
			payload: {
				kind: "route-stats", job: 1001, vehicles: 1, profit: 0, waiting: 0, gameDate: 712260,
			},
		} as unknown as GameEvent);
		const second = hub.getRouteStats().find((r) => r.job === 1001)!;
		expect(second.cargoCarried).toBeUndefined();
	});

	it("线路读数 → 看板线事实：cargoCarried 一路带到底（join 不许丢字段）", () => {
		const facts = routeWireFacts(
			[
				{
					job: 1000, vehicles: 2, profit: 900, waiting: 30, gameDate: 712260,
					cargoCarried: "COAL", vehiclesIds: [7, 8], endsA: 3, endsB: 4,
				},
			],
			[],
		);
		expect(facts[0]!.cargoCarried).toBe("COAL");
		// 老 GS 没报 ⇒ 字段缺席（不是空串）。
		const old = routeWireFacts([{ job: 1, vehicles: 1, profit: 0, waiting: 0, gameDate: 1 }], []);
		expect(old[0]!.cargoCarried).toBeUndefined();
	});
});

describe("动作面：build_freight_route（与 build_bus_route 同级）", () => {
	function deps() {
		const sent: string[] = [];
		return { sent, deps: { sink: { gameScript: (s: string) => sent.push(s) } } as never };
	}

	it("命令的形状：货种 + 两端产业 + 公司", async () => {
		const { sent, deps: d } = deps();
		const tool = buildFreightRouteTool(d);
		await tool.execute("c1", { cargo: "COAL", from_industry: 28, to_industry: 53 });
		expect(sent).toHaveLength(1);
		expect(JSON.parse(sent[0]!)).toEqual({
			cmd: "build_freight_route",
			company: 0,
			cargo: "COAL",
			from_industry: 28,
			to_industry: 53,
		});
	});

	it("串行执行（变更型命令并发会让台账顺序不等于游戏应用顺序）", () => {
		const { deps: d } = deps();
		expect(buildFreightRouteTool(d).executionMode).toBe("sequential");
	});

	it("登记为写动作，并进策略身份词表（否则货运行为没有身份、晋升不了）", () => {
		expect(ACTION_EFFECTS.build_freight_route).toBe("write");
		expect(STRATEGY_ACTIONS).toContain("build_freight_route");
	});
});
