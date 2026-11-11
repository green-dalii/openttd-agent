/**
 * Recompute a finished run's profit reading from its own archive.
 *
 * 职责: 只读一局的 `events.jsonl`，把里面的经济读数喂给**harness 用的同一个**
 *   积分器（`src/game/profit-meter.ts`），回答三个问题：
 *   ① 这一局的**净现金流**是多少（`money − loan`，含基建/购车/利息，跨年成立）？
 *   ② 逐年分段与**引擎自报的整年值**对得上吗（差额 = 缺口）？
 *   ③ 这些数字能不能**离线重算**——答案是能，因为读数序列真的落盘了
 *      （2026-11-11 之前归档把每一条经济事件都丢了：BigInt 撞上原生 JSON.stringify）。
 * 禁止: 修改任何数据；不替 harness 下结论（分段与差额只报数，不评价）。
 *
 * 用法:
 *   pnpm exec tsx scripts/recompute-profit.ts /tmp/pProfit2/sessions/<session-id>
 *
 * 背景（SPEC §10.55 / §10.76，Issue #104 P0b）: 旧读数 `income / 365` 量的是
 * **当年迄今净现金流 ÷ 整年长度**——既不是"这一局"，也不是"每游戏日"。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createProfitMeter } from "../src/game/profit-meter.js";
import { rawToYmd } from "../src/game/calendar.js";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: tsx scripts/recompute-profit.ts <sessionDir>");
	process.exit(2);
}

const file = path.join(dir, "events.jsonl");
const events = readFileSync(file, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => JSON.parse(l) as { kind: string; ts: number; payload: Record<string, unknown> });

// 归档里的 `date` 事件给出"这条经济读数发生在哪一天"（harness 侧用的就是这个时钟）。
let currentRaw = 0;
const meter = createProfitMeter();
let readings = 0;
let skipped = 0;

for (const ev of events) {
	if (ev.kind === "date") {
		const raw = Number(ev.payload.raw);
		if (Number.isFinite(raw)) currentRaw = raw;
		continue;
	}
	if (ev.kind !== "company_economy") continue;
	if (!currentRaw) {
		// 还没有任何日期读数 ⇒ 这条读数没有归属（harness 侧同样跳过它）。
		skipped++;
		continue;
	}
	const p = ev.payload as { id: number; money: string; loan: string; income: string };
	if (p.id !== 0) continue;
	meter.observe({
		rawDate: currentRaw,
		money: BigInt(p.money),
		loan: BigInt(p.loan),
		income: BigInt(p.income),
	});
	readings++;
}

const r = meter.reading();
const money = (v: number | null): string => (v === null ? "not measured" : String(v));
console.log(`readings=${readings} skipped(no date yet)=${skipped}`);
console.log(`netCashFlow=${money(r.netCashFlow)}  (money - loan at the last reading)`);
console.log(
	`window: ${r.firstRawDate ?? "?"} .. ${r.lastRawDate ?? "?"} ` +
		`(${r.firstRawDate ? rawToYmd(r.firstRawDate).year : "?"} .. ${r.lastRawDate ? rawToYmd(r.lastRawDate).year : "?"})`,
);
console.log(`reconciled=${r.reconciled}  (a year boundary was captured and agrees with the engine)`);
for (const y of r.years) {
	const from = rawToYmd(y.fromRawDate);
	const to = rawToYmd(y.toRawDate);
	console.log(
		`  year ${y.year}: net=${y.net} close=${y.close === null ? "not captured" : y.close} ` +
			`delta=${y.delta === null ? "n/a" : y.delta} verified=${y.verified} ` +
			`(${from.month}/${from.day} .. ${to.month}/${to.day})`,
	);
}
