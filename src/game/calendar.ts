/**
 * Calendar time model — the one place that knows what a game day is.
 *
 * 职责：把引擎的**日历日期**（raw date / y-m-d）与 harness 的"游戏日"互相换算，
 *   并给出年内第几天、季度边界等**引擎口径**的派生量。纯函数，无 IO。
 * 禁止：任何"近似"（闰年、月末、季度都必须按引擎算），任何策略判断。
 *
 * 为什么（SPEC §10.55 / §10.76）：旧的 `gameDayFromRawDate` 把日历日期投影到
 * **虚构的 360 天年**（`year*360 + (month-1)*30 + (day-1)`）⇒ 每年丢 5 天
 * （1 月 31 日与 2 月 1 日映成同一天）⇒ "250 游戏日"其实约 256 **日历**天。
 * 而引擎在 calendar 模式（默认）下经济日期与日历同步 ⇒ 经济年 = **日历年**
 * ⇒ harness 与引擎的"年"不是同一个年 ⇒ 凡是"每游戏日"的读数分母都不对。
 *
 * 事实来源：OpenTTD 15.3（tag `15.3`，commit `14ec60f`）
 *   - `src/timer/timer_game_economy.h`：`DAYS_IN_ECONOMY_YEAR = 360` 的注释是
 *     "when in wallclock timekeeping mode" ⇒ calendar 模式下年 = 日历年；
 *   - `src/timer/timer_game_common.h`：日历年 365/366 天（闰年规则同格里历）；
 *   - raw date = 距 0000-01-01 的天数（前推格里历，0 年是闰年），live capture：
 *     `-t 1950` ⇒ raw 712223 = 1950-01-01。
 */

export interface YearMonthDay {
	year: number;
	/** 1-based */
	month: number;
	/** 1-based */
	day: number;
}

/**
 * wallclock 模式的年长（引擎常量）。**本项目不用它**：我们的局跑在 calendar 模式，
 * 引擎自己把这个常量的注释写成 "when in wallclock timekeeping mode"。
 * 保留它只为让"360 天"这个曾经的错误有唯一出处，而不是散落在各处。
 */
export const DAYS_IN_ECONOMY_YEAR_WALLCLOCK = 360;

/** 1950-01-01 的 raw date —— harness 的游戏日纪元（游戏日 0 = 这一天）。 */
export const GAME_EPOCH_RAW = 712223;

export function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
	switch (month) {
		case 1:
		case 3:
		case 5:
		case 7:
		case 8:
		case 10:
		case 12:
			return 31;
		case 4:
		case 6:
		case 9:
		case 11:
			return 30;
		case 2:
			return isLeapYear(year) ? 29 : 28;
		default:
			throw new RangeError(`month out of range: ${month}`);
	}
}

export function daysInYear(year: number): number {
	return isLeapYear(year) ? 366 : 365;
}

/** [0, year) 之间的闰年个数（year 0 是闰年，与 OpenTTD 的历法一致）。 */
function leapYearsBefore(year: number): number {
	if (year <= 0) return 0;
	const m4 = Math.floor((year - 1) / 4) + 1;
	const m100 = Math.floor((year - 1) / 100) + 1;
	const m400 = Math.floor((year - 1) / 400) + 1;
	return m4 - m100 + m400;
}

/** y-m-d → raw date（距 0000-01-01 的天数）。 */
export function ymdToRaw(year: number, month: number, day: number): number {
	let days = year * 365 + leapYearsBefore(year);
	for (let m = 1; m < month; m++) days += daysInMonth(year, m);
	return days + day - 1;
}

/**
 * raw date → y-m-d。算法与 OpenTTD 的 `CalendarConvertDateToYMD` 一致
 * （前推格里历，0 年是闰年）。
 */
export function rawToYmd(raw: number): YearMonthDay {
	const days = Math.trunc(raw);
	// 先用平均年长估一个年份，再修正（平均年长会偏，估一次不够准，估多了也不会
	// 跑远）。修正后 `days` 是该年内的第几天（0-based）。
	let year = Math.max(0, Math.floor(days / 365.2425));
	while (year > 0 && ymdToRaw(year, 1, 1) > days) year--;
	while (ymdToRaw(year + 1, 1, 1) <= days) year++;
	let rest = days - ymdToRaw(year, 1, 1);
	let month = 1;
	for (;;) {
		const len = daysInMonth(year, month);
		if (rest < len) break;
		rest -= len;
		month++;
	}
	return { year, month, day: rest + 1 };
}

/** 年内第几天（1..365/366）。1 月 1 日 = 1。 */
export function dayOfYear(raw: number): number {
	const { year } = rawToYmd(raw);
	return raw - ymdToRaw(year, 1, 1) + 1;
}

/** 年内第几季（1..4）：1/4/7/10 月开始（calendar 模式与引擎的季度一致）。 */
export function quarterOfYear(raw: number): number {
	return Math.floor((rawToYmd(raw).month - 1) / 3) + 1;
}

/**
 * 季度序号（单调递增的整数）。计数器用它认季度边界 —— 不能用
 * `floor(day / 90)`：日历年里的季度是 90–92 天，只有**边界**是确定的。
 */
export function quarterIndex(raw: number): number {
	const { year } = rawToYmd(raw);
	return year * 4 + (quarterOfYear(raw) - 1);
}

/** raw date → 游戏日（距 1950-01-01 的日历天数）。 */
export function gameDayFromRaw(raw: number): number {
	return Math.trunc(raw) - GAME_EPOCH_RAW;
}

/** y-m-d → 游戏日（距 1950-01-01 的日历天数）。 */
export function gameDayFromYmd(year: number, month: number, day: number): number {
	return ymdToRaw(year, month, day) - GAME_EPOCH_RAW;
}

/** 两个游戏日之间经过的日历天数（to − from，可为负）。 */
export function elapsedGameDays(from: number, to: number): number {
	return to - from;
}
