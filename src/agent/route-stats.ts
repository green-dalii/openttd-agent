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
	const perDay = s.vehicles > 0 ? incomePerDay(s.profit, s.gameDate) : null;
	const rate = perDay === null ? "income unknown" : `income ${Math.round(perDay)}/day`;
	return `route ${s.job}: ${s.vehicles} vehicles, waiting ${s.waiting}, ${rate} (year-to-date ${s.profit})`;
}
