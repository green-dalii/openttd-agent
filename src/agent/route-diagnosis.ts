/**
 * 线路诊断（Issue #113）：把 GS 的**事实**翻译成**具名原因**。
 *
 * 职责: 只做"事实 → 原因"的映射，**只读**、**不猜**。
 *   - 输入: GS 的 `route_diag` 答案（车在哪、订单是什么、能不能装这个货、两端在等多少）。
 *   - 输出: 一个**封闭词表**里的原因（或"没有发现原因"）。
 *
 * 为什么在服务端算（而不是 GS 或前端）：
 *   - GS 只报事实（它不知道"这条线算不算死"）；
 *   - 前端不许做判定（"显示结论来自服务端"）；
 *   - 纯函数能单测 ⇒ 词表不会悄悄漂。
 *
 * 为什么需要它：真机（2026-11-11，seed 4242，COAL 46→53）出现"线建成了、
 * 车改装了、装货站有 303 单位在等、整局交付 0"的**静默死线**：周期读数只报
 * "几辆车在等多少"⇒ 模型与人都看不出**卡在哪** ⇒ 只能瞎猜。
 */

/** 一辆车的事实（GS 的 `route_diag` 原样）。 */
export interface RouteDiagVehicle {
	id: number;
	valid?: boolean;
	/** 引擎的车辆状态（0=运行 1=停 2=在库 3=撞毁 …）。 */
	state?: number;
	/** 车所在的瓦片。 */
	tile?: number;
	/** 车上装了多少（这个货种）。 */
	loaded?: number;
	/** 车**此刻**装这个货种的载量（货种不对 ⇒ 0）。 */
	capacity?: number;
	/** 改成这个货种**能**有多少（引擎行不行）。 */
	refitCapacity?: number;
	/** 当前速度（0 = 停着：装货中 / 卡住）。 */
	speed?: number;
	/** **多久没动了**（游戏 tick；null = 没测到）。0 = 刚动过。 */
	idleTicks?: number;
	/** 订单条数。 */
	orderCount?: number;
	orders?: { index?: number; tile?: number; isStation?: boolean; flags?: number }[];
}

/** 一端的事实（装货侧 / 卸货侧）。 */
export interface RouteDiagEnd {
	role?: string;
	/** 登记的瓦片（车站的标牌格）。 */
	tile?: number;
	/** **门前格**（路旁格）——**车停在这里**，不是标牌格。 */
	roadTile?: number;
	/** **真的在那儿**的车站 id（-1 = 没找到）。 */
	station?: number;
	/** 这端在等多少（-1 = 没测到）。 */
	waiting?: number;
	/**
	 * 这端的货里，有多少是**计划经由另一端运走**的（-1 = 没测到）。
	 *
	 * 为什么关键：引擎按**下一跳**装货（`StationCargoList::Load` 只取下一跳是
	 * "车的下一站"的包）⇒ "货在等"与"这条线能运走它"**是两件事**。
	 */
	waitingVia?: number;
	/**
	 * 这端的货里，有多少是**没有下一跳**的（-1 = 没测到）。
	 *
	 * 为什么关键：引擎按**下一跳**装货，但"没有下一跳"的货**兜底给任何车**
	 * ⇒ "货没有下一跳"**不是**运不走的原因（真机实测：290 单位的煤全在这一桶，
	 * 而车还是装不上）⇒ 不能拿"没经由另一端"就判它是原因。
	 */
	waitingViaNone?: number;
	/** 这端的货里，有多少是**下一跳就是自己**的（-1 = 没测到）。 */
	waitingViaSelf?: number;
}

/** 一条线的全部事实。 */
export interface RouteDiagRoute {
	job: number;
	cargo?: string;
	ends?: RouteDiagEnd[];
	/** 两端之间路是否连通（null = 没测到）。 */
	roadConnected?: boolean | null;
	vehicles?: RouteDiagVehicle[];
}

/**
 * 具名原因的**封闭词表**（新增一个词要同时改这里与它的单测）。
 *
 * 词表是"诊断结论"，不是"猜测"：每个词都能由上面的事实**判定**。
 */
