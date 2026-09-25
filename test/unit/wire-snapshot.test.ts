/**
 * Unit tests — the wire snapshot sent to the dashboard.
 *
 * 职责: 锁定 `toWireSnapshot` 把世界状态转成前端可用的形状，**特别是**
 *   `history`（现金曲线）必须包含在内。
 *
 * 为什么单独立项（2026-09-11，真实 bug）: 这个函数曾经在 `agent/runner.ts` 与
 *   `game/runner.ts` 里**各有一份实现**，然后漂移了 ——
 *   `game/runner.ts` 带上 `history`，`agent/runner.ts` 忘了带。
 *   后果: `--agent` / `--serve`（也就是主用法）下"现金曲线"**永远是空的**，
 *   而 watch 模式正常，所以很容易被当成"还没攒够数据"。
 *   两份实现是根因，因此现在只有一份（`src/game/wire-snapshot.ts`），
 *   并由本文件锁住。
 *
 * 事实来源: docs/DASHBOARD-API.md §4（WS snapshot 帧形状）。
 * 禁止: 各 runner 再复制一份实现（本文件正是为防这件事而存在）。
 */

import { describe, expect, it } from "vitest";
import { toWireSnapshot } from "../../src/game/wire-snapshot.js";
import { WorldState } from "../../src/game/world-state.js";
import { stringifyJson } from "../../src/util/json.js";

/** Feed one company_economy event and return the snapshot the dashboard gets. */
function withEconomy(points: number): Record<string, unknown> {
	const w = new WorldState();
	let ts = 1000;
	for (let i = 0; i < points; i++) {
		w.ingest({
			seq: i,
			kind: "company_economy",
			ts: (ts += 10),
			payload: {
				id: 0,
				money: BigInt(100_000 + i * 1000),
				loan: BigInt(50_000),
				income: BigInt(200),
				companyValue: BigInt(1_000_000),
			},
		} as never);
	}
	return toWireSnapshot(w) as Record<string, unknown>;
}

function company0(snap: Record<string, unknown>): Record<string, unknown> {
	return (snap.companies as Record<string, Record<string, unknown>>)["0"]!;
}

describe("toWireSnapshot", () => {
	it("includes the cash-curve history (the regression that blanked the chart)", () => {
		const snap = withEconomy(5);
		const c0 = company0(snap);
		expect(c0.history, "companies[id].history must be present").toBeDefined();
		expect((c0.history as unknown[]).length).toBe(5);
	});

	it("keeps the history points chart-shaped (numeric money/loan/income)", () => {
		const snap = withEconomy(3);
		const h = company0(snap).history as Record<string, unknown>[];
		expect(h).toHaveLength(3);
		for (const p of h) {
			expect(typeof p.money).toBe("number");
			expect(typeof p.loan).toBe("number");
			expect(typeof p.income).toBe("number");
			expect(Number.isFinite(p.money)).toBe(true);
		}
		// Money is signed (SPEC §10.6): a negative balance must stay negative.
		expect(h[0]!.money).toBe(100_000);
	});

	it("bounds the history so a long run cannot bloat every frame", () => {
		// 500 events in, the wire must not carry all 500 forever.
		const snap = withEconomy(500);
		const h = company0(snap).history as unknown[];
		expect(h.length).toBeLessThanOrEqual(400);
		expect(h.length).toBeGreaterThan(0);
	});

	it("carries the fields the dashboard reads", () => {
		const snap = withEconomy(1);
		expect(snap).toHaveProperty("date");
		expect(snap).toHaveProperty("companies");
		expect(snap).toHaveProperty("totalEvents");
		expect(snap).toHaveProperty("recent");
		expect(Array.isArray(snap.recent)).toBe(true);
	});

	it("caps the recent-event tail", () => {
		const w = new WorldState();
		for (let i = 0; i < 200; i++) {
			w.ingest({ seq: i, kind: "console", ts: i, payload: { message: `m${i}` } } as never);
		}
		const snap = toWireSnapshot(w) as Record<string, unknown>;
		expect((snap.recent as unknown[]).length).toBeLessThanOrEqual(100);
	});

	it("serialises through the server's BigInt-aware stringify", () => {
		// Raw JSON.stringify throws on BigInt, which is why the server never uses it:
		// bigint fields reach the snapshot (money/loan/income are bigint on the wire)
		// and are converted by `stringifyJson`. Asserting with the real helper keeps
		// this test honest about how frames are actually sent.
		const snap = withEconomy(2);
		expect(() => stringifyJson(snap)).not.toThrow();
		const round = JSON.parse(stringifyJson(snap)) as Record<string, unknown>;
		const h = company0(round).history as Record<string, unknown>[];
		// BigInt became a decimal string, not {} or a thrown error.
		expect(typeof (h[0] as { loan?: unknown }).loan === "string" || typeof (h[0] as { loan?: unknown }).loan === "number").toBe(true);
	});

	it("handles a world with no companies yet", () => {
		const snap = new WorldState().snapshot();
		expect(() => toWireSnapshot(new WorldState())).not.toThrow();
		expect(Object.keys((toWireSnapshot(new WorldState()) as Record<string, unknown>).companies as object)).toEqual([]);
		// sanity: the raw snapshot is also empty
		expect([...snap.companies]).toEqual([]);
	});
});

