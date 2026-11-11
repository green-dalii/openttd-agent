/**
 * Unit tests — the profit reading meter (Issue #104 P0b).
 *
 * 职责: 锁定"收益读数"的语义：
 *   - `money − loan` 就是本局自创建以来的净现金流（跨 1 月 1 日成立）；
 *   - 引擎在 1 月 1 日**先**发年度读数（携带上一整年的完整值）、**之后**才清零
 *     ⇒ 那一条读数用来**分段 + 对账**；
 *   - 对不上（漏读/缺口/边界读数丢失）必须**报出差值**，不能悄悄变成 0；
 *   - 缺读数 ⇒ `null`，绝不折零（MEMORY D60）。
 * 纯测试：手写的引擎读数（money/loan/income 都是引擎口径的真值）。
 */

import { describe, expect, it } from "vitest";
import { createProfitMeter, profitPerGameDay, type EconomyReading } from "../../src/game/profit-meter.js";
import { ymdToRaw } from "../../src/game/calendar.js";

/** 1950-01-01 = raw 712223（live capture 的锚点）。 */
const RAW_1950_01_01 = 712223;
const raw = (y: number, m: number, d: number): number => ymdToRaw(y, m, d);

function reading(r: EconomyReading): EconomyReading {
	return r;
}

describe("profit meter — 净现金流", () => {
	it("没测到就是 null（不是 0）", () => {
		const m = createProfitMeter();
		const r = m.reading();
		expect(r.netCashFlow).toBeNull();
		expect(r.readings).toBe(0);
		expect(r.firstRawDate).toBeNull();
		expect(r.lastRawDate).toBeNull();
		expect(r.years).toEqual([]);
		expect(r.reconciled).toBe(false);
	});

	it("单条读数：money − loan 就是自创建以来的净现金流", () => {
		const m = createProfitMeter();
		m.observe(reading({ rawDate: RAW_1950_01_01, money: 120_000n, loan: 50_000n, income: 0n }));
		const r = m.reading();
		expect(r.netCashFlow).toBe(70_000);
		expect(r.readings).toBe(1);
		expect(r.firstRawDate).toBe(RAW_1950_01_01);
	});

	it("借钱不改变净现金流（money 与 current_loan 同增同减）", () => {
		const m = createProfitMeter();
		m.observe(reading({ rawDate: RAW_1950_01_01, money: 100_000n, loan: 50_000n, income: 0n }));
		// 借 20,000：money 与 loan 同时 +20,000 ⇒ 净额不变。
		m.observe(reading({ rawDate: RAW_1950_01_01 + 10, money: 120_000n, loan: 70_000n, income: 0n }));
		expect(m.reading().netCashFlow).toBe(50_000);
	});

	it("同一年的多条读数：净额跟着 money − loan 走", () => {
		const m = createProfitMeter();
		m.observe(reading({ rawDate: RAW_1950_01_01, money: 100_000n, loan: 50_000n, income: 0n }));
		m.observe(reading({ rawDate: RAW_1950_01_01 + 30, money: 90_000n, loan: 50_000n, income: -10_000n }));
		m.observe(reading({ rawDate: RAW_1950_01_01 + 60, money: 130_000n, loan: 50_000n, income: 30_000n }));
		const r = m.reading();
		expect(r.netCashFlow).toBe(80_000);
		expect(r.years).toHaveLength(1);
		expect(r.years[0]!.year).toBe(1950);
		expect(r.years[0]!.net).toBe(80_000);
		// 这一段还没结束 ⇒ 没有引擎自报的完整年值 ⇒ 没核对过。
		expect(r.years[0]!.close).toBeNull();
		expect(r.years[0]!.verified).toBe(false);
		expect(r.reconciled).toBe(false);
	});

	it("乱序的读数被忽略（引擎的读数按时间递增）", () => {
		const m = createProfitMeter();
		m.observe(reading({ rawDate: RAW_1950_01_01 + 10, money: 100_000n, loan: 50_000n, income: 0n }));
		m.observe(reading({ rawDate: RAW_1950_01_01, money: 999_999n, loan: 0n, income: 0n }));
		const r = m.reading();
		expect(r.readings).toBe(1);
		expect(r.netCashFlow).toBe(50_000);
	});
});

