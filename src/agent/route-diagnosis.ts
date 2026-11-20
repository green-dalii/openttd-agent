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
	/**
	 * 这一端**收不收**这个货（引擎按 catchment 算；>= 8 = 收）。
	 * null = 没测到。
	 *
	 * 为什么关键：卸货时引擎先看车站**是否收货**（`station_cmd.cpp`：
	 * `GoodsEntry::State::Acceptance`）⇒ 不收货就把货**留在车上**
	 * ⇒ “车到了卸货站却没卸”与“货没送到”是两件事。
	 */
	acceptanceAroundTile?: number | null;
	/**
	 * 这一端对这个货的**车站评分**（-1 = 引擎没给评分：车站还没收过这个货）。
	 *
	 * 为什么关键：产业把货交给车站看的是**评分**（`CanMoveGoodsToStation`：
	 * 评分 0 才拒收）⇒ 装货侧评分 0 = 产业不再交货（车等不到货）。
	 */
	cargoRating?: number | null;
	/** 站牌格有几条相邻的路（0 = 车根本开不上去）。null = 没测到。 */
	stationNeighbourRoads?: number | null;
	/** 引擎自己说的**入口格**（车从这边开过来才会停）；-1 = 没测到。 */
	engineFrontTile?: number;
	/** 站牌格是不是公路车站（false = 不是 ⇒ 车不会停）。null = 没测到。 */
	stationIsRoadStation?: boolean | null;
	/** 是不是**穿行式**停靠点（停靠规则完全不同）。null = 没测到。 */
	stationIsDriveThrough?: boolean | null;
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
	 * 这条线上**没有一辆车**装着这个货（它们的货种是别的东西），而
	 * "引擎到底能不能装这个货"**在这里读不到** ⇒ 这条线运不了这个货，
	 * 但**是哪种原因不可判定**（没改装？还是引擎压根不行？引擎不答）。
	 *
	 * 为什么单列一个词：把"读不到"塞进"没改装"或"引擎不行"都是**编造**；
	 * 而"没找到故障"同样不成立（这条线确实运不了）。⇒ 事实是什么就说什么。
	 */
	"vehicles_do_not_carry_this_cargo",
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
	/**
	 * 卸货端**不收**这个货（收货额度 < 8）⇒ 引擎把货**留在车上**
	 * ⇒ 车到了卸货站也卸不下来 ⇒ 这条线永远不产生交付。
	 */
	"unloading_end_does_not_accept_cargo",
	/**
	 * 装货端的**车站评分是 0** ⇒ 产业不再往这个站交货
	 * （引擎：`CanMoveGoodsToStation` 评分 0 才拒收）⇒ 车等不到货。
	 */
	"loading_end_rating_zero",
	/** 站牌格**没有相邻的路** ⇒ 车开不上去 ⇒ 它永远不会在站上停。 */
	"stop_has_no_road_connection",
	/** 没发现原因（事实不足以判定故障）。 */
	"no_fault_found",
] as const;

export type RouteDiagnosisReason = (typeof ROUTE_DIAGNOSIS_REASONS)[number];

/**
 * 每个具名原因的**规范英文说法**（服务端拥有措辞，B5）。
 *
 * 为什么在服务端：前端按 id 翻（`I18nTerms`），**英文回落的是这里这份**
 * ⇒ 一个 code 只有一份规范措辞（前端不另抄一份英文 ⇒ 不会悄悄漂）。
 */
export const ROUTE_DIAGNOSIS_LABELS: Record<RouteDiagnosisReason, string> = {
	no_route_record: "this line has no record (it was never built, or the build failed)",
	no_vehicles: "this line has no vehicles (none were bought yet, or they were sold)",
	no_orders: "the vehicle has no orders, so it has nowhere to go",
	orders_not_station: "the orders do not go to a station, so it never stops to load or unload",
	road_not_connected: "the road between the two ends is not connected",
	engine_cannot_carry_cargo: "the engine cannot carry this cargo at all",
	vehicle_not_refitted_to_cargo: "the vehicle was never refitted to this cargo",
	vehicles_do_not_carry_this_cargo: "no vehicle on this line carries this cargo",
	cargo_not_planned_via_this_line: "the waiting cargo is planned to leave via another station",
	at_loading_end_but_not_loaded: "the vehicle is at the loading end with cargo waiting, and does not load",
	vehicle_not_moving: "the vehicle has not moved for a long time",
	no_cargo_waiting: "no cargo is waiting at the loading end",
	unloading_end_does_not_accept_cargo: "the unloading end does not accept this cargo",
	loading_end_rating_zero: "the loading end's station rating for this cargo is 0",
	stop_has_no_road_connection: "the station has no road next to it",
	no_fault_found: "no fault found",
};

