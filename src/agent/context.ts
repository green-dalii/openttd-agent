/**
 * Agent context — transformContext: history pruning + teachable injection.
 *
 * 职责: 在每次 LLM 调用前精简上下文（保留 system + 最近 N 条消息），并为
 *   v0.3 的 lessons/策略库注入预留 hook（SPEC §4.1 transformContext）。
 * 事实来源: SPEC §4.1（剪枝历史 + 注入检索结果）、§5.2（lessons/策略）。
 * 禁止: 在此执行检索 IO（由注入的 provider 负责）；禁止丢弃最近的工具结果
 *   （否则 LLM 看不到自己刚做的事）。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface PruningOptions {
	/** Max recent messages to keep (excluding injected lessons). Default 40. */
	keepRecent?: number;
	/**
	 * Optional lesson provider (v0.3). Returns short strings to inject as a
	 * system-ish reminder before the recent window. Absent = no injection.
	 */
	lessonsProvider?: () => string[] | Promise<string[]>;
	/**
	 * The agent's own measured scores in earlier comparable games (S5).
	 *
	 * A fact block (numbers + measurement conditions), returned as one string.
	 * `null` = nothing comparable to report, and then nothing is injected - an
	 * empty block would read as "you scored nothing before", which is a
	 * different claim.
	 */
	scoreHistoryProvider?: () => string | null | Promise<string | null>;
}

/**
 * Build a transformContext function: prune to the recent window and inject
 * lessons (when a provider is configured). Pure given inputs — unit-testable.
 */
export function pruningTransformContext(
	opts: PruningOptions = {},
): (messages: AgentMessage[]) => Promise<AgentMessage[]> {
	const keepRecent = opts.keepRecent ?? 40;
	return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
		const lessons = opts.lessonsProvider ? await opts.lessonsProvider() : [];
		const scoreHistory = opts.scoreHistoryProvider ? await opts.scoreHistoryProvider() : null;
		// Keep the tail. D2/S2: there is no pinned observation any more - the
		// world snapshot used to be appended as a `game_observation` message that
		// never reached the model, while the audit trail recorded the same
		// snapshot. The prompt carries the facts, and it is in the tail.
		const recent = messages.length > keepRecent ? messages.slice(messages.length - keepRecent) : messages;
		const reminders: AgentMessage[] = [];
		// The agent's own trajectory first (S5): the most concrete self-assessment
		// fact there is. Facts only - no verdict about them.
		if (scoreHistory) {
			reminders.push({ role: "user", content: scoreHistory } as AgentMessage);
		}
		if (lessons.length > 0) {
			reminders.push({
				role: "user",
				content: `Recorded outcomes from your own previous games:\n- ${lessons.join("\n- ")}`,
			} as AgentMessage);
		}
		if (reminders.length === 0) return recent;
		return [...reminders, ...recent];
	};
}
