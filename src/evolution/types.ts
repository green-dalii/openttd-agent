/**
 * Shared types for the evolution / memory system.
 *
 * 职责: 记忆系统所有持久化实体的**单一事实源**（AGENTS §2.5）。
 * 事实来源: SPEC §5.2、docs/EVOLUTION.md §2。
 * 禁止: 在此放逻辑或 IO。
 */

/** A lesson is either something that worked ("do") or something that hurt ("dont"). */
export type LessonKind = "do" | "dont";

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
	text: string;
	kind: LessonKind;
	/** 0..1, supplied by reflection (clamped) or a conservative default. */
	confidence: number;
	/** Game facts backing this lesson. Must never be empty for a stored lesson. */
	evidence: string[];
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
