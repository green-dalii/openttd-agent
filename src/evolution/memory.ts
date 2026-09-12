/**
 * Memory loading — 开局把跨局记忆读成"可注入"的形状（SPEC §5.1 第一步）。
 *
 * 职责: 读 lessons/strategies 库 → 选出本局要注入的 → 渲染成可注入的行 →
 *   提供**诚实的注入计数**（写进 metrics 的对照实验自变量）。
 * 事实来源: SPEC §5.1（加载 policy）、§5.2、§5.3；docs/EVOLUTION.md §3/§4。
 * 禁止: 在此调用 LLM 或反思（见 reflection-run.ts）。
 *
 * 为什么计数要与行数一致:metrics 里的 `memory.lessonsInjected` 是「带/不带 lessons」
 * 对照实验的**自变量**。如果它记的数字与实际注入的内容不符,整个 M3 验收
 * （同 seed 带/不带各 3 局对比）就建立在一个假数字上。
 */

import { formatForInjection, selectLessons, type Lesson } from "./lessons.js";
import { formatStrategiesForInjection, selectStrategies, type StrategyCard } from "./strategies.js";
import { readLessons, readStrategies } from "./store.js";

/** What this run will be told about previous games. */
export interface LoadedMemory {
	lessons: Lesson[];
	strategies: StrategyCard[];
	/** Ready-to-inject lines (lessons first, then strategy cards). */
	lines: string[];
}

export interface LoadMemoryOptions {
	now?: number;
	/** Max lessons to inject. Defaults to MAX_LESSONS_INJECTED. */
	limit?: number;
	/** Max strategy cards to inject. Defaults to MAX_STRATEGIES_INJECTED. */
	strategyLimit?: number;
}

/**
 * Read the library and pick this run's injection set.
 *
 * Selecting once at session start (rather than on every LLM call) keeps the
 * injected set stable for the whole game — otherwise the model's context would
 * shift under it mid-run, and the recorded injection count would be ambiguous.
 */
export function loadMemory(dataDir: string, opts: LoadMemoryOptions = {}): LoadedMemory {
	const now = opts.now ?? Date.now();
	let lessons: Lesson[] = [];
	let strategies: StrategyCard[] = [];
	try {
		lessons = selectLessons(readLessons(dataDir), { now, limit: opts.limit });
		strategies = selectStrategies(readStrategies(dataDir), { limit: opts.strategyLimit });
	} catch {
		// A broken library must not stop a game from starting.
		return { lessons: [], strategies: [], lines: [] };
	}
	const lines = [
		...formatForInjection(lessons),
		...formatStrategiesForInjection(strategies),
	];
	return { lessons, strategies, lines };
}

/**
 * The provider handed to `pruningTransformContext` (src/agent/context.ts).
 *
 * Returns a fresh array each call so the context layer cannot mutate our state,
 * and is stable across calls so the injected set does not drift mid-run.
 */
export function makeLessonProvider(mem: LoadedMemory): () => string[] {
	const lines = [...(mem?.lines ?? [])];
	return () => [...lines];
}

/** Injection counts for the metrics ledger (the experiment's independent variable). */
export function memoryCounts(mem: LoadedMemory): { lessonsInjected: number; strategiesInjected: number } {
	return {
		lessonsInjected: (mem?.lessons ?? []).length,
		strategiesInjected: (mem?.strategies ?? []).length,
	};
}
