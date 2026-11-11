/**
 * Guard: the harness's clock must be the engine's calendar, and there must be
 * exactly one implementation of it.
 *
 * Why a static test: the old clock was a **fictional 360-day year**
 * (`year*360 + (month-1)*30 + (day-1)`) and it had been **copied into six
 * places** (payload-parsers, signal-hub, runner-helpers, v02-runner ×2,
 * world-state). Six copies of a wrong clock is not a typo, it is a design:
 * each call site could drift on its own, and each one did (some projected the
 * calendar, some counted 90-day quarters off the same projection). A unit test
 * cannot catch "a fourth copy appeared"; this one can.
 *
 * The engine's own header says it: `DAYS_IN_ECONOMY_YEAR = 360` is documented
 * as "when in wallclock timekeeping mode" (`src/timer/timer_game_economy.h`),
 * and our games run in calendar mode - so the year is the calendar year
 * (365/366 days). A 360-day year loses 5 days a year (31 January and
 * 1 February map to the same index).
 *
 * Rule: the calendar has one home (`src/game/calendar.ts`). Any new date
 * conversion goes there; any other module that needs a game day imports it.
 */
import { globSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const TS_FILES = globSync("src/**/*.ts").sort();
const CALENDAR = "src/game/calendar.ts";

/** Strip comments and string literals so the scan sees code, not prose. */
function codeOnly(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/.*$/gm, "$1 ")
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''")
		.replace(/`(?:\\.|[^`\\])*`/g, "``");
}

describe("calendar guard —— 一处时间模型", () => {
	it("除了 calendar.ts，别处不许出现 360 天的年长", () => {
		const offenders: string[] = [];
		for (const file of TS_FILES) {
			if (file === CALENDAR) continue;
			const src = codeOnly(readFileSync(file, "utf8"));
			src.split("\n").forEach((line, i) => {
				if (/\b360\b/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
			});
		}
		expect(offenders).toEqual([]);
	});

	it("除了 calendar.ts，别处不许自己做日历投影（年 × 360 / 月 × 30 / 日 − 1）", () => {
		const offenders: string[] = [];
		const projection =
			/\*\s*360\b|\b360\s*\*|\*\s*30\b|\b30\s*\*\s*\(|\b30\s*\)\s*\+/;
		for (const file of TS_FILES) {
			if (file === CALENDAR) continue;
			const src = codeOnly(readFileSync(file, "utf8"));
			src.split("\n").forEach((line, i) => {
				// A month/day projection is the shape the old clock had.
				if (/\(\s*\w+\s*-\s*1950\s*\)/.test(line) || (projection.test(line) && /\bmonth\b|\bday\b/.test(line))) {
					offenders.push(`${file}:${i + 1}: ${line.trim()}`);
				}
			});
		}
		expect(offenders).toEqual([]);
	});

	it("季度不许再按「天数 / 90」推（季度的长度不是固定的 90 天）", () => {
		const offenders: string[] = [];
		for (const file of TS_FILES) {
			if (file === CALENDAR) continue;
			const src = codeOnly(readFileSync(file, "utf8"));
			src.split("\n").forEach((line, i) => {
				if (/\/\s*90\b|\b90\s*\)/.test(line) && /quarter|QUARTER/i.test(line)) {
					offenders.push(`${file}:${i + 1}: ${line.trim()}`);
				}
			});
		}
		expect(offenders).toEqual([]);
	});

	it("日历模块提供唯一出处：raw↔ymd、游戏日、年内天数、季度序号", () => {
		const src = readFileSync(CALENDAR, "utf8");
		for (const fn of ["rawToYmd", "ymdToRaw", "gameDayFromRaw", "gameDayFromYmd", "dayOfYear", "quarterIndex"]) {
			expect(src, `${CALENDAR} must export ${fn}`).toContain(`export function ${fn}`);
		}
	});
});
