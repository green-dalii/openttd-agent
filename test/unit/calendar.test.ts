/**
 * Calendar time model — the one place that knows what a game day is.
 *
 * 职责：把引擎的**日历日期**（raw date / y-m-d）与 harness 的"游戏日"互相换算，
 *   并给出年内第几天、季度边界等**引擎口径**的派生量。
 * 禁止：任何 IO、任何策略、任何"近似"（闰年、月末都必须按引擎算）。
 *
 * 为什么（SPEC §10.55 / §10.76）：旧的 `gameDayFromRawDate` 把日历日期投影到
 * **虚构的 360 天年**（`year*360 + (month-1)*30 + (day-1)`）⇒ 每年丢 5 天
 * （1 月 31 日与 2 月 1 日同号）⇒ "250 游戏日"其实约 256 **日历**天，而且
 * 引擎在 calendar 模式下（默认）经济年 = 日历年 ⇒ 引擎自己按 365/366 天算，
 * harness 按 360 天算 ⇒ **两边的"年"不是同一个年**。
 *
 * 事实来源：OpenTTD 15.3（tag `15.3`，commit `14ec60f`）
 *   - `src/timer/timer_game_economy.h`：`DAYS_IN_ECONOMY_YEAR = 360` 的注释是
 *     "when in wallclock timekeeping mode" ⇒ **calendar 模式下年 = 日历年**；
 *   - `src/timer/timer_game_common.h`：日历年 365/366 天（闰年规则同格里历）；
 *   - raw date = 距 0000-01-01 的天数（前推格里历），live capture：
 *     `-t 1950` ⇒ raw 712223 = 1950-01-01。
 */

import { describe, expect, it } from "vitest";
import {
	DAYS_IN_ECONOMY_YEAR_WALLCLOCK,
	GAME_EPOCH_RAW,
	dayOfYear,
	daysInMonth,
	daysInYear,
	elapsedGameDays,
	gameDayFromRaw,
	gameDayFromYmd,
	isLeapYear,
	quarterIndex,
	quarterOfYear,
	rawToYmd,
	ymdToRaw,
} from "../../src/game/calendar.js";

/** 与 OpenTTD 同一个算法：天数 → y/m/d（前推格里历，0 年是闰年）。 */
function daysFromYmd(year: number, month: number, day: number): number {
	let days = 0;
	for (let y = 0; y < year; y++) days += isLeapYear(y) ? 366 : 365;
	const mdays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	for (let m = 1; m < month; m++) days += mdays[m - 1]!;
	return days + day - 1;
}

/** 独立于被测实现的天数推进器（校验往返用）。 */
function advanceYmd(
	year: number,
	month: number,
	day: number,
): { year: number; month: number; day: number } {
	const mdays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	if (day < mdays[month - 1]!) return { year, month, day: day + 1 };
	if (month < 12) return { year, month: month + 1, day: 1 };
	return { year: year + 1, month: 1, day: 1 };
}

describe("raw date ↔ y/m/d（引擎口径）", () => {
	it("1950-01-01 是 raw 712223（live capture 的锚点）", () => {
		expect(rawToYmd(712223)).toEqual({ year: 1950, month: 1, day: 1 });
		expect(ymdToRaw(1950, 1, 1)).toBe(712223);
	});

	it("raw 0 是 0000-01-01", () => {
		expect(rawToYmd(0)).toEqual({ year: 0, month: 1, day: 1 });
	});

	it("往返：1950-2020 的每一天都还原成同一个日期", () => {
		const base = daysFromYmd(1950, 1, 1);
		let { year, month, day } = { year: 1950, month: 1, day: 1 };
		const mismatches: string[] = [];
		for (let raw = base; raw < daysFromYmd(2021, 1, 1); raw++) {
			const back = rawToYmd(raw);
			if (back.year !== year || back.month !== month || back.day !== day) {
				mismatches.push(`raw ${raw}: got ${back.year}-${back.month}-${back.day}`);
			}
			if (ymdToRaw(back.year, back.month, back.day) !== raw) {
				mismatches.push(`raw ${raw}: ymdToRaw mismatch`);
			}
			({ year, month, day } = advanceYmd(year, month, day));
		}
		expect(mismatches).toEqual([]);
	});

	it("闰年规则与格里历一致：2000 是闰年，1900 不是", () => {
		expect(isLeapYear(2000)).toBe(true);
		expect(isLeapYear(1900)).toBe(false);
		expect(isLeapYear(1950)).toBe(false);
		expect(daysInYear(2000)).toBe(366);
		expect(daysInYear(1900)).toBe(365);
		expect(daysInMonth(2000, 2)).toBe(29);
		expect(daysInMonth(1900, 2)).toBe(28);
		expect(rawToYmd(daysFromYmd(2000, 2, 29))).toEqual({ year: 2000, month: 2, day: 29 });
		expect(rawToYmd(daysFromYmd(1900, 3, 1))).toEqual({ year: 1900, month: 3, day: 1 });
	});
});

