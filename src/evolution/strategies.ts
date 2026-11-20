/**
 * Strategy library — 参数化的成功模式（SPEC §5.2 机制 2）。
 *
 * 职责: StrategyCard 的合并(跨局累积)与**入库门槛**(价值>阈值 且 已验证局≥2),
 *   以及 SPEC §5.3 的"只读建议"guardrail。全部纯函数。
 * 事实来源: SPEC §5.2/§5.3、docs/EVOLUTION.md §2.2/§3。
 * 禁止: 在此调用 LLM 或读写磁盘。
 *
 * 为什么 valuePerRun 是数组而不是均值:门槛里"已验证局≥2"必须**可判定**。
 * 一个标量均值无法回答"验证过几局",于是门槛只能靠印象,等于没有门槛。
 */

import type { StrategyCard } from "./types.js";

export type { StrategyCard };

/**
 * 门槛：**本局净现金流**的每游戏日速率至少这么多，这个模式才值得记下来。
 *
 * 单位从"一局多赚多少钱"换成"每日速率"，原因有两个：
 *   ① 余额会被贷款、初始资金、造价时点主导（D86 的同类教训：拿最容易被混淆的量
 *      当成绩），而**利润**才是这一版业绩的口径；
 *   ② 每局的游戏日长度不同（60 日 vs 300 日），用"每局总额"比较等于奖励长局。
 *
 * **口径（Issue #104 P0b 修正，2026-11-11）**：被比较的读数是
 * **本局净现金流 ÷ 这一局实际经过的游戏日**（`money − loan`，含基建/购车/利息）。
 * 旧读数是 `income / 365`：`income` 是**当年迄今**净现金流（跨 1 月 1 日归零 ⇒
 * 只覆盖最后一年），365 是整年长度 ⇒ 它既不是"每游戏日利润"，也不是"这一局的利润"
 * （SPEC §10.76）。旧两局（B2）**不可离线重算** ⇒ 修正前的"没有一局达到门槛"这个
 * 结论在修正口径下**不再成立**，只能重跑后再判。
 *
 * 数值沿用旧门槛的经济含义：**"年收入目标 5000"**（旧值是"一局(≈300 日)多赚 5000"
 * ⇒ 约 16.7/日）⇒ 现在的含义是"一局跑满 300 天净现金流要比 0 多 5000"。
 */
export const MIN_STRATEGY_PROFIT_PER_DAY = 5000 / 300;

/**
 * 模型能"证明"的只有**真动作**：词表由代码拥有（与 `ACTION_EFFECTS` 的写动作同源）。
 *
 * 为什么（2026-11-01）：旧 id 直接对模型写的自由文本做哈希，于是同一个想法换一种
 * 措辞就变成新卡 ⇒ `MIN_VERIFIED_RUNS = 2` 在结构上不可达。身份必须归代码所有，
 * 模型只提供事实与证据；它也不能靠改措辞决定"这是一张新卡"。
 * 守卫：`test/unit/evolution-strategies.test.ts` 会核对这张表与工具目录一致。
 */
export const STRATEGY_ACTIONS = [
	"build_bus_route",
	// 货运线路（货运 F3）：模型"证明"的货运模式也必须能落在这张词表里，
	// 否则它的货运行为没有身份、也就永远晋升不了。
	"build_freight_route",
	"set_route_vehicles",
	"set_route_cargo",
	"set_route_engine",
	"retire_route",
	"set_pause",
] as const;

/**
 * 参与身份的**少量**参数（其余参数是证据，不是身份）。
 *
 * 只有真正改变"这是一个什么模式"的参数才进来：运什么货、用什么车、什么模式。
 * 镇号/线路号这类每次都会变的参数**不进身份**，否则每条线路都是一张新卡。
 */
export const STRATEGY_IDENTITY_PARAMS = ["cargo", "engine", "mode"] as const;

/** 这条 action 能不能当身份；不能就返回给模型看的原因（不是静默丢弃）。 */
export function strategyIdentityProblem(action: unknown): string | null {
	if (typeof action !== "string" || !action.trim()) return "action is required";
	const name = action.trim();
	if ((STRATEGY_ACTIONS as readonly string[]).includes(name)) return null;
	return `action must be one of: ${STRATEGY_ACTIONS.join(", ")}`;
}

/** SPEC §5.3 硬性要求:至少两个独立局验证过。 */
export const MIN_VERIFIED_RUNS = 2;

