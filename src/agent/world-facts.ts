/**
 * Canonical world projection — the single source of truth for world facts (D2 / S2).
 *
 * 职责: 把世界状态投影成**模型可见的事实**，只投影一次、全项目共用。
 * 为什么存在: 决策上下文与 `observe()` 以前各自投影一遍，于是同一批事实有两种
 *   形状、两种排序（人口降序 vs 地图顺序）——模型看到"城镇表"两次，且分不清哪个
 *   是权威（契约 §2.1 铁律 O1/O3）。**一个事实一处真值、一处顺序**。
 * 铁律:
 *   - 缺失 = `null`，绝不折成 0（D60）。
 *   - 排序确定：公司按 id；城镇按人口降序（缺失人口排最后），同人口按 id 升序。
 *   - 审计侧的显示字段（name/isAi）与事件计数是**另一层**（`auditState`），
 *     不混进模型可见的投影。
 * 禁止: 在此加评价、建议或"应该"（harness 边界 J2）。
 *
 * 2026-10-30（真实模型局 20261030-213248-seed4242 后）：补上**管道里本来就有、
 *   但投影丢掉了**的几类事实——产业与货种总量、车型目录、城镇名字。模型自己
 *   说过"observe 输出没有 cargo 标签和车型表（看起来被截断了）"，随后因为
 *   看不见任何货物而建了客运线 ⇒ 分数（货物吨数）读 0。事实来源见 SPEC §10.124。
 */

import type { CompanyState, WorldEventFact, WorldSnapshot } from "../game/world-state.js";
import { observationShapeHash as observationShapeHashOf } from "./observation-shape.js";

/** One company's comparable numbers (model-visible). */
export interface CompanyFact {
	id: number;
	money: number | null;
	loan: number | null;
	income: number | null;
	vehicles: number | null;
	stations: number | null;
}

/** One candidate town (model-visible). */
export interface TownFact {
	id: number;
	/** Population; null when unknown (缺失 ≠ 0). */
	pop: number | null;
	/**
	 * 城镇**名字**（GS 用 `GSTown.GetName` 报，2026-09-25 真机验证）。
	 *
	 * null = 该局没收到名字（旧 GS 或该镇没有名字）——**不是** id 字符串：
	 * 把 id 写成名字是编造（而 `#4 → #8` 正是模型看不懂线路的根因）。
	 */
	name: string | null;
	x: number;
	y: number;
}

/**
 * 一个产业（模型可见）：货从哪儿来。
 *
 * 只有 GS 取样的前 12 个（按产量降序）；`industriesTotal` 是全图总数。
 * 缺失的读数是 `null`（D60：GS 的 `-1` = 不适用，**不是** 0）。
 */
export interface IndustryFact {
	id: number;
	/** 货种标签（稳定，如 "COAL"）——不用本地化名。 */
	cargo: string;
	/** 产业名；空串 = 引擎没报名字（不是 id 字符串）。 */
	name: string;
	/** 上月产量；null = 未测到/不适用。 */
	produced: number | null;
	/** 上月运量；null = 未测到/不适用。 */
	transported: number | null;
	/** 库存；null = 该产业不接受此货/未测到。 */
	stock: number | null;
}

/**
 * 一个产业在地图上的**位置与名字**（模型可见）。
 *
 * 为什么模型需要它（货运 F1）：一条货运线路就是"**哪座矿 → 哪座厂**"，
 * 而"哪儿"是坐标。没有坐标，模型只能看见一堆 id 与产量 —— 它没法选线路。
 */
export interface IndustrySiteFact {
	id: number;
	/** 产业名；空串 = 引擎没报名字（不是 id 字符串）。 */
	name: string;
	x: number;
	y: number;
}

/**
 * 货种目录（模型可见）：这个货**是不是货运**、谁产、谁收。
 *
 * 为什么是事实而不是模型的功课（货运 F1）：车站收什么货由**引擎**按集货区算
 * （真机探针：矿场旁的车站**不接受煤**，电站旁的才接受）⇒ 模型看得见"哪里有煤"，
 * 却看不见"谁要煤"，就只能猜。
 */
