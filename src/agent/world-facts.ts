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
	x: number;
	y: number;
}

/** The world as the model sees it. */
export interface WorldFacts {
	date: string | null;
	companies: CompanyFact[];
	towns: TownFact[];
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
	return { date: gameDate(snap), companies, towns };
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
		towns: facts.towns.map((t) => ({ id: t.id, population: t.pop, x: t.x, y: t.y })),
		delivered: ours?.deliveredRun?.total ?? null,
		recentEventCount: snap.recent.length,
		totalEvents: snap.totalEvents,
	};
}
