/**
 * WorldState — in-memory authoritative accumulation of OpenTTD events.
 *
 * 职责: 消费规范化的 GameEvent, 累积出「当前世界状态」供 UI/决策层快照:
 *   - 当前日期
 *   - 公司注册表 (info/economy/stats)
 *   - 最近事件环形缓冲 (审计/回放)
 * 事实来源: SPEC v0.1.0 (观测闭环). 事件源 = AdminClient -> observer。
 * 禁止: IO; LLM 决策; 直接驱动游戏 (纯状态累积)。
 */

import type { CompanyEconomy, CompanySnapshot, CompanyStats, GameDate, GameEvent } from "../types.js";
import { createDeliveryMeter } from "./delivery-meter.js";

/**
 * Game day in the project's 360-day-year convention. Absolute year is fine -
 * the meter only compares differences and quarter boundaries.
 */
function gameDayOf(date: GameDate | null): number {
	if (!date) return 0;
	return date.year * 360 + (date.month - 1) * 30 + (date.day - 1);
}

function emptyDelivery(): CumulativeRunDelivery {
	return { total: null, missing: 0, quarterChanges: 0, gaps: 0, complete: false };
}

export interface CompanyState {
	/** Last known info snapshot. */
	info: CompanySnapshot | null;
	/** Latest economy (poll or quarterly). */
	economy: CompanyEconomy | null;
	/** Latest stats. */
	stats: CompanyStats | null;
	/** Wall-clock ms of last economy update (for "stale?" UI). */
	lastEconomyAt: number | null;
	/**
	 * Bounded cash/loan/income series for the dashboard curve.
	 *
	 * Kept server-side because the dashboard is a **view**: a browser refresh
	 * used to wipe the whole curve (history lived only in page memory), so an
	 * operator returning to a long run saw a blank chart.
	 */
	history: CompanyHistoryPoint[];
	/**
	 * Cargo delivered since this session started, integrated across OpenTTD's
	 * quarterly reset of `economy.deliveredCargo` (SPEC §10.65).
	 *
	 * `economy.deliveredCargo` alone is a **per-quarter** counter, so reading it
	 * once at the end measures a random partial quarter - exactly the confound
	 * that made two A/B rounds disagree in direction.
	 */
	deliveredRun: CumulativeRunDelivery;
}

/** Cumulative cargo plus how trustworthy the accumulation is. */
export interface CumulativeRunDelivery {
	total: number | null;
	/** Readings skipped (counter absent from the packet). */
	missing: number;
	/** Quarter boundaries crossed with the previous total carried over. */
	quarterChanges: number;
	/** Journal breaks: a whole quarter elapsed unseen -> total is a lower bound. */
	gaps: number;
	/** False when whole quarters were missed, so callers can refuse to compare. */
	complete: boolean;
}

/** One sampled point of a company's economy (for the cash/loan/income curve). */
export interface CompanyHistoryPoint {
	at: number;
	/** Game date at sample time (for axis labels); null before the first date event. */
	year: number | null;
	month: number | null;
	money: number;
	loan: number;
	income: number;
}

/** Cap on retained history points per company (~1h at a 5s poll). */
const MAX_HISTORY = 600;

export interface WorldSnapshot {
	date: GameDate | null;
	/** company id -> state. */
	companies: Map<number, CompanyState>;
	/** Recent events, oldest first. */
	recent: GameEvent[];
	/** Monotonic event count (never reset). */
	totalEvents: number;
	/**
	 * Candidate towns, pushed up by the Bridge GS with its periodic state report.
	 *
	 * Why this exists (SPEC §10.32): the M3 experiment was saturated because the
	 * agent had NO decision to make - it could not even see the towns it was
	 * choosing between, and the tool description told it not to bother choosing.
	 * A task whose entire content is "press go" cannot show whether experience
	 * helps, so the options had to become visible before anything else could work.
	 */
	towns: TownInfo[];
}

/** One town as the agent sees it - enough to make a real choice. */
export interface TownInfo {
	id: number;
	/** Population; the main signal for how much passenger demand exists. */
	population: number;
	x: number;
	y: number;
}

export interface WorldStateOptions {
	/** Max events retained in `recent`. Default 500. */
	recentLimit?: number;
}

const DEFAULT_RECENT_LIMIT = 500;

export class WorldState {
	private date: GameDate | null = null;
	private companies = new Map<number, CompanyState>();
	/**
	 * One delivery meter per company id. Instance state, not module state: two
	 * WorldState instances (tests, or two sessions in one process) must not
	 * accumulate into each other's counters.
	 */
	private meters = new Map<number, ReturnType<typeof createDeliveryMeter>>();
	private recent: GameEvent[] = [];
	private towns: TownInfo[] = [];
	private totalEvents = 0;
	private recentLimit: number;

