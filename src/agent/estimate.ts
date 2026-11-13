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

/**
 * 货运线路的经济学（Issue #105）。
 *
 * 职责: 把**引擎的事实**（每单位货的运价、车型的载量/价格/运行成本）与脚手架
 *   已有的事实（直线格数、路造价下界）算成一条线的收入与成本，**每个数字都带
 *   方向标签**。
 * 禁止: 下结论（"这条线赚钱/不赚钱"）。收入与成本的方向相反，谁也替模型判断
 *   盈亏——那是策略，属模型（docs/RL-HARNESS-SCOPE-AUDIT.md J3）。
 *
 * 方向是怎么定的（引擎事实，见 SPEC §10.126）：
 *   - **距离**：引擎按**曼哈顿距离**付运费，且**封顶在起点与终点的曼哈顿距离**
 *     （`CargoPacket::GetDistance` 的注释与实现）⇒ 直线距离就是引擎付的最大距离，
 *     不是下界。
 *   - **运价**：`GetTransportedGoodsIncome` ∝ 距离 × 时间因子，时间因子随**在途
 *     时间变长而下降**（上限 255）⇒ 用**最快在途**算出来的是**每单位运价的上界**。
 *   - **收入**：一趟 = 载量 × 每单位运价 ⇒ 满载且最快在途 ⇒ **上界**。
 *   - **成本**：运行成本按**经济年**给出且随车龄上涨，路/站/车/车库之外的利息、
 *     折旧都没算 ⇒ **下界**。
 *   ⇒ 收入上界 + 成本下界 ⇒ **盈亏符号不由本工具决定**（除非上界 ≤ 下界）。
 */

/**
 * 引擎的速度单位（km-ish/h）换算成"每天走过的曼哈顿格数"。
 *
 * 推导（OpenTTD 15.3 源码，SPEC §10.126）：
 *   - `GSEngine.GetMaxSpeed` 返回 `Engine::GetDisplayMaxSpeed()`（显示单位）；
 *   - 公路车的显示速度 = 内部速度 / 2 ⇒ 内部速度 = 2 × 显示速度；
 *   - 每 tick 的位移进度 = `GetAdvanceSpeed(spd)` = spd × 3/4（距离单位）；
 *   - 一格直线 = 256 距离单位（`TILE_CORNER_DISTANCE * 2`）；
 *   - 一天 = 74 tick（`Ticks::DAY_TICKS`）。
 *   ⇒ 格/天 = 2 × 速度 × 0.75 / 256 × 74 = 速度 × 0.43359375。
 *
 * 用直线（正交）路线而不是对角线：对角线每步在曼哈顿距离上走得更快 ⇒ 同样的格数
 * 在途更短 ⇒ 时间因子更高 ⇒ 收入更高 ⇒ 正交是**保守**的一边。
 */
export const TILES_PER_DAY_PER_SPEED_UNIT = 0.43359375;

/** 一个经济年的天数（引擎的经济年 = 日历年，365/366）。 */
export const DAYS_PER_ECONOMY_YEAR = 365;

/** 引擎的经济学事实（GS 按需读出；不是周期载荷的一部分）。 */
export interface EngineEconomics {
	id: number;
	name: string;
	/** 最大速度，显示单位（≈km/h）。 */
	speed: number;
	/** 每车的载量（货种单位）。 */
	capacity: number;
	/** 新车价格（Money）。 */
	price: number;
	/** 每**经济年**的运行成本（Money）。 */
	runningCostPerYear: number;
	/** 这个车型主拉的货种标签；null = 引擎没报。 */
	cargo: string | null;
}

/** 一条货运线路在某个车型下的收入与成本（都是估计，带方向）。 */
export interface FreightEngineEconomics {
	id: number;
	name: string;
	capacity: number;
	/** 新车价格（Money）。 */
	price: number;
	/** 每经济年的运行成本（Money）。 */
	runningCostPerYear: number;
	/** 单程在途天数（按最大速度、不含装卸与等待——**假设**）。 */
	transitDays: number;
	/** 每天的往返趟数（上界：不含装卸与等待）。 */
	tripsPerDay: number;
	/** 引擎为这条线付的每单位运价（上界：最快在途）。 */
	incomePerUnit: number;
	/** 满载一趟的收入（上界）。 */
	revenuePerTripUpperBound: number;
	/** 满载时这条线每天的收入（上界）。 */
	revenuePerDayUpperBound: number;
	/** 每车的每天运行成本（下界：车龄会涨）。 */
	operatingCostPerDayLowerBound: number;
	/** 路 + 车（车）的建造成本下界（站与车库另算）。 */
	capexLowerBound: number;
}