export interface CargoCatalogFact {
	/** 货种标签（稳定，如 "COAL"）。 */
	label: string;
	/** 引擎口径：这是不是货运货（`GSCargo.IsFreight`）。 */
	freight: boolean;
	/** 生产这个货的产业 id（`GSIndustryList_CargoProducing`）。 */
	producers: number[];
	/** 接受这个货的产业 id（`GSIndustryList_CargoAccepting`）。 */
	consumers: number[];
}

/**
 * 一条货运**可运链路**（模型可见，货运 F3）：这个货能从这个产方装走。
 *
 * 为什么是事实而不是模型的功课：车站收什么货由**引擎**按集货区算
 * （真机探针：矿场旁的车站**不接受煤**）⇒ 模型看不见"这里能装煤"，
 * 就只能反复提出装不上货的线路。
 */
export interface FreightLinkFact {
	/** 货种标签（稳定，如 "COAL"）。 */
	cargo: string;
	/** 产方产业 id（能装货的那一侧）。 */
	producer: number;
}

/** 全图按货种聚合的读数（模型可见）：哪些货存在、运走了多少。 */
export interface CargoFact {
	/** 货种标签（稳定，如 "COAL"）。 */
	label: string;
	/** 上月产量；null = 未测到。 */
	produced: number | null;
	/** 上月运量；null = 未测到。 */
	transported: number | null;
}

/**
 * 融资事实（模型可见）：还能借多少、贷款的最小单位是多少。
 *
 * **利息率不在这里**：引擎的脚本 API **不暴露**利息率（`_economy.interest_rate` 只在
 * 引擎内部用）⇒ 那是"没测到"，不是"0%"，也不是猜一个数（Issue #13 / D60）。
 */
export interface FinancingFact {
	/** 还能借多少（公司的贷款上限）；null = 没测到。 */
	loanCeiling: number | null;
	/** 贷款的最小单位（引擎的贷款间隔）；null = 没测到。 */
	loanInterval: number | null;
}

/** 一个可选道路车型（模型可见）：车队能换成什么。 */
export interface EngineFact {
	id: number;
	name: string;
	speed: number;
	/**
	 * 这个车型能拉的**货种标签**（如 "COAL"）；null = 引擎没报。
	 *
	 * 为什么重要（货运 F1）："哪辆车拉煤"是引擎的属性，不是从名字里猜的
	 * （真机探针：Balogh Coal Truck ⇒ COAL，Talbott Livestock Van ⇒ LVST）。
	 */
	cargo: string | null;
}

/** The world as the model sees it. */
/** 公司口径的货运交付（见 `WorldFacts.companyCargo`）。 */
export interface CompanyCargoFact {
	/** 每个被监视货种的会话累计（0 也是真实测量值：监视了，没收到交付）。 */
	byCargo: { label: string; amount: number }[];
	/** 游戏口径的季度交付总量（交叉核对用）。 */
	quarterDelivered: number | null;
	/** 被监视的规模：货种数 / 目的地数。 */
	monitored: { cargoes: number; destinations: number } | null;
	/** 计量缺口：累计值是**下界**（dropped = 丢掉的增量数；error = 最后一次失败的全文）。 */
	gaps: { dropped: number; error?: string } | null;
}

