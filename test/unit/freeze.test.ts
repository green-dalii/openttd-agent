import { describe, expect, it, vi } from "vitest";
import { makeFreezeController } from "../../src/agent/freeze.js";

/**
 * 已验证的冻结（2026-09-17，SPEC §10.59）。
 *
 * 背景：原设计在决策期间暂停世界（SPEC §1.1 step 2），2026-09-12 因"暂停不可恢复"
 * 废除；§10.59 实测推翻该归因（pause/unpause 双向有效），于是冻结重新成为选项——
 * 但这次必须**可观测、可兜底**：
 *   1. 暂停/恢复都要回执确认（无回执 = 明说没冻住，而不是假装冻住）；
 *   2. 任何异常路径都必须在 finally 里恢复（§10.26 的教训：unpause 不在 finally
 *      → 游戏永久冻结）；
 *   3. 看门狗：持有超时强制恢复（一次卡死的决策不能永久冻住游戏）。
 */
describe("freeze 控制器", () => {
	const mk = (over: Partial<Parameters<typeof makeFreezeController>[0]> = {}) => {
		const calls: string[] = [];
		const logs: string[] = [];
		const ctrl = makeFreezeController({
			pause: async () => {
				calls.push("pause");
				return "Game paused";
			},
			unpause: async () => {
				calls.push("unpause");
				return "Game unpaused";
			},
			now: () => 1000,
			log: (m) => logs.push(m),
			...over,
		});
		return { ctrl, calls, logs };
	};

	it("acquire 暂停并持有；release 恢复", async () => {
		const { ctrl, calls } = mk();
		const lease = await ctrl.acquire("decision");
		expect(calls).toEqual(["pause"]);
		expect(ctrl.isHeld()).toBe(true);
		await lease!.release();
		expect(calls).toEqual(["pause", "unpause"]);
		expect(ctrl.isHeld()).toBe(false);
	});

	it("暂停无回执 → 不持有并如实告警（不假装冻住了）", async () => {
		const { ctrl, logs } = mk({ pause: async () => null });
		const lease = await ctrl.acquire("decision");
		expect(lease).toBeNull();
		expect(ctrl.isHeld()).toBe(false);
		expect(logs.join(" ")).toMatch(/confir|ack|reply/i);
	});

	it("恢复失败 → 重试一次并计数（恢复比暂停更重要）", async () => {
		let n = 0;
		const { ctrl } = mk({
			unpause: async () => {
				n++;
				return n === 1 ? null : "Game unpaused";
			},
		});
		const lease = await ctrl.acquire("decision");
		await lease!.release();
		expect(n).toBe(2);
		expect(ctrl.stats().unpauseFailures).toBe(0); // 重试成功 → 不算失败
	});

	it("恢复连续失败 → 计数并告警（这是会永久冻结游戏的路径）", async () => {
		const { ctrl, logs } = mk({ unpause: async () => null });
		const lease = await ctrl.acquire("decision");
		await lease!.release();
		expect(ctrl.stats().unpauseFailures).toBe(1);
		expect(logs.join(" ")).toMatch(/unpause|resume|frozen/i);
	});

	it("重复 acquire 不重复暂停（嵌套安全）", async () => {
		const { ctrl, calls } = mk();
		const a = await ctrl.acquire("decision");
		const b = await ctrl.acquire("nested");
		expect(b).toBeNull();
		await a!.release();
		expect(calls.filter((c) => c === "pause")).toHaveLength(1);
	});

	it("重复 release 只恢复一次（幂等）", async () => {
		const { ctrl, calls } = mk();
		const lease = await ctrl.acquire("decision");
		await lease!.release();
		await lease!.release();
		expect(calls.filter((c) => c === "unpause")).toHaveLength(1);
	});

	it("看门狗：持有超时强制恢复（一次卡死的决策不能永久冻住游戏）", async () => {
		vi.useFakeTimers();
		try {
			const { ctrl, calls, logs } = mk({ maxHoldMs: 5_000 });
			await ctrl.acquire("decision");
			await vi.advanceTimersByTimeAsync(5_100);
			expect(calls).toContain("unpause");
			expect(ctrl.isHeld()).toBe(false);
			expect(ctrl.stats().watchdogTrips).toBe(1);
			expect(logs.join(" ")).toMatch(/watchdog|timeout/i);
		} finally {
			vi.useRealTimers();
		}
	});

	it("stats 记录获取次数与最长持有（A/B 报告要看它是否真的冻住了）", async () => {
		let t = 0;
		const { ctrl } = mk({ now: () => t });
		const a = await ctrl.acquire("d1");
		t = 2500;
		await a!.release();
		const b = await ctrl.acquire("d2");
		t = 3500;
		await b!.release();
		expect(ctrl.stats().acquisitions).toBe(2);
		expect(ctrl.stats().maxHoldMs).toBe(2500);
	});

	it("确认冻结成功才计入 acquisitions 的'已确认'计数", async () => {
		const { ctrl } = mk({ pause: async () => null });
		await ctrl.acquire("decision");
		expect(ctrl.stats().acquireUnconfirmed).toBe(1);
	});
});
