/**
 * 线路经济（NEXT-2 N2-1）—— GS 上报的原始事实 → 可读事实。
 *
 * 职责: 把 GS 的 route-stats 事件（当年累计利润 + 游戏日期）换算成每日收益，
 *   并提供"只陈述事实"的文本化。派生算术一律留在 TS（可单测），Squirrel 侧
 *   只发原始读数（SPEC §10.45：GS 侧嵌套表/算术怪癖已浪费过一整轮）。
 * 禁止: 任何策略措辞（should/recommend/add more…）——harness 给事实，不给建议；
 *   缺数据时返回 null 而不是 0（0 会被读成"这条线不赚钱"，是编造事实）。
 */

import { dayOfYear as calendarDayOfYear } from "../game/calendar.js";

/** GS 上报的一条线路经济读数（原始事实）。 */
export interface RouteStats {
	job: number;
	/** 当前挂在这条线的车辆数（GS 按站点订单归属统计）。 */
	vehicles: number;
	/** 当年累计利润（Money）；-1 = GS 无法读取该车（非主车）。 */
	profit: number;
	/** 两端站点等待的乘客总数。 */
	waiting: number;
	/** GS 当前游戏日期（天，含年份）。 */
	gameDate: number;
	/**
	 * 这条线的两端**实际站到哪**（GS 的 `StationNear` 结果；-1 = 站还不存在）。
	 *
	 * 为什么需要（2026-09-25 真机）：仪表盘要按站点去重求"等待人数"，而线路账本里记的
	 * 是**标牌格**（tA/tB），不是站点 —— 执行器站点偏移时二者不同（SPEC §10.66 记过
	 * `FindAltSite`）。所以去重要用 GS 看到的站号。
	 */
	endsA?: number;
	endsB?: number;
	/** 逐站等待量（-1 = 该端不是客运站/无站）；`waiting` 是两者之和。 */
	waitA?: number;
	waitB?: number;
	/**
	 * **执行器注册表**里的车辆 id（引擎真值：这条线施工时买下、登记在这条线名下）。
	 *
	 * 与 `vehiclesIds` 是两个不同的事实：那个是"此刻停在两端站上的车"（站点归属，
	 * 会随车离站而变、会被多条线重复计数），这个是"这条线拥有哪些车"（登记归属，
	 * 唯一、稳定、到退役为止）。车队双向/退役的验证就看它（P1-3）。
	 */
	fleetIds?: number[];
	/** 这条线的**目标**车队规模（`set_route_vehicles` 的生效值）；owned = fleetIds.length。 */
	fleetApplied?: number;
	/** P1-2：这条线**改装到的货物**（标签，如 "MAIL"）；缺席 = 未改装/未计量（D60）。 */
	cargoApplied?: string;
	/**
	 * 这条线**天生运的货**（标签：客运线 = "PASS"，货运线 = "COAL"/"GOOD"/…）。
	 *
	 * 与 `cargoApplied`（后来的改装指令的生效值）是**两个事实**：前者是这条线的
	 * 性质（建起来就定了），后者是后来那条 `set_route_cargo` 的结果。
	 * 缺席 = GS 没报（未计量），不是"零"。
	 */
	cargoCarried?: string;
	/**
	 * 货运 F4（A3）：货运线的**两端产业 id**（产方 / 收方）。
	 *
	 * 为什么需要：GS 的 cargo monitor 只知道"本公司往某个产业送了���少"，
	 * **它不知道是哪条线送的** ⇒ 归因需要知道"哪条线服务哪个产业"。
	 * 客运线没有这两个字段（它的两端是城镇）⇒ 缺席 = 不适用，不是 0。
	 */
	fromIndustry?: number;
	toIndustry?: number;
	/** P1-2：这条线的**车型**（引擎 id）；缺席 = 未换车/未计量。 */
	engineApplied?: number;
	/** P1-3：这条线登记车辆中**此刻停在库里**的 id（IsStoppedInDepot，引擎读数）；缺席 = 未计量。 */
	fleetDepot?: number[];
	/**
	 * 停在这条线两端的**车辆 id**。
	 *
	 * 存在的唯一理由是**跨线路去重**：一个车站服务多条线路时，站在站台上的同一辆车会被
	 * 每条用到该站的线路各数一次（真机 17 线 / 9 站 ⇒ 25 辆车被报成 129）。
	 * 有 id 才能在 harness 侧去重；没有它就只能重复计数。
	 */
	vehiclesIds?: number[];
}

