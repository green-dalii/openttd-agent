/**
 * 线路诊断（Issue #113）：事实 → 具名原因。
 *
 * 这套测试钉的是**判定规则**，不是文案：每个具名原因都必须能由一组事实
 * **唯一**地判定出来，且"没测到"不能被当成"没问题"。
 */
import { describe, expect, it } from "vitest";

import {
	ROUTE_DIAGNOSIS_REASONS,
	diagnoseRoute,
	diagnoseRoutes,
	type RouteDiagRoute,
	type RouteDiagVehicle,
} from "../../src/agent/route-diagnosis.js";

const vehicle = (over: Partial<RouteDiagVehicle> = {}): RouteDiagVehicle => ({
	id: 8,
	valid: true,
	state: 0,
	tile: 60815,
	loaded: 0,
	capacity: 20,
	refitCapacity: 20,
	orderCount: 2,
	orders: [
		{ index: 0, tile: 60815, isStation: true, flags: 1 },
		{ index: 1, tile: 39473, isStation: true, flags: 1 },
	],
	...over,
});

const route = (over: Partial<RouteDiagRoute> = {}): RouteDiagRoute => ({
	job: 1000,
	cargo: "COAL",
	ends: [
		{ role: "load", tile: 60815, station: 0, waiting: 303 },
		{ role: "unload", tile: 39473, station: 1, waiting: 0 },
	],
	roadConnected: true,
	vehicles: [vehicle()],
	...over,
});

describe("线路诊断：每个具名原因都能由事实判定", () => {
	it("线没有车 ⇒ no_vehicles（还没买车，不是坏了）", () => {
		expect(diagnoseRoute(route({ vehicles: [] })).reason).toBe("no_vehicles");
	});

	it("车没有订单 ⇒ no_orders（它没有路线）", () => {
		const r = route();
		r.vehicles = [vehicle({ orderCount: 0, orders: [] })];
		expect(diagnoseRoute(r).reason).toBe("no_orders");
	});

	it("订单不是去车站 ⇒ orders_not_station（它不会停站 ⇒ 不会装货）", () => {
		const r = route();
		r.vehicles = [
			vehicle({ orders: [{ index: 0, tile: 60815, isStation: false, flags: 1 }] }),
		];
		expect(diagnoseRoute(r).reason).toBe("orders_not_station");
	});

	it("两端之间路不连通 ⇒ road_not_connected", () => {
		expect(diagnoseRoute(route({ roadConnected: false })).reason).toBe("road_not_connected");
	});

	it("车没被改成这条线的货（引擎行、但货种不对）⇒ vehicle_not_refitted_to_cargo", () => {
		const r = route();
		r.vehicles = [vehicle({ capacity: 0, refitCapacity: 20 })];
		const d = diagnoseRoute(r);
		expect(d.reason).toBe("vehicle_not_refitted_to_cargo");
		expect(d.detail).toContain("COAL");
	});

	it("引擎压根装不了这个货 ⇒ engine_cannot_carry_cargo", () => {
		const r = route();
		r.vehicles = [vehicle({ capacity: 0, refitCapacity: 0 })];
		expect(diagnoseRoute(r).reason).toBe("engine_cannot_carry_cargo");
	});

	it("车在装货站、货在等、它装得了却不装 ⇒ at_loading_end_but_not_loaded", () => {
		const r = route();
		r.vehicles = [vehicle({ tile: 60815, loaded: 0 })];
		expect(diagnoseRoute(r).reason).toBe("at_loading_end_but_not_loaded");
	});

	it("装货站的货**明确被路由到别的站** ⇒ cargo_not_planned_via_this_line", () => {
		const r = route({
			ends: [
				{
					role: "load",
					tile: 60815,
					station: 0,
					waiting: 303,
					waitingVia: 0,
					waitingViaNone: 0,
					waitingViaSelf: 0,
				},
				{ role: "unload", tile: 39473, station: 1, waiting: 0, waitingVia: 0 },
			],
		});
		expect(diagnoseRoute(r).reason).toBe("cargo_not_planned_via_this_line");
	});

	it("货**没有下一跳**（兜底给任何车）⇒ 不是流向问题（真机实测：290 单位全在这一桶）", () => {
		const r = route({
			ends: [
				{
					role: "load",
					tile: 60815,
					roadTile: 60816,
					station: 0,
					waiting: 338,
					waitingVia: 0,
					waitingViaNone: 338,
					waitingViaSelf: 0,
				},
				{ role: "unload", tile: 39473, roadTile: 39474, station: 1, waiting: 0, waitingVia: 0 },
			],
		});
		r.vehicles = [vehicle({ tile: 60816, loaded: 0, capacity: 20, speed: 48 })];
		expect(diagnoseRoute(r).reason).toBe("at_loading_end_but_not_loaded");
	});

	it("车很久没动 ⇒ vehicle_not_moving（最根本的一档：路断/堵/到不了）", () => {
		const r = route();
		r.vehicles = [vehicle({ tile: 70000, idleTicks: 5000 })];
		expect(diagnoseRoute(r).reason).toBe("vehicle_not_moving");
	});

	it("车刚动过（idleTicks 小）⇒ 不是『卡住』", () => {
		const r = route();
		r.vehicles = [vehicle({ tile: 70000, idleTicks: 5, loaded: 20 })];
		expect(diagnoseRoute(r).reason).not.toBe("vehicle_not_moving");
	});

	it("idleTicks 没测到（null）⇒ 不能说『卡住』", () => {
		const r = route();
		r.vehicles = [vehicle({ tile: 70000, idleTicks: undefined, loaded: 20 })];
		expect(diagnoseRoute(r).reason).not.toBe("vehicle_not_moving");
	});

	it("车停在**门前格**（路旁格）且没装货 ⇒ at_loading_end_but_not_loaded（并说它在动）", () => {
		// 真机：车停的是路旁格（roadTile），不是标牌格（tile）。
		const r = route({
			ends: [
				{ role: "load", tile: 60815, roadTile: 60816, station: 0, waiting: 338, waitingVia: 0 },
				{ role: "unload", tile: 39473, roadTile: 39474, station: 1, waiting: 0, waitingVia: 0 },
			],
		});
		r.vehicles = [vehicle({ tile: 60816, loaded: 0, capacity: 20, speed: 48 })];
		const d = diagnoseRoute(r);
		expect(d.reason).toBe("at_loading_end_but_not_loaded");
		expect(d.detail).toContain("still moving");
	});

	it("装货端的货**是**计划经由这条线运走的 ⇒ 不是流向问题", () => {
		const r = route({
			ends: [
				{ role: "load", tile: 60815, station: 0, waiting: 303, waitingVia: 303 },
				{ role: "unload", tile: 39473, station: 1, waiting: 0, waitingVia: 0 },
			],
		});
		expect(diagnoseRoute(r).reason).not.toBe("cargo_not_planned_via_this_line");
	});

	it("装货端没货在等 ⇒ no_cargo_waiting（没东西可运，不是故障）", () => {
		const r = route({
			ends: [
				{ role: "load", tile: 60815, station: 0, waiting: 0 },
				{ role: "unload", tile: 39473, station: 1, waiting: 0 },
			],
		});
		r.vehicles = [vehicle({ tile: 70000 })];
		expect(diagnoseRoute(r).reason).toBe("no_cargo_waiting");
	});

	it("事实齐了但没发现故障 ⇒ no_fault_found", () => {
		const r = route();
		r.vehicles = [vehicle({ tile: 70000, loaded: 20 })];
		expect(diagnoseRoute(r).reason).toBe("no_fault_found");
	});
});

