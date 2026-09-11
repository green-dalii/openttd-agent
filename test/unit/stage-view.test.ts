/**
 * Unit tests — stage view (data-rendered map snapshot).
 *
 * 职责: 锁定「由世界数据推导出的示意图」的纯计算部分。
 *   为什么不是截图：OpenTTD dedicated server **没有帧缓冲**，rcon `screenshot`
 *   实测返回 `Screenshot failed!`，像素级截图在本架构下不可能
 *   （docs/AGENT-LOOP-AND-CONTROL.md §4）。
 */

import { describe, expect, it } from "vitest";
import { buildStageView, tileToXY, type StageViewInput } from "../../src/agent/stage-view.js";

function input(over: Partial<StageViewInput> = {}): StageViewInput {
	return {
		gameDate: "1950-04-01",
		mapSize: [256, 256],
		companies: [{ id: 0, name: "CPU", money: 93000, vehicles: 3, stations: 2 }],
		route: null,
		phase: "EX hb road #1 j100",
		...over,
	};
}

describe("stage view", () => {
	it("renders a view even when no route has been built yet", () => {
		const v = buildStageView(input());
		expect(v.width).toBe(256);
		expect(v.height).toBe(256);
		expect(v.markers).toEqual([]);
		expect(v.routes).toEqual([]);
		// The summary must still describe the world.
		expect(v.companies[0]!.money).toBe(93000);
	});

	it("converts an OpenTTD tile index into map coordinates", () => {
		// Tiles are y * width + x (SPEC §2 / OpenTTD TileIndex).
		expect(tileToXY(0, 256)).toEqual({ x: 0, y: 0 });
		expect(tileToXY(255, 256)).toEqual({ x: 255, y: 0 });
		expect(tileToXY(256, 256)).toEqual({ x: 0, y: 1 });
		expect(tileToXY(256 * 2 + 5, 256)).toEqual({ x: 5, y: 2 });
	});

	it("places towns, stations and depot as markers from the GS ack", () => {
		const v = buildStageView(input({
			route: {
				tileA: 34878,
				tileB: 42079,
				frontA: 34879,
				frontB: 42080,
				depot: 38478,
				townA: 17,
				townB: 9,
				popA: 1361,
				popB: 2279,
			},
		}));
		const kinds = v.markers.map((m) => m.kind).sort();
		expect(kinds).toContain("town");
		expect(kinds).toContain("depot");
		// Two towns => two town markers, carrying their population.
		const towns = v.markers.filter((m) => m.kind === "town");
		expect(towns).toHaveLength(2);
		expect(towns.map((t) => t.label)).toEqual(expect.arrayContaining(["17", "9"]));
		expect(Math.max(...towns.map((t) => t.size ?? 0))).toBeGreaterThan(0);
	});

	it("normalises coordinates into 0..1 so any map size renders", () => {
		const v = buildStageView(input({
			mapSize: [512, 512],
			route: { tileA: 512 * 10 + 20, tileB: 512 * 20 + 40, frontA: 0, frontB: 0, depot: 0, townA: 1, townB: 2, popA: 10, popB: 20 },
		}));
		for (const m of v.markers) {
			expect(m.x).toBeGreaterThanOrEqual(0);
			expect(m.x).toBeLessThanOrEqual(1);
			expect(m.y).toBeGreaterThanOrEqual(0);
			expect(m.y).toBeLessThanOrEqual(1);
		}
		expect(v.width).toBe(512);
	});

	it("draws a route between the two endpoints", () => {
		const v = buildStageView(input({
			route: { tileA: 0, tileB: 256 * 5, frontA: 1, frontB: 2, depot: 3, townA: 1, townB: 2, popA: 5, popB: 6 },
		}));
		expect(v.routes).toHaveLength(1);
		const r = v.routes[0]!;
		expect(r.from.x).toBe(0);
		expect(r.from.y).toBe(0);
		expect(r.to.x).toBe(0);
		expect(r.to.y).toBeGreaterThan(0);
	});

	it("ignores a malformed route instead of producing NaN coordinates", () => {
		const v = buildStageView(input({
			route: { tileA: Number.NaN, tileB: 5, frontA: 0, frontB: 0, depot: 0, townA: 0, townB: 0, popA: 0, popB: 0 },
		}));
		for (const m of v.markers) {
			expect(Number.isFinite(m.x)).toBe(true);
			expect(Number.isFinite(m.y)).toBe(true);
		}
	});

	it("carries the phase and date so a timeline can label each snapshot", () => {
		const v = buildStageView(input({ phase: "EX done j100" }));
		expect(v.gameDate).toBe("1950-04-01");
		expect(v.phase).toBe("EX done j100");
	});

	it("summarises every company, not just the first", () => {
		const v = buildStageView(input({
			companies: [
				{ id: 0, name: "CPU", money: 100, vehicles: 1, stations: 1 },
				{ id: 1, name: "Rival", money: 200, vehicles: 2, stations: 3 },
			],
		}));
		expect(v.companies).toHaveLength(2);
		expect(v.companies[1]!.name).toBe("Rival");
	});

	it("degrades gracefully with no companies at all", () => {
		const v = buildStageView(input({ companies: [] }));
		expect(v.companies).toEqual([]);
		expect(v.markers).toEqual([]);
	});
});
