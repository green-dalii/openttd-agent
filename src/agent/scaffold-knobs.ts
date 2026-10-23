/**
 * Scaffold knobs (D4 / S6) — the run-shape settings a benchmark must vary.
 *
 * 职责: 把"思考档位 / 每决策工具预算"从**代码里写死的常量**变成可配置的旋钮，
 *   并保证**非法值直接报错**（不静默回退——静默回退会让"我们扫了 high 档"变成谎话）。
 * 为什么是契约不是偏好: 基准评测要在同一套脚手架下比较模型，就必须能独立扫这两个
 *   变量；它们的值也必须进 manifest（`src/agent/scaffold-fingerprint.ts` 的指纹
 *   只覆盖提示词与工具，旋钮另行记录）。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §4 的 S6；SPEC.md §10.120。
 * 禁止: 在此读取文件或环境以外的状态；禁止把"请求值"当成"生效值"。
 */

/** Thinking levels the agent runtime accepts. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** Default per-decision tool-call budget (unchanged behaviour). */
export const DEFAULT_TOOL_BUDGET = 12;

export interface ScaffoldKnobs {
	thinkingLevel: ThinkingLevelName;
	toolBudget: number;
}

/**
 * Resolve the knobs from an environment-like record.
 *
 * Throws on an unknown thinking level or a non-positive / non-numeric budget:
 * a benchmark that silently falls back cannot claim what it ran.
 */
export function resolveScaffoldKnobs(env: Record<string, string | undefined>): ScaffoldKnobs {
	const rawThinking = (env.LLM_THINKING ?? "").trim();
	const thinkingLevel: ThinkingLevelName = rawThinking === "" ? "off" : (rawThinking as ThinkingLevelName);
	if (rawThinking !== "" && !THINKING_LEVELS.includes(thinkingLevel)) {
		throw new Error(`LLM_THINKING: unknown "${rawThinking}" (${THINKING_LEVELS.join("|")})`);
	}

	const rawBudget = (env.LLM_TOOL_BUDGET ?? "").trim();
	let toolBudget = DEFAULT_TOOL_BUDGET;
	if (rawBudget !== "") {
		const n = Number(rawBudget);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
			throw new Error(`LLM_TOOL_BUDGET: expected a positive integer, got "${rawBudget}"`);
		}
		toolBudget = n;
	}
	return { thinkingLevel, toolBudget };
}
