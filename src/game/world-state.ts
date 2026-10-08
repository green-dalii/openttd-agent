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
import { convertDateToYmd } from "./payload-parsers.js";

/**
 * 有限数 → number，缺/非数 → **null**（"未上报"），不是 0。
 *
 * 为什么单独一个：`Number(x) || 0` 是本文件里反复出现的写法，而它把"没这个读数"
 * 与"读数是零"合并了 —— 页面上两者都渲染成 `0`，于是**未测量的产业看起来像是没在运输**。
 */
function numOrNull(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

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
	/**
	 * 地图上的城镇**总数**（GS 的 `tlist.Count()`）。
	 *
	 * 必须与 `towns.length` 分开：GS 只发**人口最多的前 10 个**（`bridge-gs/main.nut`
	 * 的取样），所以 `towns.length` 是"已知候选"而不是"地图全部"。
	 * null = 未收到（页面显示"—"），**不是 0**。
	 */
	townsTotal: number | null;
	/** 产业样本（按产量降序，GS 采样）。 */
	industries: IndustryInfo[];
	/** 地图上的产业总数（`GSIndustryList().Count()`）；null = 未收到。 */
	industriesTotal: number | null;
	/** 按货种聚合的上月产量/运量（原始计数）。 */
	cargoTotals: CargoAmounts[];
	/** P1-2 车型目录；空 = 未计量。 */
	engines: { id: number; name: string; speed: number }[];
	/** 本公司口径运量；null = 未收到（不是"零运量"）。 */
	companyCargo: CompanyCargoFacts | null;
}

/** One town as the agent sees it - enough to make a real choice. */
/**
 * 一个货种在**产业侧**的上月原始计数（由 GS 上报，**不做比率**）。
 *
 * 为什么只发原始数：比率（"利用率"）有两种口径 —— 产业口径（所有公司）与
 * 公司口径（`GSCargoMonitor`）。把它算在 GS 里就等于把口径藏进管道；
 * 派生放在前端（可单测）并显式标注口径。见 `SPEC.md` §10.99。
 */
export interface CargoAmounts {
	/** 货种标签（`GSCargo.GetCargoLabel`，如 PASS/COAL）——稳定，不像本地化名。 */
	label: string;
	/** 上月产量；null = 未上报/不适用（**不是 0**，D60）。 */
	produced: number | null;
	/** 上月运量；null = 未上报/不适用（**不是 0**，D60；`-1` 是 OpenTTD 的「无此货」）。 */
	transported: number | null;
}

/** 一个产业的上月读数（GS 采样，原始计数）。 */
export interface IndustryInfo {
	id: number;
	/** 该行对应的**货种标签**（`GSCargo.GetCargoLabel`，如 COAL/OIL_）。 */
	cargo: string;
	name: string;
	/** 上月产量；null = 未上报/不适用（**不是 0**，D60）。 */
	produced: number | null;
	/** 上月运量；null = 未上报/不适用（**不是 0**，D60；`-1` 是 OpenTTD 的「无此货」）。 */
	transported: number | null;
	/** 等待加工的库存；null = 该产业不接受/不适用（**不是 0**）。 */
	stock: number | null;
}

/** 本公司口径的运量（`GSCargoMonitor` 累计 + 游戏季度统计）。 */
export interface CompanyCargoFacts {
	/** 本会话累计：按货种（monitor 口径，只覆盖**被监视的目的地**）。 */
	byCargo: { label: string; amount: number }[];
	/** 游戏口径：本季度交付总量（所有货种，精确值），用作交叉核对。 */
	quarterDelivered: number | null;
	/** 被监视的目的地数量（缺了它就没法诚实地说"这是子集"）。 */
	monitored: { towns: number; industries: number } | null;
}

export interface TownInfo {
	id: number;
	/**
	 * 城镇**名字**（2026-09-25 真机验证 `GSTown.GetName` 存在）。
	 *
	 * 为什么必须有：线路端点此前只能显示 `#4 → #8` —— id 是给机器看的，给人看不出
	 * 是哪两座城，而"为什么 agent 选了这两座城"正是复盘时第一个要回答的问题。
	 * 空串 = 该局没收到名字（旧 GS），页面回退显示 id。
	 */
	name?: string;
	/** Population; the main signal for how much passenger demand exists. */
	population: number | null;
	x: number;
	y: number;
	/** 该镇主货种（GS 取产量最高的 1–2 个）——原始计数，比率由前端派生。 */
	cargo?: CargoAmounts[];
}