	constructor(opts: WorldStateOptions = {}) {
		this.recentLimit = opts.recentLimit ?? DEFAULT_RECENT_LIMIT;
	}

	/** Apply one normalized event. No-op for kinds we don't track. */
	ingest(ev: GameEvent): void {
		this.totalEvents++;
		this.recent.push(ev);
		if (this.recent.length > this.recentLimit) this.recent.shift();

		switch (ev.kind) {
			case "date": {
				const p = ev.payload as { raw: number; year: number; month: number; day: number };
				this.date = { raw: p.raw, year: p.year, month: p.month, day: p.day };
				break;
			}
			case "company_new": {
				const p = ev.payload as { id: number };
				if (!this.companies.has(p.id)) {
					this.companies.set(p.id, {
						info: null,
						economy: null,
						stats: null,
						lastEconomyAt: null,
						history: [],
						deliveredRun: emptyDelivery(),
					});
				}
				break;
			}
			case "company_info": {
				const p = ev.payload as CompanySnapshot;
				this.companies.set(p.id, {
					info: p,
					economy: this.companies.get(p.id)?.economy ?? null,
					stats: this.companies.get(p.id)?.stats ?? null,
					lastEconomyAt: this.companies.get(p.id)?.lastEconomyAt ?? null,
					history: this.companies.get(p.id)?.history ?? [],
					deliveredRun: this.companies.get(p.id)?.deliveredRun ?? emptyDelivery(),
				});
				break;
			}
			case "company_economy": {
				const p = ev.payload as CompanyEconomy;
				const c = this.upsertCompany(p.id);
				c.economy = p;
				// Integrate across the quarterly reset (SPEC §10.65). The date is
				// what identifies the quarter; each company keeps its own meter.
				const meter = this.meters.get(p.id) ?? createDeliveryMeter();
				this.meters.set(p.id, meter);
				meter.observe(gameDayOf(this.date), p.deliveredCargo);
				const st = meter.stats();
				c.deliveredRun = {
					total: meter.total(),
					missing: st.missing,
					quarterChanges: st.quarterChanges,
					gaps: st.gaps,
					complete: st.complete,
				};
				c.lastEconomyAt = ev.ts;
				// Money is signed (SPEC §10.6); keep it numeric for the chart.
				c.history = [
					...c.history,
					{
						at: ev.ts,
						year: this.date?.year ?? null,
						month: this.date?.month ?? null,
						money: Number(p.money),
						loan: Number(p.loan),
						income: Number(p.income),
					},
				].slice(-MAX_HISTORY);
				break;
			}
			case "company_stats": {
				const p = ev.payload as CompanyStats;
				this.upsertCompany(p.id).stats = p;
				break;
			}
			case "company_remove": {
				const p = ev.payload as { id: number };
				this.companies.delete(p.id);
				break;
			}
			default:
				break; // console/chat/gamescript/newgame/shutdown not stateful here
		}
	}

	private upsertCompany(id: number): CompanyState {
		let c = this.companies.get(id);
		if (!c) {
			c = { info: null, economy: null, stats: null, lastEconomyAt: null, history: [], deliveredRun: emptyDelivery() };
			this.companies.set(id, c);
		}
		return c;
	}

	/** Deep-ish snapshot (Map cloned). Payloads referenced by identity — immutable by convention. */
	snapshot(): WorldSnapshot {
		return {
			date: this.date ? { ...this.date } : null,
			companies: new Map(this.companies),
			recent: [...this.recent],
			totalEvents: this.totalEvents,
			towns: [...this.towns],
		};
	}

	/**
	 * Replace the town list (the GS owns it - the agent only reads it).
	 *
	 * Sorted by population descending so the most promising candidates come first;
	 * the ORDER is a fact about the world, not advice about what to pick.
	 */
	setTowns(towns: TownInfo[]): void {
		this.towns = (Array.isArray(towns) ? towns : [])
			.filter((t) => t && Number.isFinite(t.id))
			.map((t) => ({ id: Number(t.id), population: Number(t.population) || 0, x: Number(t.x) || 0, y: Number(t.y) || 0 }))
			.sort((a, b) => b.population - a.population);
	}

	getTotalEvents(): number {
		return this.totalEvents;
	}

	/** Latest event of a given kind, or null. */
	lastEvent(kind: string): GameEvent | null {
		for (let i = this.recent.length - 1; i >= 0; i--) {
			if (this.recent[i]!.kind === kind) return this.recent[i]!;
		}
		return null;
	}
}
