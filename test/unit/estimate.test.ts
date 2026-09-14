import { describe, expect, it } from "vitest";
import { estimateRoute, manhattanDistance, ROAD_COST_PER_TILE } from "../../src/agent/estimate.js";

describe("estimate_route — 事实而非建议（SIGNAL-ARCHITECTURE L2）", () => {
	// 坐标取自真实 GS town_list（SPEC §10.33）：agent 曾在没有任何距离信号时
	// 选了 9→1，104 格直线的路 200 秒建不完。估价工具存在后它至少能在
	// 花钱之前看见"这条线的路就要吃掉多少现金"。
	const t9 = { id: 9, x: 97, y: 162 };
	const t1 = { id: 1, x: 184, y: 221 };

	it("曼哈顿距离：|dx| + |dy|", () => {
		expect(manhattanDistance(t9, t1)).toBe(87 + 59);
		expect(manhattanDistance(t9, t9)).toBe(0);
	});

	it("造价 = 直线格数 × 每格实测价（£307，SPEC §10.25）", () => {
		const est = estimateRoute(t9, t1, 286_094);
		expect(est.straightTiles).toBe(146);
		expect(est.roadCostLowerBound).toBe(146 * ROAD_COST_PER_TILE);
		expect(est.roadCostShareOfBalance).toBeCloseTo(est.roadCostLowerBound / 286_094);
	});

	it("notes 必须声明这是下界（直线比真路短、未含站/车库/车）", () => {
		const est = estimateRoute(t9, t1, null);
		expect(est.notes.join(" ")).toMatch(/never shorter/);
		expect(est.notes.join(" ")).toMatch(/higher/);
	});

	it("余额未知时 share 为 null，而不是编一个数", () => {
		expect(estimateRoute(t9, t1, null).roadCostShareOfBalance).toBeNull();
	});

	it("零余额不除零", () => {
		expect(estimateRoute(t9, t1, 0).roadCostShareOfBalance).toBeNull();
	});
});
