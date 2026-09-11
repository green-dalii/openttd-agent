/**
 * Admin Port payload parsers — decode raw packet payloads into normalized
 * structures. Pure functions, no IO.
 *
 * 职责: 把 server packet payload (byte layout 见 SPEC §2 / network_admin.cpp)
 *   解码为类型化对象。
 * 事实来源: network_admin.cpp `Send*` handlers 的字段顺序; OpenTTD 日历算法
 *   (raw date = days since 0000-01-01, proleptic Gregorian, verified by live
 *   capture: `-t 1950` -> raw 712223 = 1950-01-01).
 * 禁止: IO; 抛异常吞协议错 (defensive: 截断 payload 返回部分结果)。
 */

import { ByteReader } from "./admin-protocol.js";

export interface YearMonthDay {
	year: number;
	/** 1-based */
	month: number;
	/** 1-based */
	day: number;
}

function isLeapYear(y: number): boolean {
	return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

/**
 * OpenTTD raw date -> {year, month, day}.
 * Raw date 0 = 0000-01-01 (proleptic Gregorian with leap year 0).
 * Algorithm mirrors OpenTTD's CalendarConvertDateToYMD.
 */
export function convertDateToYmd(raw: number): YearMonthDay {
	let days = raw;
	let year = 0;
	for (;;) {
		const len = isLeapYear(year) ? 366 : 365;
		if (days < len) break;
		days -= len;
		year++;
	}
	const mdays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
	let month = 0;
	for (;;) {
		const len = mdays[month]!;
		if (days < len) break;
		days -= len;
		month++;
	}
	return { year, month: month + 1, day: days + 1 };
}

export interface ParsedCompanyEconomy {
	id: number;
	money: bigint;
	loan: bigint;
	income: bigint;
	deliveredCargo: number;
	/** Most recent quarterly company value (old_economy[0]). */
	companyValue: bigint;
	performanceLastYear: number;
	performancePrevYear: number;
}

/**
 * Decode a ServerCompanyEconomy payload.
 * Layout (network_admin.cpp SendCompanyEconomy):
 *   u8 index; u64 money; u64 current_loan; u64 income(neg expenses);
 *   u16 delivered_cargo; then for i in {0,1}:
 *     u64 company_value; u16 performance_history; u16 delivered_cargo.
 * Money fields are `int64` on the wire (OpenTTD `Money`); read them signed or a
 * loss-making company reports ~1.8e19 (SPEC §10.6).
 * Defensive: missing trailing fields become undefined-ish defaults; the id and
 * leading money/loan/income are always attempted.
 */
export function parseCompanyEconomy(payload: Uint8Array): ParsedCompanyEconomy {
	const r = new ByteReader(payload);
	const out: ParsedCompanyEconomy = {
		id: 0,
		money: 0n,
		loan: 0n,
		income: 0n,
		deliveredCargo: 0,
		companyValue: 0n,
		performanceLastYear: 0,
		performancePrevYear: 0,
	};
	try {
		out.id = r.uint8();
		out.money = r.int64();
		out.loan = r.int64();
		out.income = r.int64();
		out.deliveredCargo = r.uint16();
		// 2 quarters of old_economy
		for (let i = 0; i < 2 && r.remaining >= 12; i++) {
			const value = r.int64();
			const perf = r.uint16();
			r.uint16(); // delivered in that quarter (discarded; current already read)
			if (i === 0) {
				out.companyValue = value;
				out.performanceLastYear = perf;
			} else {
				out.performancePrevYear = perf;
			}
		}
	} catch {
		// truncated — keep what we parsed
	}
	return out;
}

/** Normalize to a GameDate-friendly shape from raw. */
export function rawDateToParts(raw: number): { year: number; month: number; day: number } {
	return convertDateToYmd(raw);
}
