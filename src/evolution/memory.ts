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
import { readLessonsReport, readStrategies } from "./store.js";

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
	/**
	 * Put the library into the agent's context. DEFAULT TRUE.
	 *
	 * Cross-game memory is the mechanism of self-evolution: without it every game
	 * starts from zero and the agent can never accumulate anything. So it is ON.
	 *
	 * The project scope (SPEC §10.22) constrains the CONTENT, not the existence:
	 * what is injected must be a record of what the agent itself observed in
	 * earlier games, never the harness's advice. That is why lessons are phrased
	 * as statements about the past (`Previously ...`) rather than imperatives
	 * (`DO:` / `AVOID:`), and why remembered strategies only enter after a human
	 * confirms them (SPEC §5.3).
	 *
	 * Set false for the control arm of the M3 experiment (same seed, with vs
	 * without memory). When off the library is not read at all, so the recorded
	 * count of 0 is a fact rather than "read but not injected".
	 */
	inject?: boolean;
}

/**
 * Read the library and pick this run's injection set.
 *
 * Selecting once at session start (rather than on every LLM call) keeps the
 * injected set stable for the whole game — otherwise the model's context would
 * shift under it mid-run, and the recorded injection count would be ambiguous.
 */
export function loadMemory(dataDir: string, opts: LoadMemoryOptions = {}): LoadedMemory {
	// Nothing is injected unless explicitly asked for. Returning early (rather
	// than reading and then discarding) also keeps `lessonsInjected: 0` honest:
	// the count must describe what the agent actually received.
	if (opts.inject === false) return { lessons: [], strategies: [], lines: [] };
	const now = opts.now ?? Date.now();
	let lessons: Lesson[] = [];
	let strategies: StrategyCard[] = [];
	try {
		// R2：读取时报告被排除的旧形状条目（祈使句，没有实测读数）。
		// 不重写磁盘，但**必须可见**——静默过滤会让"这次带了记忆"变成假的。
		const lib = readLessonsReport(dataDir);
		if (lib.legacyDropped > 0) {
			// eslint-disable-next-line no-console
			console.log(
				`[memory] ignored ${lib.legacyDropped} legacy lesson(s): they are advice without a measured ` +
					"reading, which R2 no longer counts as experience (SPEC §10.76)",
			);
		}
		lessons = selectLessons(lib.lessons, { now, limit: opts.limit });
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
/**
 * 按需检索：在当前这一局的记忆快照里找记录（M4a，SPEC §10.89）。
 *
 * 为什么必须有它：注入是"开局一次性、整体"的，agent 既**无法按需取用**，
 * 我们也**无法观测记忆到底有没有被用**。检索让"用没用"第一次成为可测量的事实
 * （`recallCalls`），这也是"选择压力"（哪条经验真的有用）唯一现实的数据入口。
 *
 * 语义刻意保持**朴素且诚实**：`query` 是**大小写不敏感的子串匹配**，
 * 不是语义检索——工具描述里就这么写，避免模型误以为它懂同义词。
 * 无 query 时返回最近的若干条（"我有什么"）。
 */
export function recallLessons(
	mem: LoadedMemory | null | undefined,
	opts: { query?: string; limit?: number } = {},
): Lesson[] {
	const all = mem?.lessons ?? [];
	const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
	const q = (opts.query ?? "").trim();
	if (!q) return all.slice(-limit).reverse(); // 最近的在前

	// **词级匹配 + 重叠排序**（SPEC §10.89 第二版）。
	//
	// 第一版是子串匹配，真机实测被"咬"了：模型问的是概念
	// （`recall("road completion tiles per day")`），而记录是自由文本句子 →
	// 两条真实查询都 0 命中。子串要求整串连续出现，对自然提问几乎不可能满足。
	//
	// 现在：把 query 拆成词（**去掉停用词与过短词**，否则 "the"/"of" 会让整库命中），
	// 任何一词出现即算命中，并按**命中的不同词数**排序——重叠越多越靠前。
	// 仍然是确定性的、可单测的，且契约里如实写"按词匹配"而不是假装语义检索。
	const words = q
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
	if (words.length === 0) return [];

	const scored = all
		.map((l) => {
			const hay = String(l.text ?? "").toLowerCase();
			let score = 0;
			for (const w of new Set(words)) if (hay.includes(w)) score++;
			return { l, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((x) => x.l);
	// **不要**再 reverse：这里已经按相关度排好，翻转会把最不相关的排到第一
	// （第一版就是这样：排序对了、结果反了，测试当场抓到）。
	return scored;
}

/** 不参与匹配的常见词：它们出现在几乎每条记录里，命中等同噪声。 */
const STOP_WORDS = new Set([
	"the", "and", "was", "were", "for", "with", "that", "this", "from", "are", "not", "but",
	"per", "into", "over", "its", "his", "her", "they", "them", "then", "than", "have", "has",
	"had", "you", "your", "our", "all", "any", "can", "will", "would", "about", "after",
]);

/** 把一条记录渲染成给模型看的**事实行**（含它的实测读数；没有读数的不参与记忆）。 */
export function renderRecallHit(l: Lesson): string {
	const o = l.outcome;
	const reading = o ? `${o.metric} ${o.before} -> ${o.after}` : "no reading";
	return `[${l.id}] ${l.text} (${reading}; evidence: ${l.evidence ?? "none"})`;
}

export function makeLessonProvider(mem: LoadedMemory): () => string[] {
	const lines = [...(mem?.lines ?? [])];
	return () => [...lines];
}

/** Injection counts for the metrics ledger (the experiment's independent variable). */
export function memoryCounts(mem: LoadedMemory): {
	routeFactsInjected?: number;
	lessonsInjected: number;
	strategiesInjected: number;
} {
	return {
		lessonsInjected: (mem?.lessons ?? []).length,
		strategiesInjected: (mem?.strategies ?? []).length,
	};
}