export const ROUTE_DIAGNOSIS_REASONS = [
	/** 这条线根本没有记录（没建 / 建失败了）。 */
	"no_route_record",
	/** 线建了，但没有车（还没买车，或车被卖了）。 */
	"no_vehicles",
	/** 车有订单数但订单是 0 ⇒ 它没有路线，永远不会到站。 */
	"no_orders",
	/** 车有订单，但订单**不是**"去某个站" ⇒ 它不会停站，也就不会装货。 */
	"orders_not_station",
	/** 两端之间路不连通 ⇒ 车到不了装货站。 */
	"road_not_connected",
	/** 车**装不了**这条线的货（引擎就不行）⇒ 永远装不上。 */
	"engine_cannot_carry_cargo",
	/** 车**此刻**的货种不是这条线的货（引擎行，但改装没生效）⇒ 它是辆客车，
	 *  只会找公交站 ⇒ 永远装不上。 */
	"vehicle_not_refitted_to_cargo",
	/**
	 * 装货站的货**不是计划经由这条线的卸货站运走**的 ⇒ 引擎只让"下一跳是
	 * 车的下一站"的车装它 ⇒ 这条线永远装不上这批货（货在等 ≠ 这条线能运走它）。
	 */
	"cargo_not_planned_via_this_line",
	/** 车到了装货站、货在等、它也装得了 ⇒ 它在站上却**不装**（引擎不让它装）。 */
	"at_loading_end_but_not_loaded",
	/** 车**很久没动**了（引擎 tick）⇒ 它被卡住（路断/堵/到不了），不是"在装货"。 */
	"vehicle_not_moving",
	/** 装货端没有货在等 ⇒ 没东西可运（不是故障）。 */
	"no_cargo_waiting",
	/** 没发现原因（事实不足以判定故障）。 */
	"no_fault_found",
] as const;

export type RouteDiagnosisReason = (typeof ROUTE_DIAGNOSIS_REASONS)[number];

