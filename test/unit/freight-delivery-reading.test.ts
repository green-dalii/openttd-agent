/**
 * 货运 F4 / A3+A4：读数（逐 (货种, 产业) 的增量 + 线路两端的产业 id）与归因。
 *
 * 为什么这两件事必须一起验收：
 *   - GS 的 cargo monitor **只知道**"本公司往某产业送了 N 吨"，它**不知道是哪条线**
 *     ⇒ 引擎没有逐线路的粒度（`docs/PER-LINE-DELIVERY-FEASIBILITY.md` §4.1）。
 *   - 所以逐线路的数字**只能由我们自己推导**：读数是原料（A3），线路的端点是另一半
 *     原料（A3），归因规则是推导（A4）。
 *   - 三者缺一 ⇒ 归因要么退化成"猜"，要么退化成 0。
 *
 * 断言锁住：
 *   1. GS 真的**逐 (货种, 产业)** 累计（不合并到货种），且不用动态键的表（D95）；
 *   2. GS 真的把**线路两端的产业 id** 报上来（线路登记表 + route-stats）；
 *   3. hub 把两者都收进来，并按归因规则给出**推导值**（分不出来 = null + 原因）。
 *
 * 事实来源: SPEC §10.126；`docs/PER-LINE-DELIVERY-FEASIBILITY.md` §4.2。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { makeSignalHub } from "../../src/agent/signal-hub.js";
import type { GameEvent } from "../../src/types.js";

const GS = readFileSync(new URL("../../src/game/squirrel/bridge-gs/main.nut", import.meta.url), "utf8");

function fakeWorld() {
	return {
		ingest: vi.fn(),
		setTowns: vi.fn(),
		setIndustries: vi.fn(),
		setCargoTotals: vi.fn(),
		setCompanyCargo: vi.fn(),
		snapshot: () => ({
			companyCargo: {
				byCargo: [{ label: "COAL", amount: 120 }],
				byIndustry: [{ label: "COAL", industry: 53, amount: 120 }],
				quarterDelivered: 120,
				monitored: { cargoes: 9, destinations: 38 },
				gaps: { dropped: 0 },
			},
		}),
	};
}

function hubFor(w: unknown) {
	return makeSignalHub({
		world: w as never,
		getWeb: () => null,
		getSession: () => null,
		routeLedger: { markDone: vi.fn(), record: vi.fn(), recordVehicleJobs: vi.fn(), noteVehicleEvent: vi.fn() } as never,
		getDecisionCount: () => 0,
		onPhaseChange: () => {},
		onNotableEvent: () => {},
	});
}

describe("GS（A3）：逐 (货种, 产业) 的读数 + 线路两端的产业 id", () => {
	it("monitor 的增量**按目的地产业分开记**（不合并到货种）", () => {
		// 归因缺的不是算法，是"送到哪"这一层读数 ⇒ GS 必须多带一层。
		expect(GS).toContain("own_by_industry");
		expect(GS).toContain("_own_by_industry");
		// 累加器是**数组**（Squirrel 的表不能动态建键，D44/D95）。
		expect(GS).toContain("by_industry.append({ label = p.label, industry = p.industry, amount = amt })");
		const collect = GS.slice(GS.indexOf("function CollectFacts("), GS.indexOf("function Start("));
		expect(collect).not.toMatch(/by_industry\s*\[\s*[A-Za-z_]/);
	});

	it("线路登记表带着它的两个产业 id（否则归因无从下手）", () => {
		expect(GS).toContain('frec.rawset("fromIndustry", producer)');
		expect(GS).toContain('frec.rawset("toIndustry", consumer)');
	});

	it("route-stats 把两端产业 id 报上来（客运线没有 ⇒ 字段缺席）", () => {
		expect(GS).toContain('payload.rawset("fromIndustry"');
		expect(GS).toContain('payload.rawset("toIndustry"');
	});

	it("逐产业读数真的**发出去**（事实表里有 ≠ 状态包里也有）", () => {
		// 真机教训（2026-11-08）：事实表里有了 `own_by_industry`，但状态包是
		// **逐字段拷贝**的 ⇒ 忘了拷这一行 ⇒ harness 永远收不到 ⇒ 交付 60 吨煤
		// 而归因原料是空的（静默：无报错、只是读数没到）。
		expect(GS).toContain("own_by_industry = (f == null) ? [] : f.own_by_industry");
	});
});

describe("hub（A3）：GS 的读数进世界状态", () => {
	it("own_by_industry 被解析成逐 (货种, 产业) 的累计", () => {
		const w = fakeWorld();
		const hub = hubFor(w);
		hub.onEvent({
			kind: "gamescript",
			payload: {
				cmd: "state",
				own_delivered: [{ label: "COAL", amount: 120 }],
				own_by_industry: [{ label: "COAL", industry: 53, amount: 120 }],
				own_monitored: { cargoes: 9, destinations: 38 },
				own_gaps: { dropped: 0 },
			},
		} as unknown as GameEvent);
		const call = (w.setCompanyCargo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
			byIndustry: { label: string; industry: number; amount: number }[];
		};
		expect(call?.byIndustry).toEqual([{ label: "COAL", industry: 53, amount: 120 }]);
	});

	it("老 GS 不报逐产业读数 ⇒ 空数组（不是「每条都是 0」）", () => {
		const w = fakeWorld();
		const hub = hubFor(w);
		hub.onEvent({
			kind: "gamescript",
			payload: { cmd: "state", own_delivered: [{ label: "COAL", amount: 120 }] },
		} as unknown as GameEvent);
		const call = (w.setCompanyCargo as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
			byIndustry: unknown[];
		};
		expect(call?.byIndustry).toEqual([]);
	});
});

describe("hub（A4）：归因把读数与线路接起来", () => {
	it("route-stats 的两端产业 id 与货种进线路读数（缺席 = 客运线）", () => {
		const w = fakeWorld();
		const hub = hubFor(w);
		hub.onEvent({
			kind: "gamescript",
			payload: {
				kind: "route-stats", job: 1000, vehicles: 2, profit: 900, waiting: 30,
				gameDate: 712260, cargoCarried: "COAL", fromIndustry: 28, toIndustry: 53,
			},
		} as unknown as GameEvent);
		const row = hub.getRouteStats()[0]!;
		expect(row.cargoCarried).toBe("COAL");
		expect(row.fromIndustry).toBe(28);
		expect(row.toIndustry).toBe(53);
	});

	it("唯一服务该 (货种, 产业) 的线 ⇒ 交付归它（推导值，带口径）", () => {
		const w = fakeWorld();
		const hub = hubFor(w);
		hub.onEvent({
			kind: "gamescript",
			payload: {
				kind: "route-stats", job: 1000, vehicles: 2, profit: 900, waiting: 30,
				gameDate: 712260, cargoCarried: "COAL", fromIndustry: 28, toIndustry: 53,
			},
		} as unknown as GameEvent);
		const out = hub.getFreightAttribution();
		expect(out.routes).toHaveLength(1);
		expect(out.routes[0]!.job).toBe(1000);
		expect(out.routes[0]!.amount).toBe(120);
		expect(out.routes[0]!.derived).toBe(true);
		expect(out.unattributed).toEqual([]);
	});

	it("多条线服务同一个 (货种, 产业) ⇒ 不可分摊（null + 原因），不猜", () => {
		const w = fakeWorld();
		const hub = hubFor(w);
		for (const job of [1000, 1001]) {
			hub.onEvent({
				kind: "gamescript",
				payload: {
					kind: "route-stats", job, vehicles: 2, profit: 0, waiting: 0,
					gameDate: 712260, cargoCarried: "COAL", fromIndustry: 28, toIndustry: 53,
				},
			} as unknown as GameEvent);
		}
		const out = hub.getFreightAttribution();
		expect(out.routes.every((r) => r.amount === null)).toBe(true);
		expect(out.routes[0]!.reason).toMatch(/2 routes share/);
		// 那批货不许被任何一条线领走。
		expect(out.unattributed[0]!.amount).toBe(120);
	});
});
