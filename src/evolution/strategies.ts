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

/** 价值门槛:一局至少多赚这么多钱,这个模式才值得记下来。 */
export const MIN_STRATEGY_VALUE = 5000;

/** SPEC §5.3 硬性要求:至少两个独立局验证过。 */
export const MIN_VERIFIED_RUNS = 2;

/** 单次注入策略卡上限。 */
export const MAX_STRATEGIES_INJECTED = 4;

/** 反思/统计产出的一条采样:某个模式在**一局**里的收益。 */
export interface StrategySample {
	action: string;
	params: Record<string, number | string>;
	/** That game's payoff for this pattern (money delta). */
	value: number;
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
	if (typeof action !== "string" || !action.trim()) return "";
	const raw = `${action.trim()}|${canonicalParams(params)}`;
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

/** A usable sample needs an action, a finite value, evidence, and a source game. */
function isValidSample(s: unknown): s is StrategySample {
	if (!s || typeof s !== "object") return false;
	const v = s as StrategySample;
	if (typeof v.action !== "string" || !v.action.trim()) return false;
	if (!Number.isFinite(Number(v.value))) return false;
	if (typeof v.sessionId !== "string" || !v.sessionId) return false;
	if (cleanList(v.evidence).length === 0) return false;
	return true;
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

	for (const card of Array.isArray(existing) ? existing : []) {
		if (card && typeof card.id === "string" && card.id) byId.set(card.id, { ...card });
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
		if (!prev) {
			byId.set(id, {
				id,
				name: s.action,
				action: s.action,
				params: { ...(s.params || {}) },
				valuePerRun: [Number(s.value)],
				evidence,
				sourceSessionIds: [s.sessionId],
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
			valuePerRun: [...(prev.valuePerRun || []), Number(s.value)],
			evidence: mergedEvidence,
			sourceSessionIds: [...sessions].sort(),
			createdAt: Math.min(Number(prev.createdAt) || now, Number(s.createdAt) || now),
		});
	}

	return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface PromotionResult {
	promoted: boolean;
	/** Mean payoff across verified games (0 when there are no usable samples). */
	value: number;
	/** How many games verified it. */
	runs: number;
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
 */
export function evaluatePromotion(
	card: StrategyCard,
	opts: PromotionOptions = {},
): PromotionResult {
	const minValue = Number.isFinite(Number(opts.minValue)) ? Number(opts.minValue) : MIN_STRATEGY_VALUE;
	const minRuns = Number.isFinite(Number(opts.minRuns)) ? Number(opts.minRuns) : MIN_VERIFIED_RUNS;

	const values = (Array.isArray(card?.valuePerRun) ? card.valuePerRun : []).filter((v) =>
		Number.isFinite(Number(v)),
	);
	const runs = values.length;
	const value = runs ? values.reduce((a, b) => a + Number(b), 0) / runs : 0;

	if (runs < minRuns) {
		return {
			promoted: false,
			value,
			runs,
			reason: `verified in ${runs} game(s), needs >= ${minRuns}`,
		};
	}
	if (!(value > minValue)) {
		return {
			promoted: false,
			value,
			runs,
			reason: `value ${Math.round(value)} does not exceed threshold ${minValue}`,
		};
	}
	return {
		promoted: true,
		value,
		runs,
		reason: `value ${Math.round(value)} over ${runs} games`,
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
 * Strategies eligible for injection: **only human-confirmed ones** (SPEC §5.3),
 * ranked by mean payoff. With nothing confirmed this returns [], which is the
 * intended default — the system must not teach itself without review.
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
			return `WORKED: ${c.action}${params === "{}" ? "" : ` with ${params}`} (avg +${value}/game)`;
		});
}
