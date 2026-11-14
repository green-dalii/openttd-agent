/**
 * 公司级运营利润台账（Phase D）的单测。
 *
 * 守住的五件事:
 *   ① 读数**连续**: 同一辆车两次读数之间的增量要算进去（不是只看最后一条）。
 *   ② **第一条读数只建基线**: 从存档起步的局里，车带着上一段历史的利润 ⇒ 不算本局的。
 *   ③ **卖车不得清零**: 车消失时它本局的利润留在账上。
 *   ④ **跨年不是亏损**: 引擎 1 月 1 日把当年利润清零 ⇒ 读数掉下去不能当成亏损。
 *   ⑤ **没测到 ≠ 0**: 一条读数都没有时是 null；不完整时明说"是下界"。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
	createOperatingProfitLedger,
	operatingProfitPerGameDay,
	type FleetReading,
} from "../../src/game/operating-profit.js";
import { rawToYmd } from "../../src/game/calendar.js";
import { toGameMetric } from "../../src/evolution/metrics.js";
import { pairedMetric } from "../../src/evolution/bench-stats.js";

/**
 * 引擎 raw 日期（1920-01-01 起的天数）。
 *
 * 引擎的**显示年**（1950）与 `calendar.ts` 的**日历年**（0 = 1920）差 1920
 * （`rawToYmd` 的年是从 0 起的）⇒ 这里换算一次，免得测试里写死两套年号。
 */
function dateOf(displayYear: number, dayOfYear: number): number {
	const calYear = displayYear - 1920;
	for (let d = 0; d < 400 * 366; d++) {
		if (rawToYmd(d).year === calYear) return d + (dayOfYear - 1);
	}
	throw new Error("date out of range");
}

function reading(rawDate: number, vehicles: { id: number; profit: number }[]): FleetReading {
	return { rawDate, vehicles };
}

describe("公司级运营利润：台账", () => {
	it("一条读数都没有 ⇒ null（不是 0）", () => {
		const l = createOperatingProfitLedger();
		const r = l.reading();
		expect(r.operatingProfit).toBeNull();
		expect(r.readings).toBe(0);
	});

	it("新买的车：它的读数**全额计入**（它存在期间攒下的）", () => {
		const l = createOperatingProfitLedger();
		l.observe(reading(dateOf(1950, 10), []));
		l.observe(reading(dateOf(1950, 20), [{ id: 8, profit: 1000 }]));
		const r = l.reading();
		expect(r.operatingProfit).toBe(1000);
		expect(r.vehicles).toBe(1);
		expect(r.retired).toBe(0);
		expect(r.complete).toBe(true);
	});

	it("第二次读数只算**增量**（不重复计入）", () => {
		const l = createOperatingProfitLedger();
		l.observe(reading(dateOf(1950, 10), []));
		l.observe(reading(dateOf(1950, 20), [{ id: 8, profit: 1000 }]));
		l.observe(reading(dateOf(1950, 30), [{ id: 8, profit: 1400 }]));
		expect(l.reading().operatingProfit).toBe(1400);
	});

	it("运行成本会让读数**下降** ⇒ 累计值跟着降（不是只涨）", () => {
		const l = createOperatingProfitLedger();
		l.observe(reading(dateOf(1950, 10), []));
		l.observe(reading(dateOf(1950, 20), [{ id: 8, profit: 1000 }]));
		l.observe(reading(dateOf(1950, 30), [{ id: 8, profit: 800 }]));
		expect(l.reading().operatingProfit).toBe(800);
	});

	it("**卖车不得清零**：车消失时它本局的利润留在账上", () => {
		const l = createOperatingProfitLedger();
		l.observe(reading(dateOf(1950, 10), []));
		l.observe(reading(dateOf(1950, 20), [
			{ id: 8, profit: 1000 },
			{ id: 9, profit: 500 },
		]));
		l.observe(reading(dateOf(1950, 30), [{ id: 8, profit: 1400 }]));
		const r = l.reading();
		// 车 9 卖掉了：它赚的 500 留在账上；车 8 到最后一次读数共赚 1400。
		expect(r.operatingProfit).toBe(1900);
		expect(r.retired).toBe(1);
		expect(r.retiredProfit).toBe(500);
		expect(r.vehicles).toBe(1);
		// 卖车那一刻的尾巴没测到 ⇒ 累计值是**下界**。
		expect(r.complete).toBe(false);
	});

	it("从存档起步的局：车带着**上一段历史**的利润 ⇒ 不算本局的", () => {
		const l = createOperatingProfitLedger();
		// 第一条读数就是基线：这辆车在跑本局之前已经赚了 1000。
		l.observe(reading(dateOf(1950, 10), [{ id: 8, profit: 1000 }]));
		expect(l.reading().operatingProfit).toBe(0);
		// 本局里它又赚了 400。
		l.observe(reading(dateOf(1950, 20), [{ id: 8, profit: 1400 }]));
		expect(l.reading().operatingProfit).toBe(400);
	});

	it("**跨年不是亏损**：引擎 1 月 1 日清零，读数掉下去不算亏", () => {
		const l = createOperatingProfitLedger();
		l.observe(reading(dateOf(1950, 300), []));
		l.observe(reading(dateOf(1950, 320), [{ id: 8, profit: 1000 }]));
		l.observe(reading(dateOf(1950, 360), [{ id: 8, profit: 1500 }]));
		expect(l.reading().operatingProfit).toBe(1500);
		// 1951-01-01：引擎把当年利润清零，新一年的读数很小。
		l.observe(reading(dateOf(1951, 1), [{ id: 8, profit: 12 }]));
		const r = l.reading();
		expect(r.operatingProfit).toBe(1500);
		expect(r.yearFlips).toBe(1);
		// 年界前最后一段没采到 ⇒ 下界。
		expect(r.complete).toBe(false);
	});

	it("跨年后新一年的增量照算", () => {
		const l = createOperatingProfitLedger();
		l.observe(reading(dateOf(1951, 1), []));
		l.observe(reading(dateOf(1951, 2), [{ id: 8, profit: 10 }]));
		l.observe(reading(dateOf(1951, 20), [{ id: 8, profit: 60 }]));
		expect(l.reading().operatingProfit).toBe(60);
	});

	it("乱序的读数被忽略（不倒扣）", () => {
		const l = createOperatingProfitLedger();
		l.observe(reading(dateOf(1950, 20), [{ id: 8, profit: 1400 }]));
		l.observe(reading(dateOf(1950, 10), [{ id: 8, profit: 1000 }]));
		expect(l.reading().operatingProfit).toBe(0);
		expect(l.reading().readings).toBe(1);
	});
});