describe("profit meter — 跨年分段与对账", () => {
	/**
	 * 一局跑过 1 月 1 日。真实序列长这样（引擎口径）：
	 *   - 计数器 `income` 是**当年迄今**，跨年时归零；
	 *   - 引擎在 1 月 1 日**先**发读数（携带上一整年的完整值）、**之后**才清零
	 *     ⇒ 那条读数是"边界读数"，下一条读数的计数器已经归零 ⇒ 恒等式在这里断开。
	 *   - 钱（`money − loan`）是连续的 ⇒ 边界读数既是上一段的终点，也是下一段的起点。
	 */
	it("边界读数闭合上一年，并与 money 口径对上", () => {
		const m = createProfitMeter();
		// 1950-01-01：创建公司（money == current_loan ⇒ 净额 0，计数器 0）。
		m.observe(reading({ rawDate: raw(1950, 1, 1), money: 50_000n, loan: 50_000n, income: 0n }));
		// 1950-06-01：赚了 40,000（净额 40,000，计数器 40,000）。
		m.observe(reading({ rawDate: raw(1950, 6, 1), money: 90_000n, loan: 50_000n, income: 40_000n }));
		// 1951-01-01 的**边界读数**（引擎先发、之后才清零）：携带上一整年的完整值 40,000。
		m.observe(reading({ rawDate: raw(1951, 1, 1), money: 90_000n, loan: 50_000n, income: 40_000n }));
		// 清零之后的读数：计数器从头开始，钱几乎没动 ⇒ 恒等式在这里断开 = 年翻转。
		m.observe(reading({ rawDate: raw(1951, 1, 2), money: 90_000n, loan: 50_000n, income: 0n }));
		m.observe(reading({ rawDate: raw(1951, 3, 1), money: 95_000n, loan: 50_000n, income: 5_000n }));

		const r = m.reading();
		expect(r.netCashFlow).toBe(45_000);
		expect(r.years).toHaveLength(2);

		const y1950 = r.years[0]!;
		expect(y1950.year).toBe(1950);
		expect(y1950.net).toBe(40_000);
		expect(y1950.close).toBe(40_000);
		expect(y1950.delta).toBe(0);
		expect(y1950.verified).toBe(true);

		const y1951 = r.years[1]!;
		expect(y1951.year).toBe(1951);
		expect(y1951.net).toBe(5_000);
		expect(y1951.close).toBeNull();
		expect(y1951.verified).toBe(false);

		expect(r.reconciled).toBe(true); // 真的核对过（跨过年且与引擎自报值一致）
	});

	it("闰年：2 月 29 日存在，且跨年积分不受影响", () => {
		const m = createProfitMeter();
		m.observe(reading({ rawDate: raw(1952, 1, 1), money: 50_000n, loan: 50_000n, income: 0n }));
		m.observe(reading({ rawDate: raw(1952, 2, 29), money: 50_000n, loan: 50_000n, income: 0n }));
		m.observe(reading({ rawDate: raw(1952, 3, 1), money: 50_000n, loan: 50_000n, income: 0n }));
		// 1953-01-01 的边界读数 ⇒ 1952（闰年，366 天）的完整值 = 0。
		m.observe(reading({ rawDate: raw(1953, 1, 1), money: 50_000n, loan: 50_000n, income: 0n }));
		// 计数器归零后的一条读数：钱没动 ⇒ 这一年既没有流量，也检测不到翻转
		// （恒等式没断）⇒ 这一段合到同一年里（诚实：close 为 null = 没核对过）。
		const r = m.reading();
		expect(r.years).toHaveLength(1);
		expect(r.years[0]!.year).toBe(1952);
		expect(r.years[0]!.close).toBeNull();
		expect(r.netCashFlow).toBe(0);
	});

	it("漏掉边界读数：那段没有引擎自报值，对账差为 null（不是 0）", () => {
		const m = createProfitMeter();
		m.observe(reading({ rawDate: raw(1950, 1, 1), money: 50_000n, loan: 50_000n, income: 0n }));
		// 直接跳到 1950-06-01（没有 1 月 1 日的读数）⇒ 这段无法闭合。
		m.observe(reading({ rawDate: raw(1950, 6, 1), money: 90_000n, loan: 50_000n, income: 40_000n }));
		m.observe(reading({ rawDate: raw(1951, 6, 1), money: 90_000n, loan: 50_000n, income: 40_000n }));
		const r = m.reading();
		expect(r.years).toHaveLength(1);
		expect(r.years[0]!.close).toBeNull();
		expect(r.years[0]!.delta).toBeNull();
		expect(r.years[0]!.verified).toBe(false);
		// 净现金流照样是精确的（money 口径与分段无关）。
		expect(r.netCashFlow).toBe(40_000);
		// 没抓到年边界 ⇒ 没核对过（不是"核对通过"）。
		expect(r.reconciled).toBe(false);
	});

	it("引擎自报值与 money 口径对不上：报出差值，不悄悄折零", () => {
		// 差值**正是**这条对账要抓的东西：积分器假设"公司创建时 money == current_loan"
		// （净额 0），引擎自报的整年值则不依赖这个假设 ⇒ 两者不等 ⇒ 基线假设被推翻。
		const m = createProfitMeter();
		// 首条读数：净额已经是 40,000（不是 0）⇒ 基线假设不成立。
		m.observe(reading({ rawDate: raw(1950, 1, 1), money: 90_000n, loan: 50_000n, income: 0n }));
		m.observe(reading({ rawDate: raw(1950, 6, 1), money: 100_000n, loan: 50_000n, income: 10_000n }));
		// 1950-12-31 的边界读数（携带整年值 10,000），之后计数器归零。
		m.observe(reading({ rawDate: raw(1950, 12, 31), money: 100_000n, loan: 50_000n, income: 10_000n }));
		m.observe(reading({ rawDate: raw(1951, 1, 1), money: 100_000n, loan: 50_000n, income: 0n }));
		const r = m.reading();
		expect(r.years[0]!.net).toBe(50_000); // money 口径：净额 50,000 − 基线 0
		expect(r.years[0]!.close).toBe(10_000); // 引擎自报的整年值
		expect(r.years[0]!.delta).toBe(40_000); // 差额 = 被推翻的基线
		expect(r.years[0]!.verified).toBe(false);
		expect(r.reconciled).toBe(false); // 有矛盾 ⇒ 没核对过
	});

	it("分段之和等于净现金流（时间轴被分段完整覆盖）", () => {
		const m = createProfitMeter();
		m.observe(reading({ rawDate: raw(1950, 1, 1), money: 50_000n, loan: 50_000n, income: 0n }));
		m.observe(reading({ rawDate: raw(1950, 7, 1), money: 70_000n, loan: 50_000n, income: 20_000n }));
		m.observe(reading({ rawDate: raw(1951, 1, 1), money: 70_000n, loan: 50_000n, income: 20_000n }));
		m.observe(reading({ rawDate: raw(1951, 1, 2), money: 70_000n, loan: 50_000n, income: 0n }));
		m.observe(reading({ rawDate: raw(1951, 7, 1), money: 80_000n, loan: 50_000n, income: 10_000n }));
		const r = m.reading();
		const sum = r.years.reduce((a, y) => a + y.net, 0);
		expect(sum).toBe(r.netCashFlow);
	});
});

describe("profit per game day — 分母是这一局经过的天数", () => {
	it("分子分母同源：净现金流 ÷ 经过的游戏日", () => {
		expect(profitPerGameDay(50_000, 300)).toBeCloseTo(166.6667, 3);
	});

	it("缺读数不是 0", () => {
		expect(profitPerGameDay(null, 300)).toBeNull();
		expect(profitPerGameDay(Number.NaN, 300)).toBeNull();
	});

	it("分母不是正数就是 null（不折零）", () => {
		expect(profitPerGameDay(50_000, 0)).toBeNull();
		expect(profitPerGameDay(50_000, null)).toBeNull();
		expect(profitPerGameDay(50_000, -3)).toBeNull();
	});
});