export interface WorldFacts {
	date: string | null;
	companies: CompanyFact[];
	towns: TownFact[];
	/** 产业取样（按产量降序）。 */
	industries: IndustryFact[];
	/** 全部产业的位置与名字（货运线路要坐标）。 */
	industrySites: IndustrySiteFact[];
	/** 货种目录：哪些货是货运、谁产、谁收。 */
	cargoCatalog: CargoCatalogFact[];
	/**
	 * 货运可运链路（货运 F3）：哪些产方真的装得上货。
	 *
	 * 空数组 = 引擎算出来**一个都没有**（真的装不上货）；缺席 = 没测到。
	 */
	freightLinks: FreightLinkFact[];
	/** 按货种聚合的产量/运量。 */
	cargoTotals: CargoFact[];
	/** 车型目录。 */
	engines: EngineFact[];
	/**
	 * 本公司口径的货运交付（货运 F2）。
	 *
	 * 口径 = **货运交付到产业**的单轴会话累计（`GSCargoMonitor` 的产业轴）。
	 * 为什么模型要看见它：这是"我到底运了多少货"的**结果**事实，与分数同源；
	 * 没有它，模型只能看到总分（货物 + 客运），分不出是货运还是客运。
	 *
	 * null = 这局没有这个通道（watch 模式没有 GS）；**不是** 0。
	 */
	companyCargo: CompanyCargoFact | null;
	/** 融资事实（还能借多少 / 贷款的最小单位）。 */
	financing: FinancingFact;
	/**
	 * The game's **pushed events** (Issue #13, S7d): a vehicle was lost, the
	 * first vehicle reached a station…
	 *
	 * Why they belong to the observation surface: the engine pushes them, and
	 * before this they were dropped by the GS - so a model could not see "my bus
	 * arrived" or "my truck was scrapped" unless it looked at the right moment.
	 * The newest come last; the list is bounded by the world state.
	 */
	events: WorldEventFact[];
	/** Index signature: the projection travels as a plain JSON object. */
	[key: string]: unknown;
}

