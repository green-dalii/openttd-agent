import { describe, expect, it } from "vitest";
import { convertDateToYmd, parseCompanyEconomy } from "../../src/game/payload-parsers.js";

describe("convertDateToYmd (OpenTTD raw date -> y/m/d)", () => {
	it("anchors the authoritative raw date 712223 = 1950-01-01", () => {
		// Empirically captured from a live dedicated server started with `-t 1950`:
		// ServerWelcome START_DATE_RAW = 712223.
		expect(convertDateToYmd(712223)).toEqual({ year: 1950, month: 1, day: 1 });
	});

	it("handles year 0 boundary and leap years", () => {
		expect(convertDateToYmd(0)).toEqual({ year: 0, month: 1, day: 1 });
		// 2000 is a leap year (div by 400)
		const start2000 = daysFromYmd(2000, 1, 1);
		expect(convertDateToYmd(start2000)).toEqual({ year: 2000, month: 1, day: 1 });
		// 2000-02-29 exists
		expect(convertDateToYmd(daysFromYmd(2000, 2, 29))).toEqual({ year: 2000, month: 2, day: 29 });
		// 1900 is NOT a leap year (div by 100 not 400)
		expect(convertDateToYmd(daysFromYmd(1900, 3, 1))).toEqual({ year: 1900, month: 3, day: 1 });
	});

	it("round trips across a wide range", () => {
		for (const [y, m, d] of [
			[1950, 1, 1],
			[2000, 2, 29],
			[2050, 12, 31],
			[1900, 2, 28],
			[1, 1, 1],
			[9999, 12, 31],
		] as const) {
			expect(convertDateToYmd(daysFromYmd(y, m, d))).toEqual({ year: y, month: m, day: d });
		}
	});
});

describe("parseCompanyEconomy", () => {
	it("parses authoritative SendCompanyEconomy layout", () => {
		// u8 id, u64 money, u64 loan, u64 income, u16 delivered,
		// 2x(u64 companyValue, u16 performance, u16 delivered)
		const parts: Uint8Array[] = [Uint8Array.of(2)];
		for (const v of [5_000_000n, 1_000_000n, 750_000n]) {
			const b = new Uint8Array(8);
			new DataView(b.buffer).setBigUint64(0, v, true);
			parts.push(b);
		}
		const d1 = new Uint8Array(2);
		new DataView(d1.buffer).setUint16(0, 200, true);
		parts.push(d1);
		for (const [value, perf, deliv] of [
			[4_500_000n, 950, 190],
			[4_000_000n, 900, 170],
		] as const) {
			const b = new Uint8Array(8);
			new DataView(b.buffer).setBigUint64(0, value, true);
			parts.push(b);
			const p = new Uint8Array(2);
			new DataView(p.buffer).setUint16(0, perf, true);
			parts.push(p);
			const dd = new Uint8Array(2);
			new DataView(dd.buffer).setUint16(0, deliv, true);
			parts.push(dd);
		}
		const payload = concat(parts);

		const out = parseCompanyEconomy(payload);
		expect(out).toEqual({
			id: 2,
			money: 5_000_000n,
			loan: 1_000_000n,
			income: 750_000n,
			deliveredCargo: 200,
			companyValue: 4_500_000n,
			performanceLastYear: 950,
			performancePrevYear: 900,
		});
	});

	it("reads negative Money fields as signed (not 2^64 underflow)", () => {
		// Real-machine bug: a company losing money sends a negative income as
		// two's complement; read as u64 it became 18446744073709551615 and the
		// dashboard showed "£18446744073.71B income". OpenTTD's Money is int64
		// and Send_uint64 merely serializes the 8 bytes, so these must be signed.
		// See SPEC §10.6 (signedness) and docs/DASHBOARD-UI.md §0.
		const parts: Uint8Array[] = [Uint8Array.of(0)];
		for (const v of [-2_500n, 100_000n, -1n]) {
			const b = new Uint8Array(8);
			new DataView(b.buffer).setBigInt64(0, v, true);
			parts.push(b);
		}
		const d1 = new Uint8Array(2);
		new DataView(d1.buffer).setUint16(0, 0, true);
		parts.push(d1);
		const out = parseCompanyEconomy(concat(parts));
		expect(out.money).toBe(-2_500n);
		expect(out.loan).toBe(100_000n);
		expect(out.income).toBe(-1n);
		// The exact regression: a small negative must never become ~1.8e19.
		expect(out.income < 0n).toBe(true);
	});

	it("tolerates truncated payloads defensively", () => {
		const out = parseCompanyEconomy(Uint8Array.of(0, 1, 2, 3));
		expect(out.id).toBe(0);
		expect(out.money).toBeDefined();
	});
});

// --- helpers: OpenTTD calendar math (days since year 0, proleptic Gregorian) ---

/** OpenTTD "days since 0000-01-01" for a y/m/d. */
function daysFromYmd(year: number, month: number, day: number): number {
	let days = 0;
	for (let y = 0; y < year; y++) days += isLeap(y) ? 366 : 365;
	const mdays = monthDays(year);
	// mdays is 0-indexed: mdays[0]=Jan ... add months BEFORE `month` (1-based)
	for (let m = 0; m < month - 1; m++) days += mdays[m]!;
	return days + day - 1;
}

function isLeap(y: number): boolean {
	return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function monthDays(y: number): readonly number[] {
	const base = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
	if (isLeap(y)) {
		const m = [...base] as number[];
		m[1] = 29;
		return m;
	}
	return base;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}
