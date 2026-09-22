/**
 * 线路经济（NEXT-2 N2-1）—— GS 上报的原始事实 → 可读事实。
 *
 * 职责: 把 GS 的 route-stats 事件（当年累计利润 + 游戏日期）换算成每日收益，
 *   并提供"只陈述事实"的文本化。派生算术一律留在 TS（可单测），Squirrel 侧
 *   只发原始读数（SPEC §10.45：GS 侧嵌套表/算术怪癖已浪费过一整轮）。
 * 禁止: 任何策略措辞（should/recommend/add more…）——harness 给事实，不给建议；
 *   缺数据时返回 null 而不是 0（0 会被读成"这条线不赚钱"，是编造事实）。
 */

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
}

/** OpenTTD 一年 365 天（闰年不做特殊处理，误差 ≤0.3%，如实标注不假装精确）。 */
const DAYS_PER_YEAR = 365;

/**
 * 报"每日收益"需要的最少样本天数。
 * 年份刚开局时 year-to-date 只有几天，除以 1 会得到 3650/day 这种**由 1 天样本
 * 编出来的年化**——比不报更糟。少于这个天数就只说"还没意义"。
 */
const MIN_INCOME_DAYS = 30;

/** 年内第几天（0..364），与 incomePerDay 用同一约定。 */
export function dayOfYear(gameDate: number): number {
	const d = Math.trunc(gameDate);
	return ((d % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
}

/**
 * 当年累计利润 → 每日收益。
 * `gameDate % 365` = 年内第几天；分母用 max(1, day) 避免年初除零。
 * **负利润是事实（亏损线路），照实为负**——首次实现曾把"-1 读不到"与
 * "亏钱"一起归为 null，那是把两种完全不同的世界状态混为一谈（测试第一次就
 * 抓住了）。"未知"只由 **没有车辆** 决定，见 formatRouteStats。
 */
export function incomePerDay(profit: number, gameDate: number): number | null {
	if (!Number.isFinite(profit)) return null;
	const day = ((Math.trunc(gameDate) % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
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
	order: { job: number; fromTown: number; toTown: number };
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
			const out: RouteStatsJoin = {
				job: r.job,
				vehicles: r.vehicles,
				waiting: r.waiting,
				profit: r.profit,
				gameDate: r.gameDate,
			};
			if (pair) {
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
	/** 当年累计利润（-1 = GS 读不到该车；此时不要显示"亏损"）。 */
	profitYtd: number;
	/** 每日收益；`null` = 还不可测（年内天数太少，或没有车）。 */
	incomePerDay: number | null;
	townA?: number;
	townB?: number;
}

/**
 * GS 读数 × 账本 → 仪表盘可直接渲染的线路事实。
 *
 * 为什么放在 TS 侧（而不是让页面自己算）：① 算术要能单测；② `null` 与 `0` 的区别
 * 是**事实的区别**（"不可测"≠"不赚钱"），前端不该有机会重新发明这个判断。
 */
export function routeWireFacts(stats: RouteStats[], ledger: LedgerPair[]): RouteWireFact[] {
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
		return f;
	});
}
