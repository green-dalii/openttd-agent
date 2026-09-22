/**
 * The wire snapshot sent to the dashboard — the single source of truth.
 *
 * 职责: 把 `WorldState` 转成前端消费的 plain-object 形状（Map → object，
 *   BigInt 保留给 JSON 层处理），并**包含现金曲线 `history`**。
 *
 * 为什么集中在这里（2026-09-11，真实 bug）: 这段逻辑曾在 `agent/runner.ts` 与
 *   `game/runner.ts` 里**各有一份**，随后漂移：`game/runner.ts` 带上了 `history`，
 *   `agent/runner.ts` 没有。后果是 `--agent` / `--serve`（主用法）下
 *   **现金曲线永远是空的**，而 watch 模式看起来正常 —— 很容易被误判为"数据还没攒够"。
 *   两份实现是根因，所以现在只留一份；`test/unit/wire-snapshot.test.ts` 锁住它。
 *
 * 事实来源: docs/DASHBOARD-API.md §4（WS `snapshot` 帧形状）。
 * 禁止:
 *   - 在 runner 里再复制一份实现（本文件存在的唯一理由就是消除那个重复）。
 *   - 在这里做 IO/网络（纯转换，便于单测）。
 */

import type { WorldState } from "./world-state.js";

/** How many curve points a single frame may carry (~1h at a 5s poll). */
export const MAX_WIRE_HISTORY = 400;

/** How many recent events a single frame may carry. */
export const MAX_WIRE_RECENT = 100;

/**
 * Convert the world into the JSON-friendly shape the dashboard expects.
 *
 * `history` is deliberately included: the server owns the curve so that a page
 * refresh does not blank the chart. Omitting it is exactly the bug this file
 * was created to fix.
 */
export interface WireSnapshotExtras {
	/** 线路事实（只有 agent 模式有 GS 通道；watch 模式为空）。 */
	routes?: unknown[];
	/**
	 * 线路数据是否**可得**。
	 *
	 * 为什么必须有这个标志（2026-09-23 真机）：watch 模式没有 GS 通道，线路列表
	 * 天然为空。若只发 `routes: []`，页面会把"没有数据源"渲染成"这个公司一条线路都没有"
	 * ——那是编造事实。**"不可用"与"零"是两种世界状态。**
	 */
	routesAvailable?: boolean;
}

export function toWireSnapshot(world: WorldState, extras: WireSnapshotExtras = {}): unknown {
	const snap = world.snapshot();
	const companies: Record<string, unknown> = {};
	for (const [id, cs] of snap.companies) {
		companies[String(id)] = {
			info: cs.info,
			economy: cs.economy,
			stats: cs.stats,
			// Server-owned curve so a refresh does not blank the chart.
			history: cs.history.slice(-MAX_WIRE_HISTORY),
		};
	}
	return {
		date: snap.date,
		companies,
		totalEvents: snap.totalEvents,
		recent: snap.recent.slice(-MAX_WIRE_RECENT),
		routes: extras.routes ?? [],
		routesAvailable: extras.routesAvailable === true,
	};
}
