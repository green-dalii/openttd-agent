/**
 * Per-run spend caps (P4 / Issue #27) — how much a run may consume before it stops.
 *
 * 职责: 解析 token/费用上限、判断"是否已到上限"、并保证**无法执行的闸不会静默存在**。
 * 为什么需要: 一场基准是"模型 × seed × 重复"的矩阵；一局原只能被墙钟、工具预算或人
 *   停住，于是"这轮要花多少"没有系统强制的答案。
 * 铁律:
 *   - 非法值抛错，不静默回退（静默回退会让"我们在 N 处截断"变成谎话）。
 *   - 费用闸只在有价目表（`costKnown`）时可执行；无价格却设上限 → 拒绝启动。
 *   - 未知用量 `null` 既不是 0 也不是超限：没测到不能结束一局。
 *   - 比较只有这一处：循环用它停机，`classifyOutcome` 用它命名成因（同一个谓词，
 *     否则"为什么停了"会与"真的停了吗"分歧）。
 * 禁止: 任何 IO、任何对模型的建议。执行点在**决策边界**（单次决策最多超出一个决策的
 *   用量，实测 3–9k tokens——这是已知且被记录的偏差，不假装精确）。
 */

/** A run's spend caps. `null` = no cap. */
export interface RunLimits {
	tokens: number | null;
	cost: number | null;
}

/** No caps: the historical behaviour. */
export const NO_LIMITS: RunLimits = { tokens: null, cost: null };

/** Why a run stopped on spend. */
export type BudgetStop = "token_cap" | "cost_cap";

/** The usage readings the comparison needs (both may be unknown). */
export interface BudgetUsage {
	totalTokens?: number | null;
	costTotal?: number | null;
}

/**
 * Resolve the caps from an environment-like record.
 *
 * Throws on anything that would make a reported cap untrue: non-numeric, zero,
 * negative, or a fractional token count.
 */
export function resolveRunLimits(env: Record<string, string | undefined>): RunLimits {
	const tokens = positive(env.LLM_TOKEN_LIMIT, "LLM_TOKEN_LIMIT", { integer: true });
	const cost = positive(env.LLM_COST_LIMIT, "LLM_COST_LIMIT", { integer: false });
	return { tokens, cost };
}

function positive(
	raw: string | undefined,
	name: string,
	opts: { integer: boolean },
): number | null {
	const text = (raw ?? "").trim();
	if (text === "") return null;
	const n = Number(text);
	if (!Number.isFinite(n)) throw new Error(`${name}: expected a number, got "${text}"`);
	if (n <= 0) throw new Error(`${name}: expected a positive ${opts.integer ? "integer" : "number"}, got "${text}"`);
	if (opts.integer && !Number.isInteger(n)) {
		throw new Error(`${name}: expected a positive integer, got "${text}"`);
	}
	return n;
}

/**
 * Refuse a cost cap the run cannot measure.
 *
 * A model without a price table always reports 0, so a cost cap would never
 * fire. Failing at startup is the honest choice: silently running uncapped
 * while the config says otherwise corrupts the benchmark's budget claim.
 */
export function assertCostCapEnforceable(limits: RunLimits, costKnown: boolean): void {
	if (limits.cost === null) return;
	if (costKnown) return;
	throw new Error(
		`LLM_COST_LIMIT: this model has no price table (costKnown=false), so a cost cap ` +
			`cannot be enforced. Use LLM_TOKEN_LIMIT, or configure a priced model.`,
	);
}

/**
 * Has the run reached a cap?
 *
 * Returns the deterministic reason, or null. Token first: it is measurable for
 * every model, so it wins when both are true.
 */
export function budgetStop(
	limits: RunLimits | null | undefined,
	usage: BudgetUsage,
	costKnown: boolean,
): BudgetStop | null {
	if (!limits) return null;
	const tokens = finiteOrNull(usage.totalTokens);
	if (limits.tokens !== null && tokens !== null && tokens >= limits.tokens) return "token_cap";
	if (!costKnown) return null;
	const cost = finiteOrNull(usage.costTotal);
	if (limits.cost !== null && cost !== null && cost >= limits.cost) return "cost_cap";
	return null;
}

function finiteOrNull(v: number | null | undefined): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}
