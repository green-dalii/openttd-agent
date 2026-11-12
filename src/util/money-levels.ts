/**
 * 资金档位比较 —— 确定性探针（Issue #106）的**判据**。
 *
 * 职责: 给两局"钱经过的取值序列"，回答"这两局的钱是不是同一条轨迹"。
 * 纯函数，无 IO。
 * 禁止: 任何策略判断、任何"差不多就算一样"的宽容阈值。
 *
 * 为什么**不比"逐日的钱"**（2026-11-12 真机踩到）：
 * 钱只在**施工事件**那一刻变，而 admin 的日期包与经济包是**各自到达**的
 * ⇒ 一笔支出落在"这一天"还是"那一天"取决于**采样相位** ⇒ 同一局读两次
 * 可以在同一天差出一个施工事件的金额（实测 day 17 差 £4921，而两局的
 * **档位集合完全相同** ⇒ 是相位，不是分叉）。
 * 档位序列与相位无关 ⇒ 这才是可比的东西。
 *
 * 为什么**必须能说"没测到"**：两局都没有读到钱 ⇒ 集合都空 ⇒ "相同"是
 * 空洞的真 ⇒ 判据必须显式区分 `measured: false`（没测到）与
 * `same: true`（测到了且一致）。
 */

export interface MoneySample {
	/** 游戏日（引擎日历里的年内第几天）。 */
	day: number;
	/** 那一刻读到的钱。 */
	money: number;
}

/** 有序去重的资金档位（只在钱**变了**时追加 —— 钱只在事件时变）。 */
export function moneyLevels(samples: readonly MoneySample[]): number[] {
	const levels: number[] = [];
	for (const s of samples) {
		if (!Number.isFinite(s.money)) continue;
		const last = levels[levels.length - 1];
		if (last === undefined || last !== s.money) levels.push(s.money);
	}
	return levels;
}

export interface MoneyLevelComparison {
	/** 两局都读到钱了吗？（没读到 ⇒ `same` 无意义，看 `measured`） */
	measured: boolean;
	/**
	 * 这个比较**有鉴别力**吗？（两局都**发生过变化**才算）
	 *
	 * 只有一档钱（钱从头到尾没变）⇒ 任何两局都"相同" ⇒ 结论是**空洞的真**：
	 * 它不能证明"可复现"，只说明"没看见变化"（例：一局里施工根本没花钱）。
	 * ⇒ 这种情形必须说"没测到"，不许说"相同"。
	 */
	powerful: boolean;
	/** 档位**集合**是否相同（与顺序无关）。 */
	same: boolean;
	/** 只在 A 出现的档位。 */
	onlyInA: number[];
	/** 只在 B 出现的档位。 */
	onlyInB: number[];
	/** 档位**顺序**是否逐项相同（比 `same` 更严）。 */
	sequenceSame: boolean;
	/** 顺序第一个不同的位置（`sequenceSame` 为 true 时为 null）。 */
	firstSequenceDiff: { index: number; a: number; b: number } | null;
	/** A 的档位个数 / B 的档位个数。 */
	countA: number;
	countB: number;
}

/**
 * 比较两局的资金档位。
 *
 * - `measured: false` ⇒ 没测到（不是"相同"）。
 * - `same` 看**集合**（相位无关的判据）。
 * - `sequenceSame` 看**顺序**（更强：同一笔支出必须出现在同一位置）。
 */
export function compareMoneyLevels(a: readonly number[], b: readonly number[]): MoneyLevelComparison {
	const setA = new Set(a);
	const setB = new Set(b);
	const onlyInA = [...setA].filter((v) => !setB.has(v)).sort((x, y) => x - y);
	const onlyInB = [...setB].filter((v) => !setA.has(v)).sort((x, y) => x - y);
	let firstSequenceDiff: { index: number; a: number; b: number } | null = null;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) {
			firstSequenceDiff = { index: i, a: a[i]!, b: b[i]! };
			break;
		}
	}
	return {
		measured: a.length > 0 && b.length > 0,
		powerful: a.length > 1 && b.length > 1,
		same: onlyInA.length === 0 && onlyInB.length === 0,
		onlyInA,
		onlyInB,
		sequenceSame: firstSequenceDiff === null && a.length === b.length,
		firstSequenceDiff,
		countA: a.length,
		countB: b.length,
	};
}
