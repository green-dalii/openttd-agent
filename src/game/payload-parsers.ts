/**
 * Admin Port payload parsers — decode raw packet payloads into normalized
 * structures. Pure functions, no IO.
 *
 * 职责: 把 server packet payload (byte layout 见 SPEC §2 / network_admin.cpp)
 *   解码为类型化对象。
 * 事实来源: network_admin.cpp `Send*` handlers 的字段顺序。
 * 禁止: IO; 抛异常吞协议错 (defensive: 截断 payload 返回部分结果)。
 * 注意: **日历换算不在这里**（那是 `src/game/calendar.ts` 的唯一职责）。
 */

import { ByteReader } from "./admin-protocol.js";

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
