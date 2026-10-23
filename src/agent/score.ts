/**
 * The agent's own score facts (S1).
 *
 * 职责: 把"这一局考了多少分"变成**模型可见的事实**。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §2.1（`score` 块的形状与语义）；
 *   计分口径见 SPEC.md §10.65（`deliveredRun` = 跨季度积分的累计交付）。
 * 为什么存在: 系统提示词告诉模型"一局按每游戏日交付量计分"，却从不告诉它自己
 *   考了多少分——于是模型无法自我评估，信用分配也没有起点（契约 §5.2 的
 *   Reward/Credit assignment 两行长期是 ❌）。
 * 禁止: 在此给出任何评价（"落后了/做得好"）——只给读数与它的条件。
 * 铁律: 缺失不折零（D60）；`delivered` 必须与该局度量行的 `deliveredRun` 同源同值，
 *   否则模型看到的分与最终被记的分不是同一个分。
 */

/** 模型可见的成绩事实（与契约 §2.1 的形状逐字对应）。 */
export interface ScoreFact {
	/** 本局累计交付（null = 还没有交付读数）。 */
	delivered: number | null;
	/** delivered / elapsedGameDays（两者任一未知则 null）。 */
	deliveredPerGameDay: number | null;
	/** 本局已经历的游戏日。 */
	elapsedGameDays: number;
	/** 本局 horizon（未设则 null）。 */
	horizonDays: number | null;
	/** 计分窗口开启的那一天（null = 整局都是窗口）。 */
	scoredFromGameDay: number | null;
	/** 计分窗口是否已开启（预建场景在路线能运货之前为 false）。 */
	windowOpened: boolean;
}

/** 投影成绩事实所需的输入（全部是事实，缺一即为 null）。 */
export interface ScoreInputs {
	/** 本局累计交付读数（null = 尚未测到）。 */
	deliveredTotal: number | null;
	/** 当前游戏日（本局已历）。 */
	gameDay: number;
	/** 本局 horizon（null = 未设）。 */
	horizonDays: number | null;
	/** 计分窗口开启的游戏日（null = 整局都是窗口）。 */
	scoredFromGameDay: number | null;
	/** 计分窗口是否已开启。 */
	windowOpened: boolean;
}

/** 四位小数：给模型看的速率不需要更多精度，也不会引入浮点噪声尾巴。 */
function round4(v: number): number {
	return Math.round(v * 10000) / 10000;
}

/**
 * 把输入投影成模型可见的成绩事实。纯函数。
 *
 * 语义（契约 §2.1）：
 * - `delivered` 就是度量口径的累计交付（同一个数）。
 * - `deliveredPerGameDay` 在分母为 0 或分子未知时是 `null`（**不是 0**）。
 * - `scoredFromGameDay` / `windowOpened` 只陈述计分窗口，不评价。
 */
export function projectScore(i: ScoreInputs): ScoreFact {
	const elapsedGameDays = Number.isFinite(i.gameDay) ? Math.max(0, i.gameDay) : 0;
	const delivered = typeof i.deliveredTotal === "number" && Number.isFinite(i.deliveredTotal) ? i.deliveredTotal : null;
	const perDay = delivered !== null && elapsedGameDays > 0 ? round4(delivered / elapsedGameDays) : null;
	return {
		delivered,
		deliveredPerGameDay: perDay,
		elapsedGameDays,
		horizonDays: typeof i.horizonDays === "number" && Number.isFinite(i.horizonDays) ? i.horizonDays : null,
		scoredFromGameDay:
			typeof i.scoredFromGameDay === "number" && Number.isFinite(i.scoredFromGameDay) ? i.scoredFromGameDay : null,
		windowOpened: i.windowOpened === true,
	};
}

/** 模型可见的一行成绩（用于运行日志；facts only）。 */
export function formatScoreFact(s: ScoreFact): string {
	return (
		`delivered=${s.delivered ?? "not measured"}` +
		` perGameDay=${s.deliveredPerGameDay ?? "unknown"}` +
		` elapsedGameDays=${s.elapsedGameDays}` +
		` horizon=${s.horizonDays ?? "none"}` +
		` scoredFromDay=${s.scoredFromGameDay ?? "run start"}` +
		` window=${s.windowOpened ? "open" : "not open"}`
	);
}