describe("公司级运营利润：每游戏日", () => {
	it("分子分母同源：累计利润 ÷ 这一局经过的游戏日", () => {
		expect(operatingProfitPerGameDay(1500, 100)).toBe(15);
	});

	it("没测到 ⇒ null（不是 0）", () => {
		expect(operatingProfitPerGameDay(null, 100)).toBeNull();
		expect(operatingProfitPerGameDay(1500, null)).toBeNull();
		expect(operatingProfitPerGameDay(1500, 0)).toBeNull();
	});
});

/**
 * 端到端接线：**读数从引擎一路走到度量行与 Compare 轴**。
 *
 * 为什么要有这些守卫：这个量是"算出来的"（服务端台账）⇒ 最容易出的错不是算错，
 * 而是**某一段没接上**（GS 不回、服务端不采、度量行丢掉）⇒ 数字静默变成"没测到"，
 * 而看板会照常显示"—"。这类"声明了没接线"本仓库已发生多次（D43/D44）。
 */
describe("公司级运营利润：端到端接线", () => {
	const nut = readFileSync(
		new URL("../../src/game/squirrel/bridge-gs/main.nut", import.meta.url),
		"utf8",
	);
	const runner = readFileSync(
		new URL("../../src/agent/runner.ts", import.meta.url),
		"utf8",
	);

	it("GS 有 company_fleet 分支，走 **answer** 通道（不增长周期载荷）", () => {
		expect(nut).toContain('cmd == "company_fleet"');
		const at = nut.indexOf('cmd == "company_fleet"');
		const branch = nut.slice(at, at + 1600);
		expect(branch).toContain('kind = "answer"');
		// 周期载荷不许变大 ⇒ 这个读数**不能**进状态包。
		expect(branch).not.toContain("this._pr.");
	});

	it("GS 用的是引擎真值 API（车队 / 归属 / 当年利润）", () => {
		const at = nut.indexOf('cmd == "company_fleet"');
		const branch = nut.slice(at, at + 1600);
		expect(branch).toContain("GSVehicleList()");
		expect(branch).toContain("GSVehicle.GetOwner");
		expect(branch).toContain("GSVehicle.GetProfitThisYear");
		expect(branch).toContain("GSDate.GetCurrentDate()");
	});

	it("GS 侧读不到就写 -1（没测到），不是 0", () => {
		const at = nut.indexOf('cmd == "company_fleet"');
		const branch = nut.slice(at, at + 1600);
		expect(branch).toMatch(/p\s*=\s*-1/);
	});

	it("TS 侧确实发这个命令（守卫不是空跑）", () => {
		expect(runner).toContain('cmd: "company_fleet"');
	});

	it("度量行保留运营利润（**缺读数是 null，不是 0**）", () => {
		const withReading = toGameMetric({
			id: "r1",
			mode: "agent",
			status: "completed",
			startedAt: 1,
			seed: 7,
			outcome: { operatingProfit: 1500, operatingProfitPerDay: 15, operatingProfitComplete: false },
		});
		expect(withReading.operatingProfit).toBe(1500);
		expect(withReading.operatingProfitPerDay).toBe(15);
		expect(withReading.operatingProfitComplete).toBe(false);

		const without = toGameMetric({
			id: "r2",
			mode: "agent",
			status: "completed",
			startedAt: 1,
			seed: 7,
			outcome: {},
		});
		expect(without.operatingProfit).toBeNull();
		expect(without.operatingProfitPerDay).toBeNull();
		expect(without.operatingProfitComplete).toBeNull();
	});

	it("Compare 有运营利润轴：方向是「越大越好」，没测到是 null", () => {
		const m = pairedMetric("ability.operatingProfitPerGameDay");
		expect(m.axis).toBe("ability");
		expect(m.betterWhen).toBe("higher");
		expect(m.unit).toBe("per game day");
	});
});
