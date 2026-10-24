/**
 * Tool budget — the per-decision call budget, in ONE place.
 *
 * 职责: 决定一次决策窗口内"还能不能调工具"，并给出**逐字固定**的拒绝理由。
 *   路径无关：裸 `Agent`（beforeToolCall）与 harness（before_tool hook）都用它，
 *   否则两条路径会在"模型看到的拒绝文案"上分叉 —— 而那句文案是模型唯一的
 *   反馈，分叉就等于两个不同的 scaffold（基准不可比）。
 * 事实来源: SPEC §4.1；ADR §10.74（R1 工具预算）。
 * 禁止: 在这里做 IO / 记日志；禁止让被拒绝的调用消耗预算。
 */

/** Normal decisions use 2–3 tool calls; a runaway measured 17.5 per decision. */
export const DEFAULT_MAX_TOOL_CALLS_PER_DECISION = 12;

/** The refusal text handed back to the model. Byte-for-byte the same on both paths. */
export function budgetRefusal(budget: number): string {
	return (
		`tool budget for this decision is exhausted (${budget} calls used). ` +
		"Further tool calls in this decision are refused. Answer with the " +
		"observations you already have; you get a fresh budget next decision."
	);
}

/** Per-decision counter. One instance per run; `reset()` at each decision boundary. */
export class ToolBudget {
	private calls = 0;
	private blocks = 0;

	constructor(private readonly limit: number = DEFAULT_MAX_TOOL_CALLS_PER_DECISION) {}

	/**
	 * Admit one call.
	 *
	 * @returns `undefined` when allowed (and the call is counted), otherwise the
	 *   refusal reason. A refused call must NOT consume budget — the model gets
	 *   the same number of usable calls regardless of how often it retries.
	 */
	admit(): string | undefined {
		if (this.limit > 0 && this.calls >= this.limit) {
			this.blocks += 1;
			return budgetRefusal(this.limit);
		}
		this.calls += 1;
		return undefined;
	}

	reset(): void {
		this.calls = 0;
	}

	/** Calls admitted in the current decision window. */
	get used(): number {
		return this.calls;
	}

	/** Cumulative refusals across the run (channel health, SPEC §10.66). */
	get blocked(): number {
		return this.blocks;
	}
}