/** 一次诊断的结论。 */
export interface RouteDiagnosis {
	job: number;
	/** 具名原因（封闭词表）。 */
	reason: RouteDiagnosisReason;
	/** 原因的**规范英文说法**（服务端措辞；前端按 id 翻，没翻时用它）。 */
	label: string;
	/** 一句人话（给模型看的）。 */
	detail: string;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * 车"此刻装这个货种的载量"**读得到吗**（`GetCapacity`）。
 *
 * 语义（OpenTTD 源码 `script_vehicle.cpp`）：它只累加**货种正好是这个**
 * 的那部分的载量 ⇒ 载量 0 = **这辆车此刻装的不是这个货**（不是"引擎不行"）。
 * -1 = 没测到（`GetCapacity` 对无效车辆返回 -1）。
 */
function capacityKnown(v: RouteDiagVehicle): boolean {
	return isNum(v.capacity) && v.capacity >= 0;
}

/** 这辆车此刻**一点都装不了**这个货（载量 0 = 货种不是它）。 */
function carriesNone(v: RouteDiagVehicle): boolean {
	return capacityKnown(v) && v.capacity === 0;
}

/**
 * "改成这个货种**能**有多少"（`GetRefitCapacity`）——**只有停在库里的车读得到**
 * （引擎前置条件："you must own the vehicle; the vehicle must be stopped in
 * the depot"）。读不到时 OpenTTD 15.x 回 **4294967295**（UINT32_MAX）：那是
 * `res.Succeeded() ? refit_capacity : -1` 的有符号/无符号转换的副产品
 * （OpenTTD PR #15507）⇒ **失败哨兵，不是载量**。
 *
 * 所以可信的读数 = 一个在常识范围内的非负整数；其余一律"没测到"（null）。
 */
const MAX_PLAUSIBLE_CAPACITY = 1_000_000;
function trustedRefitCapacity(v: RouteDiagVehicle): number | null {
	if (!isNum(v.refitCapacity)) return null;
	if (v.refitCapacity < 0 || v.refitCapacity > MAX_PLAUSIBLE_CAPACITY) return null;
	return v.refitCapacity;
}

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
 * 诊断一条线为什么不动（内部实现；对外的 `diagnoseRoute` 补上规范措辞）。
 *
 * 判定顺序 = **从最硬的事实到最软的**：先看"有没有线/车/订单"，再看"路通不通"，
 * 再看"车装不装得了这个货"，最后才看"它在站上却没装"。
 *
 * 每一档都只依据**事实**，没有事实就说"没测到"，不猜。
 */
function diagnoseRouteInner(route: RouteDiagRoute): Omit<RouteDiagnosis, "label"> {
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
	//
	// **读数可信度**：`refitCapacity` 只对**停在库里的车**读得到（引擎前置），
	// 读不到时引擎回 4294967295（失败哨兵）⇒ 那时**不能**下"没改装"的结论
	// （真机 2026-11-18：所有车都在路上 ⇒ 全部读成哨兵 ⇒ 一条活着的线被判成
	// "车没被改装"）。
	for (const v of vehicles) {
		const refit = trustedRefitCapacity(v);
		if (refit === null) continue;
		if (carriesNone(v) && refit > 0) {
			return {
				job,
				reason: "vehicle_not_refitted_to_cargo",
				detail:
					`vehicle ${v.id} on route ${job} would carry ${refit} unit(s) of ${cargo} when refitted, ` +
					`but it carries none right now (its cargo type is something else): it was never refitted to ${cargo}`,
			};
		}
	}
	for (const v of vehicles) {
		const refit = trustedRefitCapacity(v);
		if (refit === null) continue;
		if (carriesNone(v) && refit === 0) {
			return {
				job,
				reason: "engine_cannot_carry_cargo",
				detail: `vehicle ${v.id} on route ${job} cannot carry ${cargo} at all (its engine does not take it)`,
			};
		}
	}

	// 没有一辆车装着这个货，**而**"引擎能不能装"在这里读不到（改装载量只对
	// 停在库里的车可读）⇒ 这条线运不了这个货，但**是哪种原因不可判定**。
	if (vehicles.length > 0 && vehicles.every((v) => carriesNone(v))) {
		return {
			job,
			reason: "vehicles_do_not_carry_this_cargo",
			detail:
				`none of the ${vehicles.length} vehicle(s) on route ${job} carries ${cargo} right now (their cargo ` +
				`type is something else), and the game does not report what they would carry if refitted (it only ` +
				"answers that for a vehicle stopped in a depot) ⇒ whether their engines could carry it at all is " +
				"not measurable here",
		};
	}

	// 车站本身能不能收货/交货（**引擎按 catchment 算的事实**）。
	//
	// 顺序：先看**卸货端收不收**（不收 ⇒ 车到了也卸不下来 ⇒ 永远没有交付），
	// 再看**装货端评分**（评分为 0 ⇒ 产业不再交货 ⇒ 车等不到货）。
	const unloadEnd = endOf(route, "unload");
	const unloadAcceptance = isNum(unloadEnd?.acceptanceAroundTile) ? unloadEnd.acceptanceAroundTile : null;
	if (unloadAcceptance !== null && unloadAcceptance < 8) {
		return {
			job,
			reason: "unloading_end_does_not_accept_cargo",
			detail:
				`the unloading end of route ${job} accepts ${unloadAcceptance} unit(s) of ${cargo} (the game ` +
				"needs 8): it does not accept this cargo, so the game keeps the load on the vehicle and nothing " +
				"is ever delivered",
		};
	}
	const loadRating = isNum(loadEnd?.cargoRating) ? loadEnd.cargoRating : null;
	// 评分 0 = 车站“满了”（引擎：`CanMoveGoodsToStation` 评分 0 才拒收）
	// ⇒ 产业不再交货。评分 -1 = 引擎**没给评分**（这个站还没收过这种货）
	// ⇒ 那是“没测到”，不是“产业不交货”。
	if (loadRating === 0) {
		return {
			job,
			reason: "loading_end_rating_zero",
			detail:
				`the loading end of route ${job} has a station rating of ${loadRating} for ${cargo}: the industry ` +
				"will not hand over any more cargo to it, so the vehicles have nothing to pick up",
		};
	}
	// 站牌格没有相邻的路 ⇒ 车开不上去（它永远不会在站上停）。
	for (const e of route.ends ?? []) {
		if (!isNum(e.stationNeighbourRoads)) continue;
		if (e.stationNeighbourRoads <= 0) {
			return {
				job,
				reason: "stop_has_no_road_connection",
				detail:
					`the ${e.role} end of route ${job} has no road next to its station tile: vehicles cannot ` +
					"drive onto it, so they never stop there",
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

	// 观察（不是原因）：有的车此刻一点都装不了这个货 —— 但别的车装着 ⇒
	// 这条线**能**运 ⇒ 如实说出来，不当成故障（由外层补上）。
	return {
		job,
		reason: "no_fault_found",
		detail: `no fault found for route ${job}: its vehicles have station orders and none of the fault checks fired`,
	};
}

/** 这条线运的货（读不到就说"这个货"）。 */
function cargoLabel(route: RouteDiagRoute): string {
	return route.cargo && route.cargo !== "" ? route.cargo : "this cargo";
}

/**
 * 诊断一条线为什么不动（对外入口）。
 *
 * 规范措辞（label）在这里补上：诊断的**每个**出口都要带它 ⇒ 只有一处
 * （`ROUTE_DIAGNOSIS_LABELS`）能改措辞。
 *
 * 顺带补一条**观察**：有的车此刻一点都装不了这个货。这是事实，但**不是**
 * 这条线不动的**原因**（别的车装着 ⇒ 线能运）⇒ 只说出来，不改判原因。
 */
export function diagnoseRoute(route: RouteDiagRoute): RouteDiagnosis {
	const d = diagnoseRouteInner(route);
	const noneIds = (route.vehicles ?? [])
		.filter((v) => v.valid !== false && carriesNone(v))
		.map((v) => v.id);
	const alreadySaid =
		d.reason === "vehicle_not_refitted_to_cargo" ||
		d.reason === "engine_cannot_carry_cargo" ||
		d.reason === "vehicles_do_not_carry_this_cargo";
	const note =
		noneIds.length > 0 && !alreadySaid
			? `; vehicle ${noneIds.join(", ")} on this route carr${noneIds.length > 1 ? "y" : "ies"} no ${cargoLabel(route)} at all (its cargo type is something else)`
			: "";
	return {
		...d,
		label: ROUTE_DIAGNOSIS_LABELS[d.reason],
		detail: d.detail + note,
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
