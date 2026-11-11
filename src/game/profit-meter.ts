/**
 * 收益读数积分器 —— Issue #104 P0b。
 *
 * 职责: 把 admin 的 `company_economy` 读数变成**本局**的收益读数，并把"跨年"
 *   这件事处理干净（分段 + 与引擎自报对账）。
 * 为什么存在: 旧读数 `income / 365`（`src/evolution/reflection-run.ts`）量的是
 *   **当年迄今净现金流 ÷ 整年长度**（SPEC §10.55 / §10.76）—— 既不是运营利润，
 *   也不是"这一局的每游戏日利润"。局跨过 1 月 1 日时它只覆盖最后一年。
 *
 * **引擎口径（本模块赖以成立的三条事实，SPEC §10.55）**：
 * 1. `income = -Σ company->yearly_expenses[0]` ⇒ **当年迄今净现金流**（收入记为负
 *    费用）⇒ 含基建/购车/利息，**不含**运营利润口径里的运行成本以外的项。
 * 2. 年边界（calendar 模式 = **1 月 1 日**）`rotate + fill(0)` ⇒ 计数器归零。
 * 3. 引擎在 1 月 1 日**先**发 admin 年度读数（年度定时器优先级 NONE），**之后**才
 *    清零公司与车辆计数（公司 COMPANY / 车辆 VEHICLE）⇒ 那一条读数携带的是
 *    **上一整年的完整值**。
 *
 * **恒等式（本模块的主干）**：每笔费用都做 `money -= cost; yearly_expenses[0] += cost`
 *   （`company_cmd.cpp`），借款让 `money` 与 `current_loan` **同增同减**，贷款利息是
 *   **按月**计的（不是年边界）⇒
 *   **`Δ(money − loan) === 窗口内的净现金流`，跨 1 月 1 日照样成立。**
 *   而公司在创建时 `money = current_loan`（`company_cmd.cpp`）⇒ `money − loan` 从
 *   创建起就是 0 ⇒ **最后一条读数的 `money − loan` 就是本局自创建以来的净现金流**，
 *   不需要任何"年初基线"，也不受跨年影响。
 *
 * 分段与对账：按**日历年**切段。**年边界不靠日期猜**（GS 的时钟可能比读数晚一天），
 *   而是靠引擎自己的恒等式：同一个年里 `Δincome == Δ(money − loan)`，**跨过 1 月 1 日
 *   就不等**（计数器归零了）⇒ 两条读数一旦对不上，就说明中间发生了年翻转，而**前一条**
 *   读数就是上一年的最后一条（它的 `income` 是引擎自报的**上一整年完整值**）。
 *   每段的净现金流用 money 口径算（精确），再用引擎自报的整年值核对 ⇒ 对不上就标
 *   `verified: false` 并报出差值（漏读/边界读数丢失都会落到这里，而不是悄悄变成 0）。
 *
 * 铁律: 缺失不折零（MEMORY D60）——没测到就是 `null`；`delta !== 0` 就是"对不上"，
 *   不是"差不多"。
 * 禁止: 在此给出任何评价（"赚/亏"）——只给读数与它的条件。
 */

import { dayOfYear, daysInYear, rawToYmd } from "./calendar.js";

/** 一条 admin 经济读数（数值可以是 BigInt：引擎的 money/loan/income 是 u64）。 */
export interface EconomyReading {
	/** 引擎 raw 日期（与 GS 的 `gameDate` 同一纪元）。 */
	rawDate: number;
	/** 公司现金。 */
	money: bigint | number;
	/** 公司当前贷款。 */
	loan: bigint | number;
	/** 引擎自报的**当年迄今净现金流**（年边界归零）。 */
	income: bigint | number;
}

/** 一个日历年分段。 */
export interface YearFlow {
	/** 日历年（引擎日历）。 */
	year: number;
	/** 该段起点（引擎 raw 日期）：创建时刻或 1 月 1 日的边界读数。 */
	fromRawDate: number;
	/** 该段终点（引擎 raw 日期）：1 月 1 日的边界读数，或最后一条读数。 */
	toRawDate: number;
	/** 该段观测到的净现金流（money 口径：`Δ(money − loan)`，精确）。 */
	net: number;
	/** 引擎自报的该年完整值（下一个 1 月 1 日的边界读数携带）；null = 没抓到。 */
	close: number | null;
	/** 对账差（money 口径 − 引擎自报口径）；null = 没核对（close 缺失）。 */
	delta: number | null;
	/** 该段是否与引擎自报值核对通过。 */
	verified: boolean;
}

