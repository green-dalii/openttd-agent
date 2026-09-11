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


/**
 * The zoom window ("focus").
 *
 * 为什么需要（2026-09-12 实测）: `screenshot minimap` 对 256×256 地图输出
 * 256×256 的 PNG = **1 像素/格**。一次施工改动只有几格宽 → 图上只差 1-2 个像素，
 * 于是"每个阶段的画面看起来一样"（实测 6 次抓取只有 3 张不同，且游戏日期全是
 * 1950-01-01）。因此由服务端算出**该阶段施工所在的窗口**，前端据此裁剪放大，
 * 让小改动可见。这是数据问题，不是截图频率问题。
 */
describe("stage view focus (zoom window)", () => {
	/** A view built from a real-shaped ack payload, as the GS sends it. */
	function viewWith(tileA: number, tileB: number, depot: number) {
		return buildStageView({
			gameDate: "1950-01-01",
			mapSize: [256, 256],
			companies: [{ id: 0, name: "c", money: 1, vehicles: 0, stations: 1 }],
			route: { tileA, tileB, depot, townA: 1, townB: 2, popA: 100, popB: 200 },
		});
	}

	it("centres on the construction area, not the whole map", () => {
		// tile = y*256 + x. Two nearby towns -> a tight window around them.
		const a = 68 * 256 + 62; // x=62,y=68
		const b = 82 * 256 + 95; // x=95,y=82
		const v = viewWith(a, b, b);
		expect(v.focus).toBeDefined();
		const f = v.focus!;
		// Centre sits between the two towns.
		expect(f.x).toBeGreaterThan(62 / 256);
		expect(f.x).toBeLessThan(95 / 256);
		expect(f.y).toBeGreaterThan(68 / 256);
		expect(f.y).toBeLessThan(82 / 256);
	});

	it("zooms in far enough that a few tiles are visible", () => {
		// A window spanning ~1/4 of the map means each tile is ~4x bigger on screen.
		const v = viewWith(60 * 256 + 60, 60 * 256 + 63, 60 * 256 + 63);
		expect(v.focus!.scale).toBeGreaterThan(2);
	});

	it("never zooms past a sane maximum (a 1-tile span must not fill the screen)", () => {
		const t = 40 * 256 + 40;
		const v = viewWith(t, t, t);
		expect(v.focus!.scale).toBeLessThanOrEqual(12);
	});

	it("stays inside the map (window is clamped to the edges)", () => {
		// Towns in the far corner: a naive centre would push the window off-map.
		const a = 2 * 256 + 2;
		const b = 5 * 256 + 5;
		const f = viewWith(a, b, b).focus!;
		expect(f.x).toBeGreaterThanOrEqual(0);
		expect(f.x).toBeLessThanOrEqual(1);
		expect(f.y).toBeGreaterThanOrEqual(0);
		expect(f.y).toBeLessThanOrEqual(1);
		// And the window must not extend past the edge.
		const half = 1 / (2 * f.scale);
		expect(f.x - half).toBeGreaterThanOrEqual(-0.001);
		expect(f.x + half).toBeLessThanOrEqual(1.001);
	});

	it("has no focus when there is nothing to look at", () => {
		const v = buildStageView({
			gameDate: "1950-01-01",
			mapSize: [256, 256],
			companies: [],
			route: null,
		});
		// No markers/routes -> the whole map is the honest view.
		expect(v.focus).toBeUndefined();
	});
});