/**
 * 报"每日收益"需要的最少样本天数。
 * 年份刚开局时 year-to-date 只有几天，除以 1 会得到 3650/day 这种**由 1 天样本
 * 编出来的年化**——比不报更糟。少于这个天数就只说"还没意义"。
 */
const MIN_INCOME_DAYS = 30;

/**
 * 年内第几天（1..365/366）。
 *
 * 旧的实现是 `gameDate % 365`：那**不是**年内第几天（历法漂移，闰年会偏），
 * 而且分母的年与分子的年**不同步** —— 车辆 YTD 利润在经济年边界归零，而分母
 * 继续累加。现在按引擎的日历算（`src/game/calendar.ts`），分子分母同属一年。
 */
export function dayOfYear(gameDate: number): number {
	return calendarDayOfYear(gameDate);
}

/**
 * 当年累计利润 → 每日收益。
 * 分母是**当年已经过的天数**（年内第几天）；分母用 max(1, day) 避免年初除零。
 * **负利润是事实（亏损线路），照实为负**——首次实现曾把"-1 读不到"与
 * "亏钱"一起归为 null，那是把两种完全不同的世界状态混为一谈（测试第一次就
 * 抓住了）。"未知"只由 **没有车辆** 决定，见 formatRouteStats。
 */
export function incomePerDay(profit: number, gameDate: number): number | null {
	if (!Number.isFinite(profit)) return null;
	const day = calendarDayOfYear(gameDate);
	return profit / Math.max(1, day);
}

/**
 * 事实文本化：只陈述读数，不给结论（断言测试锁定无策略词）。
 * `vehicles === 0` → income 未知：没有车就没有可观测的收益流，
 * 此时报 0 会被读成"这条线不赚钱"——那是编造。
 */
export function formatRouteStats(s: RouteStats): string {
	const day = dayOfYear(s.gameDate);
	// Two DIFFERENT reasons for having no rate, and they must not be conflated:
	// no vehicles (nothing is running) vs a year too young to divide by. The
	// first version reported the second reason for both, which read as a
	// nonsense "year is 116 days old" next to "0 vehicles" in a live run log.
	let rate: string;
	if (s.vehicles === 0) rate = "income unknown (no vehicles on this route yet)";
	else if (day < MIN_INCOME_DAYS) rate = `income not meaningful yet (year is ${day} day(s) old)`;
	else {
		const perDay = incomePerDay(s.profit, s.gameDate);
		// Round to 2 decimals below 1/day: Math.round(-0.03) === -0 renders as
		// "0/day", i.e. a slightly LOSS-making route would read as breaking even.
		rate =
			perDay === null
				? "income unknown"
				: `income ${Math.abs(perDay) >= 1 ? Math.round(perDay) : Number(perDay.toFixed(2))}/day`;
	}
	return `route ${s.job}: ${s.vehicles} vehicles, waiting ${s.waiting}, ${rate} (year-to-date ${s.profit})`;
}

/** 账本行（route-ledger.ts）在本模块需要的最小形状。 */
export interface LedgerPair {
	order:
		| { kind?: "passenger"; job: number; fromTown: number; toTown: number }
		// 货运 F4（A5）：货运线的账本行没有城镇对（它的两端是产业）⇒ 形状**分开**。
		| { kind: "freight"; job: number; fromIndustry: number; toIndustry: number; cargo: string };
}

/**
 * hub 读数 × 账本 pair → 决策上下文用的线路事实（N2-2b）。
 * 账本不知道的 job（模型给了新 job 号、或账本未记录）**不编造 pair**：只给读数。
 */
