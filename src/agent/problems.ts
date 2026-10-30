/**
 * 结构化的"做不了"——一个 code、一句发生了什么、一句下一步做什么。
 *
 * 职责: 让 UI 按 `code` 渲染（而不是用正则猜文案），并让调用方能区分
 *   "模型不存在" / "没有凭据" / "端点拒绝" 这些**可执行**的差别。
 * 禁止: 把密钥、完整 baseUrl 之类的敏感内容放进 message/hint。
 * 事实来源: docs/SELECTION-STATE-CODESIGN.md §4.1；docs/DASHBOARD-CODESIGN.md §3 F8。
 *
 * 为什么单独成文件: 服务端（web）不认识 agent 层，但它需要把 `problems[]` 原样
 *   交给浏览器。形状只有这一份，B5 会把其余错误也迁过来。
 *
 * **B5：每个 code 只有一个规范 hint。** 此前同一个 401 在 Providers、启动失败、
 *   门禁结果里会出现三种不同文案（每个页面自己用正则猜）。现在 hint 由这张表
 *   给出，生产方只负责写"发生了什么"（message，带上具体是谁/哪个 URL）。
 */

export type ProblemCode =
	/** A run knob (seed, days, scenario, arm, thinking, budget, cap, backend) is illegal. */
	| "invalid_knob"
	| "unknown_provider"
	| "unknown_model"
	| "no_credential"
	| "unpriced_with_cost_cap"
	| "invalid_base_url"
	| "provider_unavailable"
	/** The provider answered 401: the stored key was rejected. */
	| "endpoint_401"
	/** The provider answered 403: the key may not list models. */
	| "endpoint_403"
	/** The provider has no model-list endpoint (404 on every candidate). */
	| "no_model_endpoint";

/** Every code, in one list (the vocabulary is closed: no ad-hoc codes). */
export const PROBLEM_CODES: readonly ProblemCode[] = [
	"invalid_knob",
	"unknown_provider",
	"unknown_model",
	"no_credential",
	"unpriced_with_cost_cap",
	"invalid_base_url",
	"provider_unavailable",
	"endpoint_401",
	"endpoint_403",
	"no_model_endpoint",
];

export interface Problem {
	code: ProblemCode;
	/** 发生了什么（不含猜测）。 */
	message: string;
	/** 下一步做什么（可执行）。 */
	hint: string;
}

/**
 * The one canonical hint per code — "同一个错，在任何地方都长一个样"。
 *
 * 只写**动作**（做什么），不写事实（发生了什么）：事实属于 message，由知道现场
 * 的那一层写（哪个 provider、哪个 URL）。
 */
const HINTS: Record<ProblemCode, string> = {
	invalid_knob: "fix the highlighted knob on the Configure page, then start again",
	unknown_provider: "pick a provider from the catalog on the Providers page",
	unknown_model: 'press "Refresh from provider" on the Providers page, then pick a model from the list',
	no_credential: "enter the API key on the Providers page and save it",
	unpriced_with_cost_cap: "remove the cost cap, or pick a model that has a price table",
	invalid_base_url: "fill in the endpoint URL (e.g. http://127.0.0.1:11434/v1) on the Providers page",
	provider_unavailable: "check the endpoint URL and the network, then try again",
	endpoint_401: "the provider rejected the stored key: re-enter it below, then refresh again",
	endpoint_403: "this key may not list models: the bundled snapshot stays authoritative",
	no_model_endpoint: "this provider has no model-list endpoint: the bundled snapshot is the only source",
};

/** The canonical hint for a code (never empty). */
export function problemHint(code: ProblemCode): string {
	return HINTS[code];
}

/**
 * Build a problem: the code, what happened, and the action.
 *
 * `hint` may be overridden when the producer knows better (e.g. it can name the
 * exact field); otherwise the canonical hint for the code is used.
 */
export function problem(code: ProblemCode, message: string, hint?: string): Problem {
	return { code, message, hint: hint ?? problemHint(code) };
}

/** 带结构化原因的拒绝。`save` 抛它 => HTTP 400 + problems[]，且不落盘。 */
export class ProblemError extends Error {
	readonly problems: Problem[];

	constructor(problems: Problem[]) {
		super(problems.map((p) => `${p.message}${p.hint ? ` — ${p.hint}` : ""}`).join("; "));
		this.name = "ProblemError";
		this.problems = problems;
	}
}
