/**
 * 决策→结果台账（Issue #13 的第三项）。
 *
 * 职责: 守住"**推事件 → 线路 → 决策**"这条连接链。执行器说"我建好了"不是结果；
 *   "世界随后发生了什么"才是。连接靠**车辆 id**：执行器的 route-stats 报这条线的
 *   车辆，推事件报车辆 ⇒ 二者相接就是"这个决策带来的线路在世界上发生了什么"。
 * 为什么: 记忆此前只能回忆"我建没建 / 赚没赚钱"，记不住"**世界随后对我这条线做了什么**"。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RouteLedger } from "../../src/agent/route-ledger.js";
import { routeFactsFromLedger } from "../../src/evolution/route-facts.js";

describe("决策→结果台账（连接键的来源）", () => {
	it("用 `fleetIds`（这条线自己的车队），不用 `vehiclesIds`（站上的车可能属于别的线）", () => {
		const src = readFileSync(path.join("src", "agent", "signal-hub.ts"), "utf8");
		expect(src).toMatch(/recordVehicleJobs\(\s*job,\s*\n?\s*p\.fleetIds/);
		// vehiclesIds 仍进 route-stats（它是被去重/共享车站分析用的），
		// 但**不**用来归属事件。
		const attribution = src.slice(src.indexOf("recordVehicleJobs(") - 400, src.indexOf("recordVehicleJobs("));
		expect(attribution).not.toContain("p.vehiclesIds");
	});
});

describe("决策→结果台账", () => {
	function ledger(): RouteLedger {
		const l = new RouteLedger();
		l.record({ kind: "passenger", job: 100, fromTown: 1, toTown: 2, decision: 3, orderedAt: 1000, command: "build_bus_route" });
		return l;
	}

	it("车辆 → 线路的归属来自执行器的 route-stats（连接键）", () => {
		const l = ledger();
		l.recordVehicleJobs(100, [7, 8]);
		// 事件到了 ⇒ 挂在 job 100 上（即决策 3 的那条线）。
		l.noteVehicleEvent(8, "station_first_vehicle", "1950-03-01");
		const line = l.all().find((x) => x.order.job === 100)!;
		expect(line.outcome.observed).toEqual([
			{ kind: "station_first_vehicle", vehicle: 8, date: "1950-03-01" },
		]);
	});

	it("不认识的车上的事件**不归因**（不许猜）", () => {
		const l = ledger();
		l.noteVehicleEvent(99, "vehicle_lost");
		const line = l.all().find((x) => x.order.job === 100)!;
		expect(line.outcome.observed ?? []).toEqual([]);
	});

	it("没有车辆 id 的事件不归因", () => {
		const l = ledger();
		l.recordVehicleJobs(100, [7]);
		l.noteVehicleEvent(null, "industry_open");
		const line = l.all().find((x) => x.order.job === 100)!;
		expect(line.outcome.observed ?? []).toEqual([]);
	});

	it("同一辆车同一件事只记一次", () => {
		const l = ledger();
		l.recordVehicleJobs(100, [8]);
		l.noteVehicleEvent(8, "station_first_vehicle", "1950-03-01");
		l.noteVehicleEvent(8, "station_first_vehicle", "1950-03-01");
		expect(l.all()[0]!.outcome.observed).toHaveLength(1);
	});

	it("台账的**事实句**里出现世界侧的证据（反思拿得到）", () => {
		const l = ledger();
		l.recordVehicleJobs(100, [8]);
		l.noteVehicleEvent(8, "station_first_vehicle");
		const text = l.lines().join("\n");
		expect(text).toContain("station_first_vehicle");
		expect(text).toContain("decision 3");
	});

	it("事实落库时带着观测到的事件（跨局记忆）", () => {
		const l = ledger();
		l.recordVehicleJobs(100, [8]);
		l.noteVehicleEvent(8, "station_first_vehicle", "1950-03-01");
		const facts = routeFactsFromLedger(l.all());
		expect(facts[0]!.observed).toEqual([
			{ kind: "station_first_vehicle", vehicle: 8, date: "1950-03-01" },
		]);
	});

	it("没有观测到事件时，事实里**没有**这个字段（不是空数组冒充「观测到了」）", () => {
		const l = ledger();
		const facts = routeFactsFromLedger(l.all());
		expect(facts[0]!.observed).toBeUndefined();
	});
});
