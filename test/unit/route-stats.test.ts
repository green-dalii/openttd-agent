import { describe, expect, it } from "vitest";
import { incomePerDay, formatRouteStats, joinRoutesWithLedger } from "../../src/agent/route-stats.js";

/**
 * NEXT-2 N2-1：线路经济（纯函数部分）。
 *
 * 设计要点：GS 只发**原始事实**（当年累计利润 + 游戏日期），派生的"每日收益"
 * 在 harness 侧用可单测的纯函数算——Squirrel 侧不留算术（SPEC §10.45：
 * GS 嵌套表/算术怪癖已经浪费过一整轮）。
 */
describe("incomePerDay —— 当年累计利润 → 每日收益", () => {
	it("年内第 N 天：利润 / N（+1 避免除零）", () => {
		// OpenTTD 日期 0 = 第 1 年 1 月 1 日；day-of-year = date % 365
		expect(incomePerDay(1000, 364)).toBeCloseTo(1000 / 364, 6);
		expect(incomePerDay(3650, 0)).toBe(3650); // 年中第 0 天按 1 天算
	});

	it("负利润（亏钱线路）如实为负——不许取绝对值掩盖", () => {
		expect(incomePerDay(-730, 364)).toBeLessThan(0);
	});

	it("非数输入 → null（哨兵/NaN 不许混进派生量）", () => {
		expect(incomePerDay(Number.NaN, 200)).toBeNull();
	});

	it("没有车辆 → income 不可知，不编造 0（0 会被读成'这条线不赚钱'）", () => {
		const line = formatRouteStats({ job: 9, vehicles: 0, profit: 0, waiting: 3, gameDate: 200 });
		expect(line).toContain("no vehicles"); // 原因必须写对，不能拿"年份太新"搪塞
		expect(line).not.toContain("income 0/day");
	});

	it("年初样本不足（<30 天）→ 不给每日速率：1 天样本不能当年化", () => {
		const line = formatRouteStats({ job: 9, vehicles: 6, profit: 3650, waiting: 3, gameDate: 365 });
		expect(line).not.toMatch(/income 3650\/day/);
		expect(line).toMatch(/not meaningful yet/);
		expect(line).toContain("3650"); // 原始事实仍然照实给出
	});
});

describe("formatRouteStats —— 注入/工具文本只陈述事实", () => {
	const stats = { job: 101, vehicles: 2, profit: 5000, waiting: 7, gameDate: 364 };

	it("包含 job/车辆数/等待/每日收益", () => {
		const s = formatRouteStats(stats);
		expect(s).toContain("101");
		expect(s).toMatch(/2 (vehicles?|buses)/);
		expect(s).toMatch(/waiting 7/);
		expect(s).toMatch(/5000/);
	});

	it("不含任何建议词（harness 给事实，不给策略）", () => {
		const s = formatRouteStats(stats).toLowerCase();
		for (const w of ["should", "recommend", "better", "add ", "buy ", "increase", "optimal", "must", "advise"]) {
			expect(s).not.toContain(w);
		}
	});
});

describe("joinRoutesWithLedger —— hub 读数 × 账本 pair（N2-2b）", () => {
	const stats = [
		{ job: 101, vehicles: 6, profit: -308, waiting: 146, gameDate: 400 },
		{ job: 999, vehicles: 1, profit: 0, waiting: 0, gameDate: 400 },
	];
	const ledger = [
		{ order: { job: 101, fromTown: 9, toTown: 12, decision: 1, orderedAt: 1 }, outcome: { completed: false } },
	];

	it("账本知道 pair 就带上；不知道就不编（只给 job）", () => {
		const joined = joinRoutesWithLedger(stats, ledger);
		expect(joined.find((r) => r.job === 101)).toMatchObject({ townA: 9, townB: 12, vehicles: 6, waiting: 146 });
		const orphan = joined.find((r) => r.job === 999)!;
		expect(orphan.townA).toBeUndefined();
		expect(orphan.vehicles).toBe(1);
	});

	it("按 job 排序（模型看到稳定的顺序）", () => {
		expect(joinRoutesWithLedger(stats, ledger).map((r) => r.job)).toEqual([101, 999]);
	});
});

describe("小额速率不被四舍五入成 0（符号是事实）", () => {
	it("-6/208 ≈ -0.03 → 显示 -0.03/day，而不是 0/day", () => {
		const line = formatRouteStats({ job: 1, vehicles: 6, profit: -6, waiting: 0, gameDate: 208 });
		expect(line).toContain("-0.03/day");
		expect(line).not.toContain("income 0/day");
	});
});
