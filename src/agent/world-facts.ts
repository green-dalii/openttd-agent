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

import type { WorldSnapshot } from "../game/world-state.js";

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

/** 全图按货种聚合的读数（模型可见）：哪些货存在、运走了多少。 */
export interface CargoFact {
	/** 货种标签（稳定，如 "COAL"）。 */
	label: string;
	/** 上月产量；null = 未测到。 */
	produced: number | null;
	/** 上月运量；null = 未测到。 */
	transported: number | null;
}

/** 一个可选道路车型（模型可见）：车队能换成什么。 */
export interface EngineFact {
	id: number;
	name: string;
	speed: number;
}

/** The world as the model sees it. */
export interface WorldFacts {
	date: string | null;
	companies: CompanyFact[];
	towns: TownFact[];
	/** 产业取样（按产量降序）。 */
	industries: IndustryFact[];
	/** 按货种聚合的产量/运量。 */
	cargoTotals: CargoFact[];
	/** 车型目录。 */
	engines: EngineFact[];
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
	const cargoTotals: CargoFact[] = (snap.cargoTotals ?? []).map((c) => ({
		label: typeof c.label === "string" ? c.label : "",
		produced: toNumber(c.produced),
		transported: toNumber(c.transported),
	}));
	const engines: EngineFact[] = (snap.engines ?? []).map((e) => ({
		id: e.id,
		name: typeof e.name === "string" ? e.name : "",
		speed: toNumber(e.speed) ?? 0,
	}));
	return { date: gameDate(snap), companies, towns, industries, cargoTotals, engines };
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