function toNumber(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function gameDate(snap: WorldSnapshot): string | null {
	if (!snap.date) return null;
	return `${snap.date.year}-${String(snap.date.month).padStart(2, "0")}-${String(snap.date.day).padStart(2, "0")}`;
}

/**
 * The canonical projection: companies by id, towns by population (desc, nulls last).
 */
export function worldFacts(snap: WorldSnapshot): WorldFacts {
	const companies: CompanyFact[] = [];
	for (const [id, c] of snap.companies.entries()) {
		companies.push({
			// The map key IS the company id (the info packet may be missing).
			id: c.info?.id ?? id,
			money: c.economy ? toNumber(c.economy.money) : null,
			loan: c.economy ? toNumber(c.economy.loan) : null,
			income: c.economy ? toNumber(BigInt.asIntN(64, c.economy.income)) : null,
			vehicles: c.stats ? toNumber(c.stats.vehicles) : null,
			stations: c.stats ? toNumber(c.stats.stations) : null,
		});
	}
	companies.sort((a, b) => a.id - b.id);
	const towns: TownFact[] = (snap.towns ?? []).map((t) => ({
		id: t.id,
		pop: t.population === null || t.population === undefined ? null : toNumber(t.population),
		// 空名字 = 没名字（null），**不**退化成 id 字符串。
		name: typeof t.name === "string" && t.name.trim() !== "" ? t.name.trim() : null,
		x: t.x,
		y: t.y,
	}));
	// Population descending, unknown population last, ties by id: the order the
	// model sees must be deterministic (the tool's own comment said the same).
	towns.sort((a, b) => {
		if (a.pop === null && b.pop === null) return a.id - b.id;
		if (a.pop === null) return 1;
		if (b.pop === null) return -1;
		return b.pop - a.pop || a.id - b.id;
	});
	// 产业/货种/车型：GS 早就在报（`industry_list` / `cargo_totals` / `engines`），
	// hub 早就在解析——只是投影没带（2026-10-30 的真实模型局证据，SPEC §10.124）。
	const industries: IndustryFact[] = (snap.industries ?? []).map((i) => ({
		id: i.id,
		cargo: typeof i.cargo === "string" ? i.cargo : "",
		name: typeof i.name === "string" ? i.name : "",
		produced: toNumber(i.produced),
		transported: toNumber(i.transported),
		stock: toNumber(i.stock),
	}));
	// 货运 F1：全部产业的位置与名字（坐标是选线路的必需事实）。
	const industrySites: IndustrySiteFact[] = (snap.industrySites ?? []).map((s) => ({
		id: s.id,
		name: typeof s.name === "string" ? s.name : "",
		x: toNumber(s.x) ?? 0,
		y: toNumber(s.y) ?? 0,
	}));
	// 货运 F1：货种目录（是不是货运 / 谁产 / 谁收）——引擎算出的事实。
	const cargoCatalog: CargoCatalogFact[] = (snap.cargoCatalog ?? []).map((c) => ({
		label: typeof c.label === "string" ? c.label : "",
		freight: c.freight === true,
		producers: (c.producers ?? []).map(Number).filter((n) => Number.isFinite(n)),
		consumers: (c.consumers ?? []).map(Number).filter((n) => Number.isFinite(n)),
	}));
	const freightLinks: FreightLinkFact[] = (snap.freightLinks ?? []).map((l) => ({
		cargo: typeof l.cargo === "string" ? l.cargo : "",
		producer: toNumber(l.producer) ?? -1,
	}));
	const cargoTotals: CargoFact[] = (snap.cargoTotals ?? []).map((c) => ({
		label: typeof c.label === "string" ? c.label : "",
		produced: toNumber(c.produced),
		transported: toNumber(c.transported),
	}));
	const engines: EngineFact[] = (snap.engines ?? []).map((e) => ({
		id: e.id,
		name: typeof e.name === "string" ? e.name : "",
		speed: toNumber(e.speed) ?? 0,
		// null = 引擎没报这个车型能拉什么货（**不是**"什么都拉"）。
		cargo: typeof e.cargo === "string" && e.cargo !== "" ? e.cargo : null,
	}));
	// 货运 F2：本公司口径的货运交付（单轴累计 + 缺口）。
	const companyCargo: CompanyCargoFact | null = snap.companyCargo
		? {
				byCargo: (snap.companyCargo.byCargo ?? []).map((c) => ({
					label: typeof c.label === "string" ? c.label : "",
					amount: toNumber(c.amount) ?? 0,
				})),
				quarterDelivered: toNumber(snap.companyCargo.quarterDelivered),
				monitored: snap.companyCargo.monitored
					? {
							cargoes: toNumber(snap.companyCargo.monitored.cargoes) ?? 0,
							destinations: toNumber(snap.companyCargo.monitored.destinations) ?? 0,
						}
					: null,
				gaps: snap.companyCargo.gaps
					? {
							dropped: toNumber(snap.companyCargo.gaps.dropped) ?? 0,
							...(typeof snap.companyCargo.gaps.error === "string" && snap.companyCargo.gaps.error !== ""
								? { error: snap.companyCargo.gaps.error }
								: {}),
						}
					: null,
			}
		: null;
	return {
		date: gameDate(snap),
		companies,
		towns,
		industries,
		industrySites,
		cargoCatalog,
		freightLinks,
		cargoTotals,
		engines,
		companyCargo,
		financing: {
			loanCeiling: typeof snap.loanCeiling === "number" ? snap.loanCeiling : null,
			loanInterval: typeof snap.loanInterval === "number" ? snap.loanInterval : null,
		},
		events: (snap.worldEvents ?? []).map((e) => ({ ...e })),
	};
}

/**
 * A probe world: every branch of the projection filled in.
 *
 * 为什么需要它：观测面的**结构**指纹必须**只依赖代码**（跨 seed 稳定），而投影的
 * 输出形状又取决于"世界里有没有那类东西"（一个没有产业的地图，`industries` 是空
 * 数组 ⇒ 形状不同）。探针把每条分支都填满，于是"投影多了一个字段"必然改变指纹，
 * "地图上多了一座城"不会。
 */
function observationProbe(): WorldSnapshot {
	return {
		date: { raw: 0, year: 1950, month: 1, day: 1 },
		companies: new Map([
			[
				0,
				{
					info: {
						id: 0,
						name: "probe",
						manager: "probe",
						colour: 0,
						passwordProtected: false,
						inauguratedYear: 1950,
						isAi: false,
					},
					economy: { id: 0, money: 0n, loan: 0n, income: 0n },
					stats: { id: 0, vehicles: 0, stations: 0, breakdown: { train: 0, lorry: 0, bus: 0, plane: 0, ship: 0 } },
					lastEconomyAt: null,
					history: [],
					deliveredRun: { total: 0, byCargo: [] },
				} as unknown as CompanyState,
			],
		]),
		recent: [],
		totalEvents: 0,
		towns: [{ id: 1, name: "probe", population: 1, x: 1, y: 1 }],
		townsTotal: 1,
		industries: [{ id: 1, cargo: "COAL", name: "probe", produced: 1, transported: 1, stock: 1 }],
		industriesTotal: 1,
		industrySites: [{ id: 1, name: "probe", x: 2, y: 3 }],
		cargoCatalog: [{ label: "COAL", freight: true, producers: [1], consumers: [2] }],
		freightLinks: [{ cargo: "COAL", producer: 1 }],
		cargoTotals: [{ label: "COAL", produced: 1, transported: 1 }],
		engines: [{ id: 1, name: "probe", speed: 1, cargo: "COAL" }],
		companyCargo: {
			byCargo: [{ label: "COAL", amount: 3 }],
			quarterDelivered: 5,
			monitored: { cargoes: 1, destinations: 2 },
			gaps: { dropped: 0 },
		},
		observationPolicy: null,
		loanCeiling: 100000,
		loanInterval: 10000,
		worldEvents: [
			{ seq: 0, kind: "vehicle_lost", vehicle: 1, station: null, industry: null, town: null },
			{ seq: 1, kind: "station_first_vehicle", vehicle: 1, station: 1, industry: null, town: null },
		],
	};
}

/**
 * The fingerprint of the observation surface — the model's world, structurally.
 *
 * Cross-seed stable, code-dependent: two runs that saw the same **shape** of world
 * are comparable; two runs whose projection changed are not, and the Compare page
 * says so (SPEC §10.121).
 */
export function observationShapeHash(): string {
	return observationShapeHashOf(worldFacts(observationProbe()));
}

/**
 * The audit-side snapshot: the canonical readings plus the display fields the
 * audit trail keeps (company name, AI flag) and the event counters.
 *
 * Money stays a string here on purpose: the audit format is read by
 * `scripts/loop-health.ts`, which types it as a string.
 */
export function auditState(snap: WorldSnapshot): Record<string, unknown> {
	const facts = worldFacts(snap);
	const companies = [...snap.companies.values()].map((c) => {
		const fact = facts.companies.find((f) => f.id === (c.info?.id ?? null));
		return {
			id: c.info?.id ?? null,
			name: c.info?.name ?? null,
			isAi: c.info?.isAi ?? null,
			money: fact?.money === null || fact?.money === undefined ? null : String(fact.money),
			loan: fact?.loan === null || fact?.loan === undefined ? null : String(fact.loan),
			income: fact?.income === null || fact?.income === undefined ? null : String(fact.income),
			vehicles: fact?.vehicles ?? null,
			stations: fact?.stations ?? null,
		};
	});
	// The delivered counter of OUR company, by the same rule the scorer uses
	// (id 0, else the first one) and from the same source (`deliveredRun.total`,
	// SPEC §10.65) — so the causal timeline's effect and the metric row cannot
	// disagree about what was delivered. null = not measured (never 0).
	const ours = snap.companies.get(0) ?? [...snap.companies.values()][0];
	return {
		date: facts.date,
		companies,
		towns: facts.towns.map((t) => ({ id: t.id, population: t.pop, name: t.name, x: t.x, y: t.y })),
		delivered: ours?.deliveredRun?.total ?? null,
		recentEventCount: snap.recent.length,
		totalEvents: snap.totalEvents,
	};
}
