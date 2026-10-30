/**
 * The runs grouped by the ledger's own fields (B6).
 *
 * 职责: 把度量行按 **servedModel / seed / backend** 分组，供 History 页的分组视图用。
 * 为什么在服务端分组: CoDesign F10 要"按模型/按 seed/按后端"看局，而**分组键必须来自
 *   度量行自己的字段**——页面自己按字符串猜分组，就会和账本对不上（"哪个模型"这件事
 *   有两个来源：`manifest.servedModel` 与请求的模型，替身网关会让两者不同）。
 * 铁律:
 *   - **不推断**：键只从行里读，读不到就是 `unknown`（不是"空"）。
 *   - **只读**：不写文件、不发起运行。
 * 事实来源: docs/DASHBOARD-CODESIGN.md §3 F10；src/evolution/metrics.ts 的行定义。
 */

import type { GameMetric } from "./metrics.js";

/** The three ways the History page can group the runs. */
export type GroupBy = "model" | "seed" | "backend";

/** One group: the key, how many runs it holds, and which sessions are in it. */
export interface HistoryGroup {
	/** The group's key (a model id, a seed, a backend name). */
	key: string;
	/** How many runs are in the group. */
	count: number;
	/** The session ids in the group (the page filters its list by these). */
	sessions: string[];
}

/** The key a row belongs to, read from the row itself. */
function keyOf(m: GameMetric, by: GroupBy): string {
	if (by === "seed") return Number.isFinite(m.seed) ? String(m.seed) : "unknown";
	if (by === "backend") return m.manifest?.backend ?? "unknown";
	// "model" = the model that **served** the run (a gateway substitute is a
	// different model than the one requested, and the served one is the fact).
	return m.manifest?.servedModel || m.llmModel || "unknown";
}

/**
 * Group the runs by one of the ledger's own fields.
 *
 * Sorted by count (descending), then by key, so the order is stable and the
 * biggest group comes first.
 */
export function historyGroups(metrics: GameMetric[], by: GroupBy): HistoryGroup[] {
	const groups = new Map<string, string[]>();
	for (const m of Array.isArray(metrics) ? metrics : []) {
		if (!m || typeof m !== "object") continue;
		const key = keyOf(m, by);
		const list = groups.get(key);
		if (list) list.push(String(m.id ?? ""));
		else groups.set(key, [String(m.id ?? "")]);
	}
	return [...groups.entries()]
		.map(([key, sessions]) => ({ key, count: sessions.length, sessions }))
		.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
