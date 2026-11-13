/**
 * 线路诊断（Issue #113）：一条线**建成了、车改了、货在等、整局交付 0**，
 * 而周期读数只报"几辆车在等"⇒ 看不出**车卡在哪、订单对不对**。
 *
 * 这是**按需**诊断：周期载荷不许变大（SPEC §10.126）⇒ 诊断必须是**命令**，
 * 不是状态字段。
 *
 * 为什么用静态测试：GS 的代码只在 OpenTTD 里跑，一个写错的名字不会让单测
 * 变红，只会让那一条命令在真机上"永远不回答"（MEMORY D41：声明了没接线）。
 * 所以这里钉住的是**命令被接线**与**它读哪些事实**。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nut = readFileSync(
	new URL("../../src/game/squirrel/bridge-gs/main.nut", import.meta.url),
	"utf8",
);

describe("线路诊断（按需）：一条线为什么不跑，必须能被问出来", () => {
	it("命令被接线（cmd == \"route_diag\"），不是只声明未接线", () => {
		expect(nut).toContain('cmd == "route_diag"');
	});

	it("诊断读的是**能定位卡点的事实**：车的状态、位置、订单", () => {
		expect(nut).toContain("GSVehicle.GetState");
		expect(nut).toContain("GSVehicle.GetLocation");
		expect(nut).toContain("GSOrder.GetOrderCount");
		expect(nut).toContain("GSOrder.GetOrderDestination");
	});

	it("诊断读两端车站与**在等的货**（没有它就分不清\"没货\"与\"车没到\"）", () => {
		expect(nut).toContain("GSStation.GetCargoWaiting");
	});

	it("诊断读路是否连通（车出不来是最常见的物理原因）", () => {
		expect(nut).toContain("GSRoad.AreRoadTilesConnected");
	});

	it("诊断读车载量与载量（装了却没卸下 ≠ 根本没装）", () => {
		expect(nut).toContain("GSVehicle.GetCargoLoad");
		expect(nut).toContain("GSVehicle.GetRefitCapacity");
	});

	it("诊断是**按需**命令：不在周期状态载荷里（载荷不许变大）", () => {
		// 周期状态由 ReportState 发出；诊断答案走 answer 通道。
		const stateAt = nut.indexOf('cmd = "state"');
		expect(stateAt).toBeGreaterThan(-1);
		const stateBlock = nut.slice(stateAt - 4000, stateAt + 4000);
		expect(stateBlock, "诊断字段不得混进周期状态").not.toContain("routeDiag");
	});
});
