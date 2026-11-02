/**
 * Unit tests — the comparison queue (Issue #48).
 *
 * 职责: 守住"一格一局、顺序跑、失败不吞、状态说真话"。
 * 关键性质:
 *   - **顺序**: 下一格必须等上一格**跑完**（一个进程只有一个游戏端口）。
 *   - **失败不吞**: 一格失败被记下来，后面的格子**继续跑**（一轮比较不能因为
 *     一个 seed 挂掉就全废），但状态里写明有几格失败。
 *   - **不并发**: 两个计划不能同时在飞。
 */

import { describe, expect, it } from "vitest";
import { PlanQueue, type PlanQueueState } from "../../src/agent/plan-queue.js";
import type { ComparePlanCell } from "../../src/agent/compare-plan.js";

const CELLS: ComparePlanCell[] = [
	{ model: "a", seed: 1 },
	{ model: "a", seed: 2 },
	{ model: "b", seed: 1 },
];

describe("plan queue", () => {
	it("runs the cells one after another, in order", async () => {
		const order: string[] = [];
		let concurrent = 0;
		let maxConcurrent = 0;
		const queue = new PlanQueue({});
		queue.start(CELLS, async (cell) => {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			order.push(`${cell.model}:${cell.seed}`);
			await new Promise((r) => setTimeout(r, 5));
			concurrent -= 1;
		});
		await queue.waitForIdle();
		expect(order).toEqual(["a:1", "a:2", "b:1"]);
		expect(maxConcurrent).toBe(1);
		expect(queue.getState().status).toBe("done");
		expect(queue.getState().completed).toBe(3);
		expect(queue.getState().failed).toBe(0);
	});

	it("records a failed cell and keeps going", async () => {
		const queue = new PlanQueue({});
		const ran: string[] = [];
		queue.start(CELLS, async (cell) => {
			ran.push(`${cell.model}:${cell.seed}`);
			if (cell.seed === 2) throw new Error("preflight refused to start");
		});
		await queue.waitForIdle();
		const state = queue.getState();
		expect(ran).toEqual(["a:1", "a:2", "b:1"]);
		expect(state.failed).toBe(1);
		expect(state.status).toBe("failed");
		const failed = state.cells.find((c) => c.seed === 2);
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toContain("preflight refused");
		expect(state.cells.find((c) => c.seed === 1 && c.model === "a")?.status).toBe("done");
	});

	it("refuses a second plan while one is in flight", async () => {
		const queue = new PlanQueue({});
		queue.start(CELLS, async () => {
			await new Promise((r) => setTimeout(r, 20));
		});
		expect(queue.isBusy()).toBe(true);
		expect(() => queue.start(CELLS, async () => {})).toThrow(/already running/);
		await queue.waitForIdle();
		expect(queue.isBusy()).toBe(false);
	});

	it("reports the cell it is running right now", async () => {
		const states: PlanQueueState[] = [];
		const queue = new PlanQueue({ onChange: (s) => states.push(s) });
		const seen: ComparePlanCell[] = [];
		queue.start(CELLS, async (cell) => {
			seen.push(cell);
			await new Promise((r) => setTimeout(r, 5));
		});
		await queue.waitForIdle();
		expect(seen[0]).toEqual({ model: "a", seed: 1 });
		expect(states.some((s) => s.current?.model === "a" && s.current?.seed === 1)).toBe(true);
		expect(states[states.length - 1]?.current).toBeNull();
	});

	it("skips the remaining cells when the plan is cancelled", async () => {
		const queue = new PlanQueue({});
		const ran: string[] = [];
		queue.start(CELLS, async (cell) => {
			ran.push(`${cell.model}:${cell.seed}`);
			queue.cancel();
		});
		await queue.waitForIdle();
		expect(ran).toEqual(["a:1"]);
		expect(queue.getState().cells.filter((c) => c.status === "skipped").length).toBe(2);
	});
});
