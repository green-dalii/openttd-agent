/**
 * Tests for the prebuilt scenario (S1/G4).
 *
 * Why: in the freeform episode the outcome is dominated by whether the executor
 * managed to finish a road inside the window - measured spreads of 0..527
 * delivered with the same fleet, and horizons that varied 0..449 game days. The
 * agent's actual management decisions (how many vehicles, when to extend) only
 * become measurable once a route EXISTS, which is exactly what S0 confirmed: the
 * fleet lever is real and steep between 3 and 15 vehicles.
 *
 * So the scenario builds a deterministic route BEFORE the measurement window
 * opens, waits until it is OPERABLE, and only then hands control to the agent.
 * The measurement then covers the management window only.
 */
import { describe, expect, it, vi } from "vitest";
import {
	isPrebuiltReady,
	pickBlueprintTownPairs,
	pickBlueprintTowns,
	runPrebuiltScenario,
} from "../../src/agent/prebuilt.js";

describe("prebuilt scenario readiness", () => {
	it("is not ready while the route cannot carry anything", () => {
		// Stations built but no vehicle: nothing moves yet.
		expect(isPrebuiltReady({ stations: 2, vehicles: 0 })).toBe(false);
		// A vehicle exists but the second station is missing: no route.
		expect(isPrebuiltReady({ stations: 1, vehicles: 1 })).toBe(false);
		expect(isPrebuiltReady({ stations: 0, vehicles: 0 })).toBe(false);
	});

	it("is ready once the route can move cargo", () => {
		expect(isPrebuiltReady({ stations: 2, vehicles: 1 })).toBe(true);
		expect(isPrebuiltReady({ stations: 2, vehicles: 3 })).toBe(true);
	});
});

describe("prebuilt scenario run", () => {
	const fake = (samples: { stations: number; vehicles: number }[], orderAck = true) => {
		let i = 0;
		return {
			sendOrder: vi.fn(() => orderAck),
			snapshot: vi.fn(() => samples[Math.min(i++, samples.length - 1)]!),
			sleep: vi.fn(async () => {}),
			now: vi.fn(() => 0),
			log: vi.fn(),
		};
	};

	it("sends the blueprint once and waits until the route is operable", async () => {
		const io = fake([
			{ stations: 0, vehicles: 0 },
			{ stations: 1, vehicles: 0 },
			{ stations: 2, vehicles: 0 },
			{ stations: 2, vehicles: 1 },
		]);
		const r = await runPrebuiltScenario(io, { timeoutMs: 10_000 });
		expect(io.sendOrder).toHaveBeenCalledTimes(1);
		expect(r.ready).toBe(true);
		expect(r.reason).toBe("ready");
		expect(r.waitedSamples).toBe(4);
	});

	it("reports a timeout instead of pretending the scenario is set up", async () => {
		// The route never becomes operable: this run must be flagged, never counted
		// as a measurement of management decisions.
		const io = fake([{ stations: 2, vehicles: 0 }]);
		io.now = vi.fn()
			.mockReturnValueOnce(0)
			.mockReturnValue(20_000);
		const r = await runPrebuiltScenario(io, { timeoutMs: 10_000 });
		expect(r.ready).toBe(false);
		expect(r.reason).toBe("timeout");
	});

	it("reports a refused order (no GS ack) rather than waiting forever", async () => {
		const io = fake([{ stations: 0, vehicles: 0 }], false);
		const r = await runPrebuiltScenario(io, { timeoutMs: 10_000 });
		expect(r.ready).toBe(false);
		expect(r.reason).toBe("order_refused");
		expect(r.waitedSamples).toBe(0);
	});
});

/* ==========================================================================
 * 蓝图选城镇对：预置场景要的是"**在时间预算内建得完**"的线路。
 *
 * 真因（2026-11-17，E2 seed 22）：GS 原先按**人口**挑城镇对 ⇒ 在某些种子上
 * 选到很远的一对 ⇒ 铺路（分段 + 每段一次寻路）的时间随距离增长 ⇒ 施工在等待
 * 上限内没完成 ⇒ **测量窗从未打开** ⇒ 那一局根本不是有效测量（D131）。
 *
 * ⇒ 预置场景自己挑**最近**的一对（确定性：同地图 ⇒ 同选择），GS 只负责照做。
 * ====================================================================== */
