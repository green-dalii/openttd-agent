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
}

/** Messages that must never be pruned away (they carry the current decision). */
function isPinned(msg: AgentMessage): boolean {
	const role = (msg as { role?: string }).role;
	// Keep the most recent observation/result chain visible to the model.
	return role === "game_observation";
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
		let recent = messages;
		if (messages.length > keepRecent) {
			// Keep the tail; re-attach any pinned observation inside the window.
			recent = messages.slice(messages.length - keepRecent);
			const pinned = messages.slice(0, messages.length - keepRecent).filter(isPinned);
			// Only the LAST pinned observation matters (current state).
			if (pinned.length > 0) recent = [pinned[pinned.length - 1]!, ...recent];
		}
		if (lessons.length === 0) return recent;
		const reminder: AgentMessage = {
			role: "user",
			content: `Recorded outcomes from your own previous games:\n- ${lessons.join("\n- ")}`,
		} as AgentMessage;
		return [reminder, ...recent];
	};
}