describe("线路诊断：没测到 ≠ 没问题", () => {
	it("等货量没测到（-1）时，不能说\"没货在等\"", () => {
		const r = route({
			ends: [
				{ role: "load", tile: 60815, station: 0, waiting: -1 },
				{ role: "unload", tile: 39473, station: 1, waiting: -1 },
			],
		});
		r.vehicles = [vehicle({ tile: 70000, loaded: 20 })];
		// waiting = -1 ⇒ 不知道 ⇒ 不能落到 no_cargo_waiting。
		expect(diagnoseRoute(r).reason).not.toBe("no_cargo_waiting");
	});

	it("路连通性没测到（null）时，不能说\"路不连通\"", () => {
		expect(diagnoseRoute(route({ roadConnected: null })).reason).not.toBe("road_not_connected");
	});

	it("容量没测到时，不能说\"车没被改装\"", () => {
		const r = route();
		r.vehicles = [vehicle({ capacity: undefined, refitCapacity: undefined })];
		expect(diagnoseRoute(r).reason).not.toBe("vehicle_not_refitted_to_cargo");
		expect(diagnoseRoute(r).reason).not.toBe("engine_cannot_carry_cargo");
	});
});

describe("线路诊断：词表是封闭的", () => {
	it("每个原因都出现在词表里（没有词表外的结论）", () => {
		const seen = new Set<string>();
		const variants: RouteDiagRoute[] = [
			route({ vehicles: [] }),
			route({ roadConnected: false }),
			route(),
		];
		for (const v of variants) seen.add(diagnoseRoute(v).reason);
		for (const reason of seen) expect(ROUTE_DIAGNOSIS_REASONS).toContain(reason);
	});

	it("诊断一批线：每条线一个结论（顺序不变）", () => {
		const out = diagnoseRoutes([route({ job: 1000 }), route({ job: 1001, vehicles: [] })]);
		expect(out.map((d) => d.job)).toEqual([1000, 1001]);
		expect(out[1]?.reason).toBe("no_vehicles");
	});
});
