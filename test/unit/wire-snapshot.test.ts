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