export interface WorldStateOptions {
	/** Max events retained in `recent`. Default 500. */
	recentLimit?: number;
}

const DEFAULT_RECENT_LIMIT = 500;

/** 计数缺失语义（D60）：缺失/负值 → null；`0` 只能是量出来的 0。 */
function countOr(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

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
	private townsTotal: number | null = null;
	private industries: IndustryInfo[] = [];
	private industriesTotal: number | null = null;
	private cargoTotals: CargoAmounts[] = [];
	/** P1-2：可选车型目录（引擎 id/名字/速度）。空 = 未计量（不是没有车）。 */
	private engines: { id: number; name: string; speed: number }[] = [];
	private companyCargo: CompanyCargoFacts | null = null;
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
				this.applyDate(p.raw, { year: p.year, month: p.month, day: p.day });
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
			townsTotal: this.townsTotal,
			industries: [...this.industries],
			industriesTotal: this.industriesTotal,
			cargoTotals: [...this.cargoTotals],
			engines: [...this.engines],
			companyCargo: this.companyCargo ? { ...this.companyCargo } : null,
		};
	}

	/**
	 * The current game date, from the Bridge GS's own clock (`GSDate`, every
	 * 200 script ticks ≈ 6 s) — the finest source we have.
	 *
	 * 为什么需要（2026-09-25 真机取证）：admin port 的 DATE 包按 **Monthly**
	 * 订阅（`admin-client.ts` 的 `DEFAULT_SUBSCRIBE`），也就是**一个游戏月**才来一次。
	 * 于是一局 90 秒的真实运行里只收到 **1** 个 date 事件，而页面 health 条的
	 * `worldRate` 判据是"最近 90 s 内有没有新 date" —— 它于是**结构性地**永远报
	 * "world frozen"，哪怕世界每 6 秒推进一次（那次截图里的假事实）。agent 自己的
	 * `observe` 读的也是这个字段，所以模型看到的世界时间同样停在连接那一刻。
	 * 一条按月刷新的通道不能当"当前时间"用。
	 *
	 * 传的是 OpenTTD 的 raw 日期（天数计数），与 admin 包同一坐标系。
	 */
	setDateFromRaw(raw: number): void {
		this.applyDate(raw);
	}

	/**
	 * The ONE writer for `date` (2026-09-25). Two sources feed it now — the
	 * monthly admin packet and the 6-second GS clock — so the field needs one
	 * place deciding which reading wins.
	 *
	 * 规则：**单调**。较旧的读数一律丢弃（哪怕来自自认为"更新"的通道）：把日期
	 * 往回滚会让按 gameDay 判季度的交付计量器（`delivery-meter.ts`）看到季度序号
	 * 倒退，而倒序读数在真实网络里确实会发生。
	 */
	private applyDate(raw: number, ymd?: { year: number; month: number; day: number }): void {
		if (!Number.isFinite(raw)) return;
		if (this.date && raw < this.date.raw) return;
		this.date = ymd
			? { raw, year: ymd.year, month: ymd.month, day: ymd.day }
			: { raw, ...convertDateToYmd(raw) };
	}

	/**
	 * Replace the town list (the GS owns it - the agent only reads it).
	 *
	 * Sorted by population descending so the most promising candidates come first;
	 * the ORDER is a fact about the world, not advice about what to pick.
	 */
	setEngines(list: { id: number; name: string; speed: number }[]): void {
		this.engines = list;
	}

	setTowns(towns: TownInfo[], total?: number | null): void {
		// 总数只在**明确给出**时更新：取样列表每帧都到，总数偶尔才带 ——
		// 用 undefined 覆盖会把已知总数抹成 null（页面从"共 42 个"退回"—"）。
		if (total !== undefined) this.townsTotal = total === null || !Number.isFinite(Number(total)) ? null : Number(total);
		this.towns = (Array.isArray(towns) ? towns : [])
			.filter((t) => t && Number.isFinite(t.id))
			.map((t) => ({
				id: Number(t.id),
				// 名字（D55 第三次同类：在"最后一公里"重建对象时漏字段 = 永远到不了页面）。
				// 缺失保持缺失，**不**折叠成 id 字符串或 0。
				...(typeof t.name === "string" && t.name.trim() !== "" ? { name: t.name.trim() } : {}),
				population: Number.isFinite(Number(t.population)) ? Number(t.population) : null,
				x: Number(t.x) || 0,
				y: Number(t.y) || 0,
				// 主货种是可选事实：过滤掉不可用的条目，而不是补 0。
				...(Array.isArray(t.cargo)
					? {
							cargo: t.cargo
								.filter((c) => c && typeof c.label === "string" && Number.isFinite(Number(c.produced)))
								// D60：缺失/负值保持 null（`Number(x) || 0` 会捏造 0）。
								.map((c) => ({ label: String(c.label), produced: countOr(c.produced), transported: countOr(c.transported) })),
						}
					: {}),
			}))
			// null = 未上报（D60）；排序时排最后，不用 0 冒充最小人口。
			.sort((a, b) => (b.population ?? -1) - (a.population ?? -1));
	}

	/**
	 * 替换产业样本（GS 拥有数据，harness 只读）。
	 *
	 * 过滤规则：**拿不到有限产量的条目直接丢掉**。把它当 0 会让页面显示
	 * "该产业不产东西"——那是编造事实（同 `setTowns` 的规则）。
	 * 总数只在明确给出时更新（`undefined` 不覆盖已知值）。
	 */
	setIndustries(list: IndustryInfo[], total?: number | null): void {
		// `null` 是**明确的"未知"**：显式传 null 必须落成 null。
		// （`Number(null) === 0` 会把"未知"变成"零个产业"—— 2026-09-25 同类 bug 第二次。）
		if (total !== undefined) this.industriesTotal = total === null || !Number.isFinite(Number(total)) ? null : Number(total);
		this.industries = (Array.isArray(list) ? list : [])
			.filter((i) => i && Number.isFinite(Number(i.id)) && Number.isFinite(Number(i.produced)))
			.map((i) => ({
				id: Number(i.id),
				cargo: String(i.cargo ?? ""),
				name: String(i.name ?? "").slice(0, 40),
				produced: Number(i.produced) || 0,
				// `transported` 保持 null = **未上报**（2026-09-25）：`Number(x) || 0`
				// 会把"没有这个读数"变成"运了 0 吨"——两者在页面上都显示成 0，
				// 于是"这座产业没参与运输"被说成了"运输量为零"。
				transported: numOrNull(i.transported),
				stock: numOrNull(i.stock),
			}))
			.sort((a, b) => b.produced - a.produced);
	}

	setCargoTotals(list: CargoAmounts[]): void {
		this.cargoTotals = (Array.isArray(list) ? list : [])
			.filter((c) => c && typeof c.label === "string" && c.label !== "")
			.map((c) => ({
				label: String(c.label),
				produced: numOrNull(c.produced) ?? 0,
				transported: numOrNull(c.transported),
			}))
			.sort((a, b) => b.produced - a.produced);
	}

	/** 本公司口径运量。`null` = 未收到（与 `{byCargo: []}` = "收到但为零" 不同）。 */
	setCompanyCargo(facts: CompanyCargoFacts | null): void {
		if (!facts) { this.companyCargo = null; return; }
		const byCargo = (Array.isArray(facts.byCargo) ? facts.byCargo : [])
			.filter((c) => c && typeof c.label === "string")
			.map((c) => ({ label: String(c.label), amount: Number(c.amount) || 0 }))
			.sort((a, b) => b.amount - a.amount);
		this.companyCargo = {
			byCargo,
			quarterDelivered: Number.isFinite(Number(facts.quarterDelivered)) ? Number(facts.quarterDelivered) : null,
			monitored: facts.monitored && Number.isFinite(Number(facts.monitored.towns))
				? { towns: Number(facts.monitored.towns), industries: Number(facts.monitored.industries) || 0 }
				: null,
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