/** 一次诊断的结论。 */
export interface RouteDiagnosis {
	job: number;
	/** 具名原因（封闭词表）。 */
	reason: RouteDiagnosisReason;
	/** 一句人话（给模型看的）。 */
	detail: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 车"多久没动"才算卡住（游戏 tick）。
 *
 * 阈值怎么来的：OpenTTD 一天 = 74 tick（`Ticks::DAY_TICKS`）⇒ 300 tick ≈ 4 游戏日。
 * 4 天还没动 ⇒ 它不是在"慢慢挪"，它是被卡住了（路断/堵/到不了）。
 */
export const IDLE_TICKS = 300;

function endOf(route: RouteDiagRoute, role: string): RouteDiagEnd | undefined {
	return (route.ends ?? []).find((e) => e.role === role);
}

/**
 * 诊断一条线为什么不动。
 *
 * 判定顺序 = **从最硬的事实到最软的**：先看"有没有线/车/订单"，再看"路通不通"，
 * 再看"车装不装得了这个货"，最后才看"它在站上却没装"。
 *
 * 每一档都只依据**事实**，没有事实就说"没测到"，不猜。
 */
export function diagnoseRoute(route: RouteDiagRoute): RouteDiagnosis {
	const job = route.job;
	const vehicles = (route.vehicles ?? []).filter((v) => v.valid !== false);
	const loadEnd = endOf(route, "load");
	const cargo = route.cargo && route.cargo !== "" ? route.cargo : "this cargo";

	if (vehicles.length === 0) {
		return {
			job,
			reason: "no_vehicles",
			detail: `route ${job} has no vehicles, so nothing can move (it may not be finished yet)`,
		};
	}

	// 订单：没有订单 ⇒ 车没有路线；有订单但不是车站 ⇒ 它不会停站。
	for (const v of vehicles) {
		if (!isNum(v.orderCount)) continue;
		if (v.orderCount <= 0) {
			return {
				job,
				reason: "no_orders",
				detail: `vehicle ${v.id} on route ${job} has no orders, so it has nowhere to go`,
			};
		}
	}
	for (const v of vehicles) {
		const orders = v.orders ?? [];
		if (orders.length === 0) continue;
		if (!orders.some((o) => o.isStation === true)) {
			return {
				job,
				reason: "orders_not_station",
				detail:
					`vehicle ${v.id} on route ${job} has ${orders.length} order(s) but none of them ` +
					"goes to a station, so it will never stop to load or unload",
			};
		}
	}

	// 路：两端之间不连通 ⇒ 车到不了装货站。
	if (route.roadConnected === false) {
		return {
			job,
			reason: "road_not_connected",
			detail: `the road between the two ends of route ${job} is not connected, so no vehicle can reach the loading end`,
		};
	}

	// 货种：车装不了 / 没被改成这条线的货 ⇒ 它永远装不上。
	for (const v of vehicles) {
		if (isNum(v.capacity) && v.capacity <= 0 && isNum(v.refitCapacity) && v.refitCapacity > 0) {
			return {
				job,
				reason: "vehicle_not_refitted_to_cargo",
				detail:
					`vehicle ${v.id} on route ${job} carries ${v.refitCapacity} unit(s) of ${cargo} when refitted, ` +
					`but its current cargo type is something else (capacity 0): it was never refitted to ${cargo}`,
			};
		}
	}
	for (const v of vehicles) {
		if (isNum(v.capacity) && v.capacity <= 0 && isNum(v.refitCapacity) && v.refitCapacity <= 0) {
			return {
				job,
				reason: "engine_cannot_carry_cargo",
				detail: `vehicle ${v.id} on route ${job} cannot carry ${cargo} at all (its engine does not take it)`,
			};
		}
	}

	// 车**没动**：这是最根本的一档（路断/堵/到不了 ⇒ 别的都不用谈）。
	const stuck = vehicles.find((v) => isNum(v.idleTicks) && v.idleTicks > IDLE_TICKS);
	if (stuck) {
		return {
			job,
			reason: "vehicle_not_moving",
			detail:
				`vehicle ${stuck.id} on route ${job} has not moved for ${stuck.idleTicks} game tick(s): ` +
				"it is stuck, so nothing can be picked up or delivered",
		};
	}

	// 流向：装货站的货**是不是计划经由我们的卸货站运走**。
	// 不是 ⇒ 引擎不会让这条线的车装它（"下一跳"不匹配）⇒ 等多久都没用。
	const waiting = isNum(loadEnd?.waiting) ? loadEnd.waiting : null;
	const waitingVia = isNum(loadEnd?.waitingVia) ? loadEnd.waitingVia : null;
	const waitingViaNone = isNum(loadEnd?.waitingViaNone) ? loadEnd.waitingViaNone : null;
	const waitingViaSelf = isNum(loadEnd?.waitingViaSelf) ? loadEnd.waitingViaSelf : null;
	// 流向问题只在**货明确被路由到别的站**时成立：货"没有下一跳"⇒ 引擎兜底给
	// 任何车（真机实测：290 单位的煤全在"无下一跳"那一桶，车照样装不上）⇒
	// "没经由另一端"**不能**当成原因。
	const routedElsewhere =
		waitingVia !== null &&
		waitingVia === 0 &&
		waitingViaNone === 0 &&
		waitingViaSelf === 0;
	if (waiting !== null && waiting > 0 && routedElsewhere) {
		return {
			job,
			reason: "cargo_not_planned_via_this_line",
			detail:
				`${waiting} unit(s) of ${cargo} wait at the loading end of route ${job}, and all of them are ` +
				"routed to another station instead of via this route's unloading end: the game will not let " +
				"this line's vehicles take them",
		};
	}

	if (waiting !== null && waiting > 0) {
		for (const v of vehicles) {
			// 车**停**在装货站：它停的是**门前格**（路旁格），不是标牌格。
			const atLoadEnd =
				isNum(v.tile) &&
				(loadEnd?.roadTile === v.tile || loadEnd?.tile === v.tile || loadEnd?.station === v.tile);
			if (!atLoadEnd) continue;
			if (isNum(v.loaded) && v.loaded <= 0) {
				const moving = isNum(v.speed) && v.speed > 0 ? " and it is still moving" : "";
				return {
					job,
					reason: "at_loading_end_but_not_loaded",
					detail:
						`vehicle ${v.id} is at the loading end of route ${job} where ${waiting} unit(s) of ${cargo} ` +
						`are waiting, but it carries none${moving}: the game will not let it load here`,
				};
			}
		}
	}

	if (waiting === 0) {
		return {
			job,
			reason: "no_cargo_waiting",
			detail: `nothing is waiting at the loading end of route ${job}, so there is nothing to carry yet`,
		};
	}

	return {
		job,
		reason: "no_fault_found",
		detail: `no fault found for route ${job}: its vehicles have station orders and can carry ${cargo}`,
	};
}

/**
 * 诊断一批线（GS 的答案形状 ⇒ 结论）。
 *
 * 没有线 ⇒ 不编原因：那是"这条线还不存在"，不是"线坏了"。
 */
export function diagnoseRoutes(routes: RouteDiagRoute[]): RouteDiagnosis[] {
	return routes.map((r) => diagnoseRoute(r));
}