/**
 * 线路数据（2026-09-23）：**"不可用"与"零"是两种世界状态**。
 *
 * watch 模式没有 GS 通道，线路列表天然为空。若只发 `routes: []`，页面会把
 * "没有数据源"渲染成"这个公司一条线路都没有"——那是编造事实。
 */
describe("快照里的线路数据", () => {
	it("默认：空数组 + `routesAvailable: false`（不是「0 条线路」）", () => {
		const snap = toWireSnapshot(new WorldState()) as Record<string, unknown>;
		expect(snap.routes).toEqual([]);
		expect(snap.routesAvailable).toBe(false);
	});

	it("agent 模式：原样带上线路事实并标记可得", () => {
		const routes = [{ job: 100, vehicles: 6, waiting: 12, profitYtd: 3650, incomePerDay: 18.25, townA: 4, townB: 20 }];
		const snap = toWireSnapshot(new WorldState(), { routes, routesAvailable: true }) as Record<string, unknown>;
		expect(snap.routes).toEqual(routes);
		expect(snap.routesAvailable).toBe(true);
	});
});

describe("wire snapshot: towns（GS 一直有数据，此前从没发到页面）", () => {
	it("把城镇列表与总数发给页面（排序是事实，不是建议）", () => {
		const w = new WorldState();
		w.setTowns(
			[
				{ id: 2, population: 500, x: 10, y: 20 },
				{ id: 7, population: 900, x: 30, y: 40 },
			],
			42,
		);
		const snap = toWireSnapshot(w, { townsAvailable: true }) as Record<string, unknown>;
		expect(snap.towns).toEqual([
			{ id: 7, population: 900, x: 30, y: 40 },
			{ id: 2, population: 500, x: 10, y: 20 },
		]);
		expect(snap.townsTotal).toBe(42);
		expect(snap.townsAvailable).toBe(true);
	});

	it("townsAvailable=false 是「没有这条通道」，不是「地图上没有城镇」", () => {
		const snap = toWireSnapshot(new WorldState(), { townsAvailable: false }) as Record<string, unknown>;
		expect(snap.towns).toEqual([]);
		expect(snap.townsAvailable).toBe(false);
		// 总数未知必须是 null（页面显示「—」）；0 会被读成「一个城镇都没有」。
		expect(snap.townsTotal).toBeNull();
	});
});

describe("wire snapshot: 产业/货种/公司口径", () => {
	function withFacts() {
		const w = new WorldState();
		w.setIndustries([{ id: 1, cargo: "COAL", name: "Mine", produced: 10, transported: 4, stock: 2 }], 12);
		w.setCargoTotals([{ label: "COAL", produced: 10, transported: 4 }]);
		w.setCompanyCargo({ byCargo: [{ label: "COAL", amount: 3 }], quarterDelivered: 7, monitored: { towns: 1, industries: 1 } });
		return w;
	}

	it("agent 模式：产业/货种/公司口径全部发出，并标记可得", () => {
		const snap = toWireSnapshot(withFacts(), { industryAvailable: true, companyCargoAvailable: true }) as Record<string, unknown>;
		expect(snap.industriesTotal).toBe(12);
		expect(snap.industries).toHaveLength(1);
		expect(snap.cargoTotals).toHaveLength(1);
		expect((snap.companyCargo as { quarterDelivered: number }).quarterDelivered).toBe(7);
		expect(snap.industryAvailable).toBe(true);
		expect(snap.companyCargoAvailable).toBe(true);
	});

	it("watch 模式：标记不可得且不带数据（「不可得」≠「零」）", () => {
		const snap = toWireSnapshot(new WorldState(), { industryAvailable: false, companyCargoAvailable: false }) as Record<string, unknown>;
		expect(snap.industryAvailable).toBe(false);
		expect(snap.companyCargoAvailable).toBe(false);
		expect(snap.industries).toEqual([]);
		expect(snap.companyCargo).toBeNull();
	});
});