/** 单次注入策略卡上限。 */
export const MAX_STRATEGIES_INJECTED = 4;

/** 反思/统计产出的一条采样:某个模式在**一局**里的收益。 */
export interface StrategySample {
	action: string;
	params: Record<string, number | string>;
	/**
	 * 这一局的**净现金流速率**（每游戏日，正数=公司账上多钱）。
	 *
	 * 由代码从这一局的记录里盖上，模型不能自带一个数字——它只能提供模式与证据。
	 * 缺这个读数 ⇒ 这条采样不可用于晋升。
	 *
	 * 口径：**净现金流**（含基建/购车/利息）。它是**公司健康**，不是"策略赚不赚钱"
	 * ⇒ 晋升闸不用它（见 `operatingProfitPerDay`），但它要被**报出来**。
	 */
	profitPerDay?: number;
	/**
	 * 这一局的**运营利润速率**（每游戏日，正数=这条模式在赚钱）。
	 *
	 * 运营利润 = 运货收入 − 运行成本，**不含**基建/购车/利息 ⇒ 它才是"这条策略
	 * 赚不赚钱"的答案 ⇒ **晋升闸用它**（2026-11-14；方案 C：双口径并存）。
	 *
	 * 由代码盖上（同上）；模型不能自带。缺读数 ⇒ 不可判定（不是 0）。
	 */
	operatingProfitPerDay?: number;
	/** Game facts backing it; empty evidence means the sample is dropped. */
	evidence: string[];
	sessionId: string;
	createdAt: number;
}

