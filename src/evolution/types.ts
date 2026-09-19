/**
 * Shared types for the evolution / memory system.
 *
 * 职责: 记忆系统所有持久化实体的**单一事实源**（AGENTS §2.5）。
 * 事实来源: SPEC §5.2、docs/EVOLUTION.md §2。
 * 禁止: 在此放逻辑或 IO。
 */

/**
 * The measured quantity an observation is about.
 *
 * 为什么不是旧的 `kind: "do"|"dont"`（2026-09-18，R2）：`do`/`dont` 把经验塑造成
 * **指令**（"DO: build one route first"），而本项目是 RL harness——框架给事实与因果，
 * 不给策略（SPEC §10.22）。真机库里 12 条有 10 条、27 条有 15 条正是这种祈使句。
 * 取代它的是一条**实测读数**：观察是关于哪个量、动手前后各是多少。
 */
export type LessonMetric =
	| "delivered"
	| "deliveredPerDay"
	| "income"
	| "money"
	| "vehicles"
	| "stations"
	| "construction";

/** Before/after readings of one measured quantity — what makes a lesson evidence-backed. */
export interface LessonOutcome {
	metric: LessonMetric;
	before: number;
	after: number;
}

/**
 * A distilled, reusable lesson from a finished game (SPEC §5.2 机制 1).
 *
 * `evidence` is deliberately not optional: SPEC §5.3 forbids speculating about
 * causes, so every lesson must cite game facts. `supersededBy` exists because a
 * later game may disprove an earlier one.
 */
export interface Lesson {
	/** Stable id derived from the normalized text — the dedupe/supersede key. */
	id: string;
	/**
	 * A statement about what happened in a recorded game — never an instruction.
	 * Enforced by `isImperative` at production and again at injection.
	 */
	text: string;
	/** The measured readings this statement is about (replaces the old `kind`). */
	outcome: LessonOutcome;
	/** 0..1, supplied by reflection (clamped) or a conservative default. */
	confidence: number;
	/** Game facts backing this lesson. Must never be empty for a stored lesson. */
	evidence: string[];
	/** Ids this observation contradicts; applied to their `supersededBy` on save. */
	supersedes?: string[];
	sourceSessionId: string;
	sourceSeed: number;
	createdAt: number;
	/** Set when a later game replaces this lesson; superseded lessons are not injected. */
	supersededBy?: string;
}

/**
 * A parameterised "this pattern worked" card (SPEC §5.2 机制 2).
 *
 * `valuePerRun` holds one sample per verified game rather than an average: the
 * promotion gate is "value above threshold AND verified in >= 2 games", and a
 * scalar average cannot answer how many games it was verified in.
 */
export interface StrategyCard {
	id: string;
	name: string;
	/** Tool/action this pattern applies to, e.g. "build_bus_route". */
	action: string;
	params: Record<string, number | string>;
	/** One payoff sample per verified game. */
	valuePerRun: number[];
	evidence: string[];
	sourceSessionIds: string[];
	createdAt: number;
	/** Human/UI confirmation gate — see docs/EVOLUTION.md §3 (default off). */
	enabled?: boolean;
}
