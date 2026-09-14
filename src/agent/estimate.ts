/**
 * Route estimation — facts the harness computes so the agent can evaluate an
 * option BEFORE spending money on it.
 *
 * 职责: 纯函数，从城镇坐标计算距离与造价下界。
 * 禁止: 任何"选近的更好"式建议（harness 边界，MEMORY B11）——这里只输出事实，
 *   每个数字都标注它是哪种界。
 *
 * 为什么存在（SPEC §10.34）: agent 只有城镇的 x/y，没有任何距离/造价信号，
 * 于是"按人口取前二"是它唯一能形成的策略——它选了 104 格远的线，200 秒建不完。
 * 距离是事实（给）；偏好是策略（不给）。
 */

/**
 * Road cost per tile, MEASURED on a real game (SPEC §10.25):
 * the phase-1 probe built one road tile in company mode and the company was
 * charged exactly £307 (money 298825 → 298518).
 *
 * Only road is covered. Stations, depots and vehicles cost extra — every total
 * produced here is therefore a LOWER bound, and the tool says so.
 */
export const ROAD_COST_PER_TILE = 307;

/** Manhattan distance in tiles. OpenTTD roads are grid-aligned, so this is the
 * natural straight-line unit; the real laid road is never shorter than it. */
export function manhattanDistance(
	a: { x: number; y: number },
	b: { x: number; y: number },
): number {
	return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export interface RouteEstimate extends Record<string, unknown> {
	fromTown: number;
	toTown: number;
	/** Manhattan tiles between the two town centres. */
	straightTiles: number;
	/** Road-only spend if the line were exactly straight: tiles × £307. */
	roadCostLowerBound: number;
	/** What fraction of the current bank balance the road alone would eat. */
	roadCostShareOfBalance: number | null;
	notes: string[];
}

/**
 * Estimate a route between two towns from facts only.
 *
 * Every number is a bound, and the notes say which kind: the straight line is a
 * lower bound on tiles (terrain and existing buildings only ever make the road
 * longer), so the cost figure inherits that direction. Bank balance comes from
 * the caller's snapshot so the agent can weigh the spend without a second call.
 */
export function estimateRoute(
	from: { id: number; x: number; y: number },
	to: { id: number; x: number; y: number },
	bankBalance: number | null,
): RouteEstimate {
	const straightTiles = manhattanDistance(from, to);
	const roadCostLowerBound = straightTiles * ROAD_COST_PER_TILE;
	const notes = [
		"straight-line (Manhattan) tiles - the real road is never shorter than this",
		"cost covers ROAD ONLY (£307/tile, measured, SPEC §10.25) - stations, depot",
		"and vehicles cost extra, so the true build cost is higher",
	];
	return {
		fromTown: from.id,
		toTown: to.id,
		straightTiles,
		roadCostLowerBound,
		roadCostShareOfBalance:
			bankBalance !== null && bankBalance > 0 ? roadCostLowerBound / bankBalance : null,
		notes,
	};
}