describe("游戏日 = 引擎的日历天", () => {
	it("游戏日以 1950-01-01 为 0", () => {
		expect(GAME_EPOCH_RAW).toBe(712223);
		expect(gameDayFromRaw(712223)).toBe(0);
		expect(gameDayFromRaw(712237)).toBe(14);
		expect(gameDayFromYmd(1950, 1, 15)).toBe(14);
	});

	it("真机证据：1950-01-15 → 1950-11-02 是 291 个日历天（旧投影给 287）", () => {
		const from = gameDayFromYmd(1950, 1, 15);
		const to = gameDayFromYmd(1950, 11, 2);
		expect(to - from).toBe(291);
		expect(elapsedGameDays(from, to)).toBe(291);
	});

	it("严格单调：跨月、跨年都各差 1 天（旧投影会把 1/31 与 2/1 映成同一天）", () => {
		const jan31 = gameDayFromYmd(1950, 1, 31);
		const feb1 = gameDayFromYmd(1950, 2, 1);
		expect(feb1 - jan31).toBe(1);
		const dec31 = gameDayFromYmd(1950, 12, 31);
		const jan1 = gameDayFromYmd(1951, 1, 1);
		expect(jan1 - dec31).toBe(1);
	});

	it("一整年 = 365 或 366 天（不是 360）", () => {
		expect(gameDayFromYmd(1951, 1, 1) - gameDayFromYmd(1950, 1, 1)).toBe(365);
		expect(gameDayFromYmd(2001, 1, 1) - gameDayFromYmd(2000, 1, 1)).toBe(366);
	});
});

describe("年内第几天与季度边界（引擎口径）", () => {
	it("dayOfYear 从 1 开始（1 月 1 日 = 1）", () => {
		expect(dayOfYear(ymdToRaw(1950, 1, 1))).toBe(1);
		expect(dayOfYear(ymdToRaw(1950, 12, 31))).toBe(365);
		expect(dayOfYear(ymdToRaw(2000, 12, 31))).toBe(366);
	});

	it("季度边界是 1/4/7/10 月 1 日（calendar 模式与引擎一致）", () => {
		expect(quarterOfYear(ymdToRaw(1950, 1, 1))).toBe(1);
		expect(quarterOfYear(ymdToRaw(1950, 4, 1))).toBe(2);
		expect(quarterOfYear(ymdToRaw(1950, 7, 1))).toBe(3);
		expect(quarterOfYear(ymdToRaw(1950, 10, 1))).toBe(4);
		expect(quarterOfYear(ymdToRaw(1950, 12, 31))).toBe(4);
	});

	it("quarterIndex 跨年递增（季度计数器的键）", () => {
		const q4 = quarterIndex(ymdToRaw(1950, 12, 31));
		const q1 = quarterIndex(ymdToRaw(1951, 1, 1));
		expect(q1 - q4).toBe(1);
		expect(quarterIndex(ymdToRaw(1951, 1, 1)) - quarterIndex(ymdToRaw(1950, 1, 1))).toBe(4);
	});

	it("wallclock 模式的 360 天常量只是常量，不是本项目的年长", () => {
		expect(DAYS_IN_ECONOMY_YEAR_WALLCLOCK).toBe(360);
		expect(daysInYear(1950)).not.toBe(DAYS_IN_ECONOMY_YEAR_WALLCLOCK);
	});
});