export function joinRoutesWithLedger(
	stats: RouteStats[],
	ledger: LedgerPair[],
): RouteStatsJoin[] {
	const pairByJob = new Map(ledger.map((l) => [l.order.job, l.order]));
	return [...stats]
		.sort((a, b) => a.job - b.job)
		.map((r) => {
			const pair = pairByJob.get(r.job);
			// 去重字段必须**跟着走**（2026-09-25）：这里曾经逐字段重建对象，
			// 于是 vehiclesIds/endsA/endsB/waitA/waitB 在 join 里被静默丢掉 ——
			// 页面拿不到 id 就只能重复计数（25 辆车报成 129）。
			const out: RouteStatsJoin = {
				job: r.job,
				vehicles: r.vehicles,
				waiting: r.waiting,
				profit: r.profit,
				gameDate: r.gameDate,
				...(r.vehiclesIds !== undefined ? { vehiclesIds: r.vehiclesIds } : {}),
				...(r.endsA !== undefined ? { endsA: r.endsA } : {}),
				...(r.endsB !== undefined ? { endsB: r.endsB } : {}),
				...(r.waitA !== undefined ? { waitA: r.waitA } : {}),
				...(r.waitB !== undefined ? { waitB: r.waitB } : {}),
				// 去重/透传字段必须**跟着走**（2026-09-25 的教训）：这里逐字段
				// 重建对象，漏一个字段它就静默消失（25 辆车报成 129 的同族 bug）。
				...(r.cargoCarried !== undefined ? { cargoCarried: r.cargoCarried } : {}),
				// 货运 F4（A3）：两端产业 id 必须**跟着走**（同一个坑：逐字段重建
				// 对象时漏一个字段，它就静默消失 ⇒ 归因就退化成"猜"）。
				...(r.fromIndustry !== undefined ? { fromIndustry: r.fromIndustry } : {}),
				...(r.toIndustry !== undefined ? { toIndustry: r.toIndustry } : {}),
			};
			if (pair && pair.kind !== "freight") {
				out.townA = pair.fromTown;
				out.townB = pair.toTown;
			}
			return out;
		});
}

/** 线路事实 + 可选 pair（决策上下文与 tool 共用形状）。 */
export interface RouteStatsJoin extends RouteStats {
	townA?: number;
	townB?: number;
}

/** 仪表盘用的线路事实（wire 形状）。算术只在这里做一次，前端不再推导。 */
export interface RouteWireFact {
	job: number;
	vehicles: number;
	waiting: number;
	/** 去重所需（见 RouteStats.vehiclesIds / endsA / endsB / waitA / waitB）。 */
	vehiclesIds?: number[];
	endsA?: number;
	endsB?: number;
	waitA?: number;
	waitB?: number;
	/** 当年累计利润（-1 = GS 读不到该车；此时不要显示"亏损"）。 */
	profitYtd: number;
	/** 每日收益；`null` = 还不可测（年内天数太少，或没有车）。 */
	incomePerDay: number | null;
	townA?: number;
	townB?: number;
	/** 这条线运的货（标签）；缺席 = GS 没报（未计量，不是"没有货"）。 */
	cargoCarried?: string;
	/** 货运 F4（A3）：两端产业 id（产方 / 收方）；缺席 = 客运线（不适用）。 */
	fromIndustry?: number;
	toIndustry?: number;
	/**
	 * 货运 F4（A5）：这条线是**客运**还是**货运**。
	 *
	 * 缺席 = 台账里没有这一条（老数据）⇒ 页面按“不知道”处理，不猜。
	 */
	kind?: "passenger" | "freight";
	/**
	 * 货运 F4（A5）：这条线运了多少（**推导值**）。
	 *
	 * `null` = **归不出来**（多条线共用那个 (货种, 产业)）⇒ 附 `deliveredReason`。
	 * 缺席 = 没有归因读数（**不是** 0）。
	 */
	delivered?: number | null;
	/** 为什么归不出来（`delivered === null` 时有）。 */
	deliveredReason?: string;
}

/**
 * GS 读数 × 账本 → 仪表盘可直接渲染的线路事实。
 *
 * 为什么放在 TS 侧（而不是让页面自己算）：① 算术要能单测；② `null` 与 `0` 的区别
 * 是**事实的区别**（"不可测"≠"不赚钱"），前端不该有机会重新发明这个判断。
 */
