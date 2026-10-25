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
 */

export type ProblemCode =
	| "unknown_provider"
	| "unknown_model"
	| "no_credential"
	| "unpriced_with_cost_cap"
	| "invalid_base_url"
	| "provider_unavailable";

export interface Problem {
	code: ProblemCode;
	/** 发生了什么（不含猜测）。 */
	message: string;
	/** 下一步做什么（可执行）。 */
	hint: string;
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