export interface FreightEconomics {
	cargo: string;
	/** 直线（曼哈顿）格数 = 引擎付运费的最大距离。 */
	distanceTiles: number;
	/** 引擎为每单位货付的运价（上界）。 */
	incomePerUnit: number;
	/** 能拉这个货的车型，逐个算一遍（**不替模型选**）。 */
	engines: FreightEngineEconomics[];
	/** 每个数字的方向（机器可读）。 */
	bounds: {
		distance: "engine_max_paid_distance";
		incomePerUnit: "upper";
		revenue: "upper";
		operatingCost: "lower";
		capex: "lower";
	};
	notes: string[];
}

/** 单程在途天数（向上取整，至少 1 天）。速度未知 ⇒ null（不编一个数）。 */
export function transitDaysFor(distanceTiles: number, speed: number): number | null {
	if (!Number.isFinite(distanceTiles) || !Number.isFinite(speed) || speed <= 0) return null;
	const tilesPerDay = speed * TILES_PER_DAY_PER_SPEED_UNIT;
	if (tilesPerDay <= 0) return null;
	return Math.max(1, Math.ceil(distanceTiles / tilesPerDay));
}

/**
 * 算一条货运线路的经济学。
 *
 * 纯函数：引擎的事实（`incomePerUnit` 与车型表）由调用方给进来（GS 按需查），
 * 这里只做乘法与方向标注 ⇒ 单测可以在没有游戏的情况下验证方向。
 */
export function estimateFreightEconomics(args: {
	cargo: string;
	distanceTiles: number;
	/** 引擎为每单位货付的运价（GS 用 `GetCargoIncome` 读出，取最快在途）。 */
	incomePerUnit: number;
	engines: EngineEconomics[];
	/** 路造价下界（格数 × 每格实测价）。 */
	roadCostLowerBound: number;
}): FreightEconomics {
	const rows: FreightEngineEconomics[] = args.engines.map((e) => {
		const transitDays = transitDaysFor(args.distanceTiles, e.speed);
		const tripsPerDay = transitDays === null ? 0 : 1 / (2 * transitDays);
		const revenuePerTrip = e.capacity * args.incomePerUnit;
		const revenuePerDay = revenuePerTrip * tripsPerDay;
		const operatingCostPerDay = e.runningCostPerYear / DAYS_PER_ECONOMY_YEAR;
		return {
			id: e.id,
			name: e.name,
			capacity: e.capacity,
			price: e.price,
			runningCostPerYear: e.runningCostPerYear,
			transitDays: transitDays ?? 0,
			tripsPerDay,
			incomePerUnit: args.incomePerUnit,
			revenuePerTripUpperBound: revenuePerTrip,
			revenuePerDayUpperBound: revenuePerDay,
			operatingCostPerDayLowerBound: operatingCostPerDay,
			capexLowerBound: args.roadCostLowerBound + e.price,
		};
	});
	const notes = [
		"distance = straight-line (Manhattan) tiles; the engine pays for the Manhattan",
		"distance between source and destination and caps it there, so this IS the",
		"maximum distance the line can be paid for",
		"income per unit = the engine's rate at the FASTEST possible transit - a slower",
		"real transit (waiting, loading) earns less, so revenue is an UPPER bound",
		"revenue assumes a FULL load on every trip - the real line rarely has one",
		"operating cost is a LOWER bound: a vehicle's running cost grows with age, and",
		"interest, depreciation, stations and the depot are not in these numbers",
		"this tool does not say whether the line pays off - weigh the numbers yourself",
	];
	return {
		cargo: args.cargo,
		distanceTiles: args.distanceTiles,
		incomePerUnit: args.incomePerUnit,
		engines: rows,
		bounds: {
			distance: "engine_max_paid_distance",
			incomePerUnit: "upper",
			revenue: "upper",
			operatingCost: "lower",
			capex: "lower",
		},
		notes,
	};
}