export function routeWireFacts(
	stats: RouteStats[],
	ledger: LedgerPair[],
	deliveredByJob?: Map<number, { amount: number | null; reason: string | null }>,
): RouteWireFact[] {
	return joinRoutesWithLedger(stats, ledger).map((r) => {
		const f: RouteWireFact = {
			job: r.job,
			vehicles: r.vehicles,
			waiting: r.waiting,
			profitYtd: r.profit,
			// 两个**不同**的"不可测"原因，不能混为一谈（与 formatRouteStats 同一条规则）：
			// ① 没有车 → 收益流不可观测；② 年内天数太少 → 除以 1 会造出假的年化。
			incomePerDay:
				r.vehicles === 0 || dayOfYear(r.gameDate) < MIN_INCOME_DAYS
					? null
					: incomePerDay(r.profit, r.gameDate),
		};
		if (r.townA !== undefined) f.townA = r.townA;
		if (r.townB !== undefined) f.townB = r.townB;
		if (r.endsA !== undefined) f.endsA = r.endsA;
		if (r.endsB !== undefined) f.endsB = r.endsB;
		if (r.waitA !== undefined) f.waitA = r.waitA;
		if (r.waitB !== undefined) f.waitB = r.waitB;
		if (r.vehiclesIds !== undefined) f.vehiclesIds = r.vehiclesIds;
		if (r.cargoCarried !== undefined) f.cargoCarried = r.cargoCarried;
		if (r.fromIndustry !== undefined) f.fromIndustry = r.fromIndustry;
		if (r.toIndustry !== undefined) f.toIndustry = r.toIndustry;
		// 货运 F4（A5）：这条线是客运还是货运 + 它运了多少（推导值）。
		const order = ledger.find((l) => l.order.job === r.job)?.order;
		if (order?.kind === "freight") {
			f.kind = "freight";
			f.fromIndustry = order.fromIndustry;
			f.toIndustry = order.toIndustry;
		} else if (order?.kind === "passenger") {
			f.kind = "passenger";
		}
		const d = deliveredByJob?.get(r.job);
		if (d) {
			f.delivered = d.amount;
			if (d.reason) f.deliveredReason = d.reason;
		}
		return f;
	});
}

/**
 * FLEET 分解（P1-3 尾巴）：把公司总数**对上**，剩下的一律**具名**。
 *
 * 为什么存在（HARNESS-AUDIT F 系）：仪表盘的车队数字互相矛盾过——站点归属口径
 * 报 129、公司口径报 25。分解后只有一个恒等式：
 *   `owned + unattributed === companyTotal`
 * 并且 owned 再分 `onRoad + inDepot`。任何一项不可得就是 null，不是 0（D60）。
 *
 * 禁止：把 null 参与加法折叠成 0；把差额静默丢掉。
 */
export interface FleetDecomposition {
	/** 引擎总数（company_stats）；null = 未计量。 */
	companyTotal: number | null;
	/** 线路登记的去重车辆数（跨线路同 id 只算一次）。 */
	owned: number;
	/** 登记车辆中停在库里的；null = 未计量（GS 未报 fleetDepot）。 */
	inDepot: number | null;
	/** owned 中在路上的；null = 同上（不是 owned - 0）。 */
	onRoad: number | null;
	/** 公司总数里**不属于任何线路登记**的部分——差额具名；null = 公司总数未知。 */
	unattributed: number | null;
}

export function fleetDecomposition(routes: RouteStats[], companyTotal: number | null): FleetDecomposition {
	const ownedIds = new Set<number>();
	const depotIds = new Set<number>();
	let depotMeasured = false;
	for (const r of routes) {
		for (const id of r.fleetIds ?? []) ownedIds.add(id);
		if (r.fleetDepot !== undefined) {
			depotMeasured = true;
			for (const id of r.fleetDepot) depotIds.add(id);
		}
	}
	const owned = ownedIds.size;
	let inDepot: number | null = null;
	let onRoad: number | null = null;
	if (depotMeasured) {
		// 只有「既登记为线路车、又被报在库里」的才算在库（两个事实的交集）
		let n = 0;
		for (const id of depotIds) if (ownedIds.has(id)) n++;
		inDepot = n;
		onRoad = owned - n;
	}
	return {
		companyTotal,
		owned,
		inDepot,
		onRoad,
		unattributed: companyTotal === null ? null : companyTotal - owned,
	};
}