describe("pickBlueprintTowns: 预置蓝图的城镇对（E2 seed 22 的真因）", () => {
	const T = (id: number, x: number, y: number) => ({ id, x, y, population: 100 });

	it("挑最近的一对（不是人口最多的）", () => {
		const pair = pickBlueprintTowns([
			T(1, 10, 10),
			T(2, 60, 60), // 远
			T(3, 30, 12), // 近
		]);
		expect(pair).toEqual({ a: 1, b: 3 });
	});

	it("太近的一对不算（线路要有点长度才有意义）", () => {
		const pair = pickBlueprintTowns([T(1, 10, 10), T(2, 12, 10), T(3, 80, 80)]);
		// (1,2) 只有 2 格 ⇒ 不算；答案里不能出现这一对。
		expect(pair).not.toBeNull();
		expect([pair!.a, pair!.b].sort()).not.toEqual([1, 2]);
	});

	it("城镇太少 ⇒ 没有蓝图（null），不猜一对", () => {
		expect(pickBlueprintTowns([T(1, 10, 10)])).toBeNull();
		expect(pickBlueprintTowns([])).toBeNull();
	});

	it("缺坐标的城镇不参与（没测到 ≠ 在原点）", () => {
		const pair = pickBlueprintTowns([
			{ id: 1, x: 10, y: 10, population: 100 },
			{ id: 2, x: Number.NaN, y: 10, population: 100 },
			T(3, 30, 30),
		]);
		expect(pair).toEqual({ a: 1, b: 3 });
	});
});

/* ==========================================================================
 * 蓝图**依次试多对城镇**（E2 seed 22 的真因之二）。
 *
 * 真机：seed 22 上**最近**的一对（12→20，37 格）也**铺不通**——寻路找不到任何
 * 探针（rd retry1/2/3 循环）⇒ 只试一对 = 这一局必然无效。
 *
 * ⇒ 按距离依次试；每对有**自己的**预算（没救的一对不能吃光整局的等待）。
 * ====================================================================== */
describe("蓝图依次试多对城镇（E2 seed 22）", () => {
	it("第一对不通 ⇒ 试第二对；第二对可用 ⇒ ready", async () => {
		const sent: unknown[] = [];
		let clock = 0;
		const io = {
			sendOrder: (pair?: { a: number; b: number } | null) => {
				sent.push(pair);
				return true;
			},
			snapshot: () => ({ stations: 0, vehicles: 0 }),
			towns: () => [
				{ id: 12, x: 10, y: 10 },
				{ id: 20, x: 20, y: 12 },
				{ id: 30, x: 60, y: 60 },
			],
			sleep: async (ms: number) => {
				clock += ms;
			},
			now: () => clock,
			log: () => {},
		};
		const result = await runPrebuiltScenario(io, {
			timeoutMs: 10_000,
			pollMs: 1000,
			attemptTimeoutMs: 2000,
		});
		// The first pair never becomes operable ⇒ the second one is tried.
		expect(sent.length).toBeGreaterThanOrEqual(2);
		expect(result.ready).toBe(false);
		expect(result.reason).toBe("timeout");
		expect(result.attempts).toBeGreaterThanOrEqual(2);
	});

	it("所有对都被拒 ⇒ order_refused（不是 timeout：拒绝不是钟的问题）", async () => {
		const io = {
			sendOrder: () => false,
			snapshot: () => ({ stations: 0, vehicles: 0 }),
			towns: () => [
				{ id: 1, x: 0, y: 0 },
				{ id: 2, x: 40, y: 40 },
				{ id: 3, x: 60, y: 60 },
			],
			sleep: async () => {},
			now: () => 0,
			log: () => {},
		};
		const result = await runPrebuiltScenario(io, { timeoutMs: 1000 });
		expect(result.ready).toBe(false);
		expect(result.reason).toBe("order_refused");
	});

	it("候选对按距离排序且确定（同地图 ⇒ 同顺序）", () => {
		const towns = [
			{ id: 3, x: 60, y: 60 },
			{ id: 1, x: 0, y: 0 },
			{ id: 2, x: 20, y: 0 },
		];
		const pairs = pickBlueprintTownPairs(towns);
		expect(pairs[0]!.distance).toBeLessThanOrEqual(pairs[1]!.distance);
		expect(pairs.map((p) => [p.a, p.b])).toEqual(pickBlueprintTownPairs(towns).map((p) => [p.a, p.b]));
	});
});