/** 本局的收益读数。 */
export interface ProfitReading {
	/** 本局净现金流（最后一条读数的 `money − loan`）。null = 没测到。 */
	netCashFlow: number | null;
	/** 读数条数（0 = 什么都没测到）。 */
	readings: number;
	/** 首条读数的引擎日期；null = 没测到。 */
	firstRawDate: number | null;
	/** 末条读数的引擎日期；null = 没测到。 */
	lastRawDate: number | null;
	/** 逐年的分段（按引擎日历的日历年，最早在前）。 */
	years: YearFlow[];
	/**
	 * 是否**真的核对过**：至少抓到一个年边界，且它与引擎自报的整年值相等。
	 * （一局没跨年 ⇒ 没有可核对的边界 ⇒ 这不是"核对通过"，是"没核对"。）
	 */
	reconciled: boolean;
}

/** 内部状态：一段（一个日历年）的累计。 */
interface Segment {
	year: number;
	fromRawDate: number;
	fromNetAssets: bigint;
	toRawDate: number;
	toNetAssets: bigint;
	/** 引擎自报的该年完整值；null = 还没抓到（这一段还没结束或边界读数丢了）。 */
	close: number | null;
}

/** 最近一条读数（判定年翻转要用它的计数器值与净额）。 */
interface LastReading {
	rawDate: number;
	income: number;
	netAssets: bigint;
}

/** 读数积分器（纯状态机：一个实例 = 一家公司 = 一局）。 */
export interface ProfitMeter {
	/** 观察一条经济读数（按时间顺序；乱序或重复的日期会被忽略）。 */
	observe(reading: EconomyReading): void;
	/** 当前读数（快照）。 */
	reading(): ProfitReading;
}

function toBigInt(v: bigint | number): bigint {
	return typeof v === "bigint" ? v : BigInt(Math.trunc(v));
}

/**
 * 这条读数是不是**贴着年边界**（年末或年初）？
 *
 * 引擎在 1 月 1 日**先**发读数（携带上一整年的完整值）、**之后**才清零计数器
 * （SPEC §10.55）⇒ 边界读数带的是**整年**的值；边界之后的普通读数带的是**新一年
 * 迄今**的值（很小）⇒ 只有贴着边界的读数才能当"这一年的完整值"来对账。
 *
 * 窗口取 ±2 天：GS 的时钟每 ~200 tick（约一个游戏日）才报一次，读数的日期可能
 * 比边界早一两天（宁可说"没核对过"，也不要拿一个残缺的值当整年值）。
 */
function isAtYearBoundary(rawDate: number, year: number): boolean {
	const ymd = rawToYmd(rawDate);
	if (ymd.year === year) return dayOfYear(rawDate) >= daysInYear(year) - 2;
	if (ymd.year === year + 1) return dayOfYear(rawDate) <= 2;
	return false;
}

/**
 * 创建一个收益读数积分器。
 *
 * 首条读数建立**创建时刻**的基线：引擎在创建公司时 `money = current_loan`
 * （`company_cmd.cpp`）⇒ `money − loan = 0`，计数器（`yearly_expenses`）也是空的
 * ⇒ 该年段落的起点净额是 0、起点计数器是 0。
 */
