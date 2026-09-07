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

export interface CompanyState {
	/** Last known info snapshot. */
	info: CompanySnapshot | null;
	/** Latest economy (poll or quarterly). */
	economy: CompanyEconomy | null;
	/** Latest stats. */
	stats: CompanyStats | null;
	/** Wall-clock ms of last economy update (for "stale?" UI). */
	lastEconomyAt: number | null;
}

export interface WorldSnapshot {
	date: GameDate | null;
	/** company id -> state. */
	companies: Map<number, CompanyState>;
	/** Recent events, oldest first. */
	recent: GameEvent[];
	/** Monotonic event count (never reset). */
	totalEvents: number;
}

export interface WorldStateOptions {
	/** Max events retained in `recent`. Default 500. */
	recentLimit?: number;
}

const DEFAULT_RECENT_LIMIT = 500;

export class WorldState {
	private date: GameDate | null = null;
	private companies = new Map<number, CompanyState>();
	private recent: GameEvent[] = [];
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
					this.companies.set(p.id, { info: null, economy: null, stats: null, lastEconomyAt: null });
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
				});
				break;
			}
			case "company_economy": {
				const p = ev.payload as CompanyEconomy;
				this.upsertCompany(p.id).economy = p;
				this.upsertCompany(p.id).lastEconomyAt = ev.ts;
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
			c = { info: null, economy: null, stats: null, lastEconomyAt: null };
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
		};
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
