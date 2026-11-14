/**
 * 公司级**运营利润**台账（Phase D）。
 *
 * 职责: 把"每辆车**当年迄今**的运营利润"变成**本局连续**的运营利润读数。
 * 为什么需要:
 *   - `route-stats.profit` 只统计**此刻停在两端车站上的车**（不是车队）⇒ 一条
 *     停在路上的车不贡献；车多了还会重复计数。
 *   - 引擎的 `profit_this_year` 是**当年迄今**（1 月 1 日归零）⇒ 直接拿来当
 *     "本局利润"会在跨年时**归零重来**。
 *   - **卖车会带走它的累计利润** ⇒ 公司口径必须**连续**：卖车不得清零。
 * 口径（引擎事实，`vehicle.cpp`/`economy.cpp`）:
 *   - `profit_this_year` = 路线利润（运货收入 + 中转分成）− **运行成本**；
 *     **不含**基建/购车/折旧/利息 ⇒ 这就是"运营利润"，与 admin 的 `income`
 *     （当年迄今**净现金流**，含基建与利息）**不是同一个量**。
 *   - 年边界（1 月 1 日）`profit_this_year = 0` ⇒ 跨年时读数会**掉**，那不是亏损。
 * 台账的三个数（每辆车）：
 *   - `origin`     = 增量参照点（读数 - origin = 这段赚的）。
 *   - `accumulated`= 本局累计（跨年**不清零**：年界只是把 origin 挪到新一年的读数）。
 *   - 退役（车消失 = 被卖掉）⇒ 它的 `accumulated` **冻结并留在账上**。
 * 铁律: 缺失不折零；"没测到"与"0"分开；**累计值是下界**时必须说出来
 *   （卖车那一刻的尾巴、以及跨年时没采到的那一段，都测不到）。
 */

import { rawToYmd } from "./calendar.js";

/** 一条车队读数（GS 的原始事实）。 */
export interface FleetReading {
	/** 引擎 raw 日期（与 GS 的 `gameDate` 同一纪元）。 */
	rawDate: number;
	/** 每辆车的**当年迄今**运营利润读数。 */
	vehicles: { id: number; profit: number }[];
}

/** 公司级运营利润读数。 */
export interface OperatingProfitReading {
	/** 本局累计运营利润（跨年连续、卖车不丢）。null = 一条读数都没有。 */
	operatingProfit: number | null;
	/** 当前在册车辆数。 */
	vehicles: number;
	/** 已退役（卖掉/消失）车辆数。 */
	retired: number;
	/** 退役车辆贡献的利润（它们本局累计的最后值）。 */
	retiredProfit: number;
	/** 读数条数。 */
	readings: number;
	/** 最后一条读数的引擎日期；null = 没测到。 */
	lastRawDate: number | null;
	/**
	 * 累计值是否**完整**：false = 中间有车被卖掉（卖车那一刻的尾巴没测到），
	 * 或跨过年边界（年界前最后一段没采到）⇒ 累计值是**下界**。
	 */
	complete: boolean;
	/** 跨过年边界的次数。 */
	yearFlips: number;
}

/** 台账（纯状态机：一个实例 = 一家公司 = 一局）。 */
export interface OperatingProfitLedger {
	/** 观察一条车队读数（按时间顺序；乱序的读数被忽略）。 */
	observe(reading: FleetReading): void;
	/** 当前读数（快照）。 */
	reading(): OperatingProfitReading;
}

export function createOperatingProfitLedger(): OperatingProfitLedger {
	/** 每辆车**本局累计**的运营利润（跨年不清零；退役时冻结）。 */
	const accumulated = new Map<number, number>();
	/** 每辆车**增量参照点**（读数 - origin = 这段赚的；跨年后重置）。 */
	const origin = new Map<number, number>();
	/** 已退役车辆的本局利润（卖车不得清零 ⇒ 留在账上）。 */
	const retired = new Map<number, number>();
	let readings = 0;
	let lastRawDate: number | null = null;
	let lastYear: number | null = null;
	let complete = true;
	let yearFlips = 0;

	const sum = (m: Map<number, number>): number => {
		let total = 0;
		for (const v of m.values()) total += v;
		return total;
	};

	return {
		observe(r: FleetReading): void {
			// 乱序的读数不参与积分（引擎的日期递增；这里只防呆）。
			if (lastRawDate !== null && r.rawDate < lastRawDate) return;

			const year = rawToYmd(r.rawDate).year;
			const flip = lastYear !== null && year !== lastYear;
			if (flip) {
				yearFlips++;
				// 跨年：引擎把每辆车的当年利润清零 ⇒ 读数"掉下去"**不是亏损**。
				// 但年界前最后一段（上次采样 → 年界）**没采到** ⇒ 累计值是下界。
				complete = false;
			}

			// **第一条读数只建基线**：它是"这一局开始时车已经赚了多少"的快照 ⇒
			// 不计入本局（从存档起步的局里，车带着**上一段历史**的利润）。
			// 新买的车（后来才出现）不在第一条读数里 ⇒ 它出现时全额计入 ✓。
			const isBaseline = readings === 0;

			const seen = new Set<number>();
			for (const v of r.vehicles) {
				seen.add(v.id);
				if (!origin.has(v.id)) {
					// 新出现的车：基线读数里的车是"上一段历史"（不计本局）；
					// 后来才出现的车，它的读数是它**存在期间**攒下的（本局）⇒ 全额计入。
					accumulated.set(v.id, isBaseline ? 0 : v.profit);
					origin.set(v.id, v.profit);
					continue;
				}
				const prev = origin.get(v.id) ?? v.profit;
				const delta = flip ? 0 : v.profit - prev;
				accumulated.set(v.id, (accumulated.get(v.id) ?? 0) + delta);
				origin.set(v.id, v.profit);
			}

			// 消失的车 = 卖掉了（引擎里车没了）：它的本局利润**留在账上**
			// （卖车不得清零）⇒ 冻结进退役账；卖车那一刻的尾巴没测到 ⇒ 不完整。
			for (const [id, value] of accumulated) {
				if (seen.has(id)) continue;
				retired.set(id, value);
				accumulated.delete(id);
				origin.delete(id);
				complete = false;
			}

			readings++;
			lastRawDate = r.rawDate;
			lastYear = year;
		},

		reading(): OperatingProfitReading {
			return {
				operatingProfit: readings === 0 ? null : sum(accumulated) + sum(retired),
				vehicles: accumulated.size,
				retired: retired.size,
				retiredProfit: sum(retired),
				readings,
				lastRawDate,
				complete,
				yearFlips,
			};
		},
	};
}

/**
 * 每经过一个游戏日的**运营利润**。
 *
 * 缺失不折零：分子未知或分母不是正数 ⇒ `null`（不是 0）。
 * 分母必须是**这一局实际经过的游戏日**（与净现金流读数同源）。
 */
export function operatingProfitPerGameDay(
	operatingProfit: number | null,
	elapsedGameDays: number | null,
): number | null {
	if (operatingProfit === null || !Number.isFinite(operatingProfit)) return null;
	if (elapsedGameDays === null || !Number.isFinite(elapsedGameDays) || elapsedGameDays <= 0) return null;
	return operatingProfit / elapsedGameDays;
}