export function createProfitMeter(): ProfitMeter {
	let readings = 0;
	let firstRawDate: number | null = null;
	let lastRawDate: number | null = null;
	let lastNetAssets: bigint | null = null;
	let last: LastReading | null = null;
	let segment: Segment | null = null;
	const closed: YearFlow[] = [];

	const flowOf = (s: Segment): YearFlow => {
		const net = Number(s.toNetAssets - s.fromNetAssets);
		const delta = s.close === null ? null : net - s.close;
		return {
			year: s.year,
			fromRawDate: s.fromRawDate,
			toRawDate: s.toRawDate,
			net,
			close: s.close,
			delta,
			verified: delta !== null && delta === 0,
		};
	};

	return {
		observe(r: EconomyReading): void {
			const netAssets = toBigInt(r.money) - toBigInt(r.loan);
			const income = Number(r.income);
			const year = rawToYmd(r.rawDate).year;

			// 乱序 / 重复日期的读数不参与积分（引擎的读数按时间递增；这里只防呆）。
			if (lastRawDate !== null && r.rawDate < lastRawDate) return;

			if (segment === null) {
				readings = 1;
				firstRawDate = r.rawDate;
				lastRawDate = r.rawDate;
				lastNetAssets = netAssets;
				last = { rawDate: r.rawDate, income, netAssets };
				segment = {
					year,
					fromRawDate: r.rawDate,
					fromNetAssets: 0n, // 公司创建时 money == current_loan ⇒ 净额 0
					toRawDate: r.rawDate,
					toNetAssets: netAssets,
					close: null,
				};
				return;
			}

			readings++;
			lastRawDate = r.rawDate;
			lastNetAssets = netAssets;

			// 年翻转的判定**不靠日期**（GS 的时钟可能比读数晚一天）：同一个年里
			// `Δincome === Δ(money − loan)`，计数器一归零就不等 ⇒ 不等就是翻转。
			const dIncome = income - (last?.income ?? 0);
			const dNet = Number(netAssets - (last?.netAssets ?? netAssets));
			if (last !== null && dIncome !== dNet) {
				// 计数器与钱对不上 ⇒ 中间发生了**计数器归零**（年翻转）。
				// 前一条读数是**上一年的最后一条**：它的 `income` 是引擎自报的
				// **上一整年完整值**（引擎先发年度/季度读数、之后才清零，SPEC §10.55）。
				// 现金是连续的 ⇒ 这条读数既是上一段的终点，也是下一段的起点。
				//
				// 只有**贴着年边界**的那条读数才配当"整年值"（否则只是一个残缺的
				// 年中值，拿它对账就是空对账）⇒ 没贴着边界就**不给 close**（= 没核对过）。
				const atBoundary = isAtYearBoundary(last.rawDate, segment.year);
				if (atBoundary) segment.close = last.income;
				segment.toRawDate = last.rawDate;
				segment.toNetAssets = last.netAssets;
				closed.push(flowOf(segment));
				segment = {
					year,
					fromRawDate: last.rawDate,
					fromNetAssets: last.netAssets,
					toRawDate: r.rawDate,
					toNetAssets: netAssets,
					close: null,
				};
				last = { rawDate: r.rawDate, income, netAssets };
				return;
			}

			segment.toRawDate = r.rawDate;
			segment.toNetAssets = netAssets;
			last = { rawDate: r.rawDate, income, netAssets };
		},

		reading(): ProfitReading {
			const years = closed.slice();
			if (segment !== null) years.push(flowOf(segment));
			const netCashFlow = lastNetAssets === null ? null : Number(lastNetAssets);
			// 只有**抓到年边界**的段才有可核对的值；开放中的那一段还没有 ⇒ 不算矛盾。
			const captured = years.filter((y) => y.close !== null);
			return {
				netCashFlow,
				readings,
				firstRawDate,
				lastRawDate,
				years,
				reconciled: captured.length > 0 && captured.every((y) => y.delta === 0),
			};
		},
	};
}

/**
 * 每经过一个游戏日的净现金流。分母必须是**这一局实际经过的游戏日**
 * （不是整年长度、不是绝对游戏日）——分子分母不同源就是错的读数。
 *
 * 缺失不折零：分子未知或分母不是正数 ⇒ `null`（不是 0）。
 */
export function profitPerGameDay(netCashFlow: number | null, elapsedGameDays: number | null): number | null {
	if (netCashFlow === null || !Number.isFinite(netCashFlow)) return null;
	if (elapsedGameDays === null || !Number.isFinite(elapsedGameDays) || elapsedGameDays <= 0) return null;
	return netCashFlow / elapsedGameDays;
}
