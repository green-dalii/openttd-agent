/**
 * Pure decision-loop helpers (REFACTOR Phase B-4a).
 *
 * 职责: 决策循环里的纯逻辑判断——截止日期、wait_until/wait_condition 匹配、
 *   tracker 重建、stage 是否应记入账本。所有函数零副作用、可被单元测试覆盖。
 * 禁止: IO、scheduler/telemetry/audit 调用——这些是 decision-loop.ts 的
 *   impure 层。
 */

/** Cap by run length (SPEC §10.30 教训：原来 `--demo-seconds` 没生效 → 28 分钟 251 次决策). */
export interface LoopDeadline {
	deadline: number | null;
	seconds: number;
}
export function shouldBreakOnDeadline(ctx: LoopDeadline, now: number, stopRequested: boolean): boolean {
	if (stopRequested) return true;
	if (ctx.deadline !== null && now >= ctx.deadline) return true;
	return false;
}

/** Per-run decision cap. */
export function shouldBreakOnCap(count: number, maxDecisions: number): boolean {
	if (maxDecisions > 0 && count > maxDecisions) return true;
	return false;
}

/**
 * Wait-until a number of game days have elapsed since the wait was set.
 * `from` is the day the wait was issued (recorded at plan time).
 */
export interface WaitUntilState {
	waitUntil: { gameDays: number; from: number } | null;
}
export function waitUntilExpired(wait: WaitUntilState, nowDay: number): boolean {
	if (!wait.waitUntil) return false;
	return nowDay - wait.waitUntil.from >= wait.waitUntil.gameDays;
}

/**
 * Textual wait-condition: when the next phase change matches, the wait clears.
 * Matches case-insensitively against the substring.
 */
export function waitConditionMatches(
	phase: string,
	condition: string | null,
): boolean {
	if (!condition) return false;
	// Caller has already lowercased the condition at insertion time;
	// phase is lowercased here so the substring check is case-insensitive.
	return phase.toLowerCase().includes(condition);
}

/** A phase worth recording into the per-decision tracker when it carries the stage gate. */
export function isPhaseWorthRecording(
	raw: string,
): boolean {
	if (!raw) return false;
	// raw always starts with "EX " on real wire (pre-A3 some events were the
	// bare company name, but the GS relay now wraps everything in ExecEvent).
	// Defensive: ignore empty / placeholder values.
	return raw.length > 0 && raw !== "unknown";
}

/** Baseline reset for a fresh causality window after a decision. */
export interface NumbersBaseline { money: number; income: number; vehicles: number; stations: number; gameDay: number; }
export function emptyTrackerAfter(baseline: NumbersBaseline) {
	return {
		baseline,
		phases: [],
		actions: [],
		notableEvents: [],
	};
}