/** Canonical, key-order-independent representation of the params object. */
function canonicalParams(params: unknown): string {
	if (!params || typeof params !== "object" || Array.isArray(params)) return "{}";
	const entries = Object.entries(params as Record<string, unknown>)
		.filter(([k]) => k)
		.map(([k, v]) => [k, typeof v === "number" ? `n:${v}` : `s:${String(v)}`] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return `{${entries.map(([k, v]) => `${k}=${v}`).join(",")}}`;
}

/**
 * Stable id for a pattern. Parameters are canonicalised, so `{a:1,b:2}` and
 * `{b:2,a:1}` are the same pattern — otherwise the library fills with clones of
 * the same idea and the "verified in N games" gate never trips.
 */
export function strategyId(action: unknown, params: unknown): string {
	if (strategyIdentityProblem(action) !== null) return "";
	// 身份只吃白名单参数：模型写多少别的字段都不改变这一张卡的身份。
	const identity: Record<string, unknown> = {};
	if (params && typeof params === "object" && !Array.isArray(params)) {
		for (const k of STRATEGY_IDENTITY_PARAMS) {
			const v = (params as Record<string, unknown>)[k];
			if (v !== undefined && v !== null && v !== "") identity[k] = v;
		}
	}
	const raw = `${String(action).trim()}|${canonicalParams(identity)}`;
	let h = 0x811c9dc5;
	for (let i = 0; i < raw.length; i++) {
		h ^= raw.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `s_${h.toString(36)}`;
}

function cleanList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of v) {
		if (typeof item !== "string") continue;
		const t = item.replace(/\s+/g, " ").trim();
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

/** A usable sample needs a known action, a measured profit rate, evidence, a source game. */
function isValidSample(s: unknown): s is StrategySample {
	if (!s || typeof s !== "object") return false;
	const v = s as StrategySample;
	if (strategyIdentityProblem(v.action) !== null) return false;
	if (!Number.isFinite(Number(v.profitPerDay))) return false;
	if (typeof v.sessionId !== "string" || !v.sessionId) return false;
	if (cleanList(v.evidence).length === 0) return false;
	return true;
}

/**
 * 把卡片里的「读数数组 + 来源局数组」配成 (局, 读数) 对：**一局一个读数**。
 *
 * 真机发现（2026-11-10）：一局里模型可以记多条同模式采样 ⇒ 旧实现把每条采样
 * 都追加进 `profitPerDayPerRun`，而闸把数组长度当成「验证局数」⇒ **单局三条
 * 高值采样就能过闸**，SPEC §5.3 的「已验证局≥2」形同虚设。
 * 配不上的旧卡（两个数组长度不等）只按能配上的前缀算局数（偏保守）。
 *
 * @param pick 读哪个口径（闸用**运营利润**；净现金流用于报出公司健康）。
 */
function verifiedReadings(
	card: StrategyCard,
	pick: (c: StrategyCard) => { values: number[] | undefined; sessions: string[] | undefined },
): { sessionId: string; value: number }[] {
	const { values: raw, sessions: rawSessions } = pick(card);
	const values = (raw ?? []).filter((v) => Number.isFinite(Number(v)));
	const sessions = Array.isArray(rawSessions) ? rawSessions : [];
	const n = Math.min(values.length, sessions.length);
	const bySession = new Map<string, number>();
	for (let i = 0; i < n; i++) bySession.set(String(sessions[i]), Number(values[i]));
	return [...bySession.entries()].map(([sessionId, value]) => ({ sessionId, value }));
}

/** The net-cash-flow readings (company health) — paired with `sourceSessionIds`. */
function cashFlowReadings(card: StrategyCard): { sessionId: string; value: number }[] {
	return verifiedReadings(card, (c) => ({
		values: c.profitPerDayPerRun,
		sessions: c.sourceSessionIds,
	}));
}

/**
 * The operating-profit readings (the gate's measure).
 *
 * They carry **their own** session list: a run may have a net cash flow reading
 * but no operating profit reading (not measured ≠ 0) ⇒ the two arrays can cover
 * different games. Pairing them by index against `sourceSessionIds` would
 * attribute a reading to the wrong game — a silent lie in a promotion gate.
 */
function operatingReadings(card: StrategyCard): { sessionId: string; value: number }[] {
	return verifiedReadings(card, (c) => ({
		values: c.operatingProfitPerDayPerRun,
		sessions: c.operatingProfitSessionIds ?? c.sourceSessionIds,
	}));
}

/**
 * Merge new samples into existing cards, accumulating one value sample per game.
 *
 * Cards start `enabled: false`: SPEC §5.3 says the engine only *advises*, and
 * nothing changes globally until a human confirms it in the UI. A regression
 * that silently defaults this to true would make the agent follow unreviewed
 * advice from a single lucky game.
 */
export function mergeStrategySamples(
	samples: StrategySample[],
	existing: StrategyCard[] = [],
	now = Date.now(),
): StrategyCard[] {
	const byId = new Map<string, StrategyCard>();
	/**
	 * 每个卡片的 (局 → 读数)：同一局只留一个读数（见 `verifiedReadings`）。
	 *
	 * 两个口径各自一张表：净现金流（公司健康）与运营利润（**闸的度量**）。
	 * 分开是因为一个局可能只测到其中一个（“没测到” ≠ 0）。
	 */
	const readings = new Map<string, Map<string, number>>();
	const operatingById = new Map<string, Map<string, number>>();

	const readingsOf = (id: string): Map<string, number> => {
		let m = readings.get(id);
		if (!m) {
			m = new Map();
			readings.set(id, m);
		}
		return m;
	};
	const operatingOf = (id: string): Map<string, number> => {
		let m = operatingById.get(id);
		if (!m) {
			m = new Map();
			operatingById.set(id, m);
		}
		return m;
	};

	for (const card of Array.isArray(existing) ? existing : []) {
		if (card && typeof card.id === "string" && card.id) {
			byId.set(card.id, { ...card });
			const m = readingsOf(card.id);
			for (const r of cashFlowReadings(card)) m.set(r.sessionId, r.value);
			const om = operatingOf(card.id);
			for (const r of operatingReadings(card)) om.set(r.sessionId, r.value);
		}
	}

	// Sort samples deterministically before accumulating, so `valuePerRun` does not
	// depend on the caller's iteration order. Ordered by time (chronological, which is
	// meaningful for a ledger) and then by session id as a stable tiebreak.
	const ordered = (Array.isArray(samples) ? samples : [])
		.filter(isValidSample)
		.map((s, i) => ({ s, i }))
		.sort((a, b) => {
			const at = Number(a.s.createdAt) - Number(b.s.createdAt);
			if (at !== 0) return at;
			if (a.s.sessionId !== b.s.sessionId) return a.s.sessionId < b.s.sessionId ? -1 : 1;
			return a.i - b.i;
		})
		.map((x) => x.s);

	for (const s of ordered) {
		if (!isValidSample(s)) continue;
		const id = strategyId(s.action, s.params);
		if (!id) continue;

		const prev = byId.get(id);
		const evidence = cleanList(s.evidence);
		// 同一局再记一次同一模式 ⇒ 覆盖该局的读数，不新增一局。
		readingsOf(id).set(s.sessionId, Number(s.profitPerDay));
		// 运营利润读数**缺失就不写**（不是 0）：“没测到”不能变成“测到 0”。
		if (Number.isFinite(Number(s.operatingProfitPerDay))) {
			operatingOf(id).set(s.sessionId, Number(s.operatingProfitPerDay));
		}
		if (!prev) {
			byId.set(id, {
				id,
				name: s.action,
				action: s.action,
				params: { ...(s.params || {}) },
				evidence,
				sourceSessionIds: [],
				createdAt: Number.isFinite(Number(s.createdAt)) ? Number(s.createdAt) : now,
				enabled: false,
			});
			continue;
		}

		// Accumulate across games; keep any human confirmation already given.
		const mergedEvidence = cleanList([...prev.evidence, ...evidence]);
		const sessions = new Set([...(prev.sourceSessionIds || []), s.sessionId]);
		byId.set(id, {
			...prev,
			evidence: mergedEvidence,
			sourceSessionIds: [...sessions].sort(),
			createdAt: Math.min(Number(prev.createdAt) || now, Number(s.createdAt) || now),
		});
	}

	// 读数与来源局保持一一对应（按局 id 排序 ⇒ 两个数组同序）。
	//
	// 两个口径**各自**与 sourceSessionIds 对齐：运营利润那张表可能比净现金流短
	// （某些局没测到运营利润）⇒ 它的数组只覆盖**测到的那几局**，因此
	// `verifiedReadings` 取 min(长度, 局数) 的保守做法仍然成立。
	for (const [id, card] of byId) {
		const m = readings.get(id);
		if (!m || m.size === 0) continue;
		const sessions = [...m.keys()].sort();
		card.sourceSessionIds = sessions;
		card.profitPerDayPerRun = sessions.map((s) => m.get(s)!);

		const om = operatingById.get(id);
		if (om && om.size > 0) {
			const opSessions = [...om.keys()].sort();
			card.operatingProfitPerDayPerRun = opSessions.map((s) => om.get(s)!);
			// **它自己的局列表**：两个口径可能覆盖不同的局（“没测到” ≠ 0）。
			card.operatingProfitSessionIds = opSessions;
		} else {
			delete card.operatingProfitPerDayPerRun;
			delete card.operatingProfitSessionIds;
		}
	}

	return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface PromotionResult {
	promoted: boolean;
	/**
	 * The **gate's** measure: mean **operating profit per game day** across the
	 * verified games (0 when there are no usable samples).
	 *
	 * Why operating profit and not net cash flow (2026-11-14): the gate asks
	 * "does this strategy pay". Net cash flow answers "did the company overspend",
	 * and it is negative by construction while a run is still building - so the
	 * gate could never open for any strategy that includes building (real run:
	 * net -1499.28/day vs operating +14.13/day). The two measures stay on the
	 * card; only this one gates.
	 */
	value: number;
	/** How many games verified it (counted on the gate's measure). */
	runs: number;
	/**
	 * Mean **net cash flow per game day** over the same verified games — the
	 * company-health reading. `null` = not measured (never folded into 0).
	 */
	netCashFlowPerDay: number | null;
	/** Human-readable reason, surfaced in the UI. */
	reason: string;
}

export interface PromotionOptions {
	minValue?: number;
	minRuns?: number;
}

/**
 * SPEC §5.3: a strategy is only stored when value > threshold **and** it has been
 * verified in at least 2 games. Both conditions are required — a high single-game
 * payoff is exactly the noise this gate exists to reject.
 *
 * **The measure (2026-11-14, 方案 C)**: the gate reads **operating profit per
 * game day** ("does this strategy pay"). Net cash flow stays on the card and is
 * **reported** (company health) but does not gate: it contains building, vehicles
 * and interest, so while a run is still building it is negative by construction and
 * the gate could never open for a strategy that includes building.
 */
export function evaluatePromotion(
	card: StrategyCard,
	opts: PromotionOptions = {},
): PromotionResult {
	const minValue = Number.isFinite(Number(opts.minValue))
		? Number(opts.minValue)
		: MIN_STRATEGY_PROFIT_PER_DAY;
	const minRuns = Number.isFinite(Number(opts.minRuns)) ? Number(opts.minRuns) : MIN_VERIFIED_RUNS;

	// 旧卡（2026-11-01 之前）只有模型自报的 `valuePerRun`：**没有**利润读数 ⇒ 不可晋升。
	// 那是"没测到"，不是"测到 0"——所以不给它们一个值。
	// 「已验证局数」= **独立局数**，不是读数个数（真机发现 2026-11-10）。
	//
	// 闸的度量 = **运营利润**（策略质量）；净现金流只报出（公司健康）。
	const operating = operatingReadings(card);
	const runs = operating.length;
	const value = runs ? operating.reduce((a, r) => a + r.value, 0) / runs : 0;

	// 净现金流：**同一批已验证局**上的均值；没测到 ⇒ null（不是 0）。
	const cashFlow = cashFlowReadings(card);
	const netCashFlowPerDay = cashFlow.length
		? cashFlow.reduce((a, r) => a + r.value, 0) / cashFlow.length
		: null;

	if (runs === 0) {
		return {
			promoted: false,
			value,
			runs,
			netCashFlowPerDay,
			reason:
				netCashFlowPerDay === null
					? `no measured profit yet (needs ${minRuns} games with a profit reading)`
					: `no operating profit reading yet (net cash flow is ${netCashFlowPerDay.toFixed(1)}/game day, but the gate reads operating profit - needs ${minRuns} games with an operating profit reading)`,
		};
	}
	if (runs < minRuns) {
		return {
			promoted: false,
			value,
			runs,
			netCashFlowPerDay,
			reason: `verified in ${runs} game(s) with an operating profit reading, needs >= ${minRuns}`,
		};
	}
	if (!(value > minValue)) {
		return {
			promoted: false,
			value,
			runs,
			netCashFlowPerDay,
			reason: `operating profit ${value.toFixed(1)}/game day does not exceed ${minValue.toFixed(1)}/day`,
		};
	}
	return {
		promoted: true,
		value,
		runs,
		netCashFlowPerDay,
		reason: `+${value.toFixed(1)} operating profit/game day across ${runs} games`,
	};
}

/** Merge samples, then keep only the cards that pass the promotion gate. */
export function promoteStrategies(
	samples: StrategySample[],
	existing: StrategyCard[] = [],
	opts: PromotionOptions & { now?: number } = {},
): StrategyCard[] {
	return mergeStrategySamples(samples, existing, opts.now ?? Date.now()).filter(
		(c) => evaluatePromotion(c, opts).promoted,
	);
}

export interface SelectStrategyOptions {
	limit?: number;
}

/**
 * Strategies eligible for injection.
 *
 * TWO independent gates must both pass, for different reasons:
 *
 * 1. **The SPEC §5.3 promotion gate** (value above threshold AND verified in >= 2
 *    games) - this is about evidence quality. `strategies.jsonl` is a *candidate
 *    pool*: samples for a pattern have to accumulate somewhere across games before
 *    the gate can pass, so the file holds candidates, not only winners. Skipping
 *    this check here would make the pool itself injectable, which is the bug this
 *    guard exists to prevent.
 * 2. **The human `enabled` flag** - SPEC §5.3 says the engine only advises and
 *    nothing changes globally until a human confirms it. Default is off.
 *
 * Ranked by mean payoff, then id for stability.
 */
export function selectStrategies(
	list: StrategyCard[],
	opts: SelectStrategyOptions = {},
): StrategyCard[] {
	const limit = Number.isFinite(Number(opts.limit))
		? Number(opts.limit)
		: MAX_STRATEGIES_INJECTED;
	return (Array.isArray(list) ? list : [])
		.filter((c) => c && c.enabled === true)
		.filter((c) => evaluatePromotion(c).promoted)
		.map((c) => ({ card: c, value: evaluatePromotion(c).value }))
		.sort((a, b) => {
			if (b.value !== a.value) return b.value - a.value;
			return a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0;
		})
		.slice(0, Math.max(0, limit))
		.map((x) => x.card);
}

/** One line per card: this text is spliced into a prompt, so no embedded newlines. */
export function formatStrategiesForInjection(list: StrategyCard[]): string[] {
	return (Array.isArray(list) ? list : [])
		.filter((c) => c && typeof c.action === "string" && c.action)
		.map((c) => {
			const params = canonicalParams(c.params).replace(/[ns]:/g, "");
			const value = Math.round(evaluatePromotion(c).value);
			return `WORKED: ${c.action}${params === "{}" ? "" : ` with ${params}`} (avg +${value} profit/game day in runs where it appeared)`;
		});
}
