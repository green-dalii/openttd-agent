/**
 * Reflection run — 局终的编排（SPEC §5.1 反思 → 蒸馏 → 落盘）。
 *
 * 职责: 调一次模型做复盘 → 解析/校验 → lessons 落盘、策略过门槛后落盘 →
 *   返回一份可记录的**结果报告**。
 * 事实来源: SPEC §5.1、§5.2、§5.3；docs/EVOLUTION.md §5/§6。
 * 禁止: 在此直接依赖 pi-agent-core（模型调用通过注入的 `complete`，便于单测）。
 *
 * 为什么反思失败必须被吞掉:记账（metrics）是"带/不带 lessons"对照实验的地基,
 * 反思只是锦上添花。让一次网络抖动把整局的结果记录带崩,是明显错误的优先级。
 */

import { applySupersessions } from "./lessons.js";
import { buildReflectionPrompt, reflectToLessons, reflectToStrategies } from "./reflect.js";
import { evaluatePromotion, mergeStrategySamples } from "./strategies.js";
import { appendLessons, appendStrategies, readLessons, readStrategies } from "./store.js";
import type { ReflectionFacts } from "./reflect.js";

/** Call the model once with one prompt. Injectable so this module stays testable. */
export type CompleteFn = (prompt: { system: string; user: string }) => Promise<string>;

export interface RunReflectionOptions {
	complete: CompleteFn;
	dataDir: string;
	facts: ReflectionFacts;
	now?: number;
}

export interface ReflectionReport {
	ok: boolean;
	/** Populated when the model call itself failed. */
	error?: string;
	lessonsSaved: number;
	/** Entries this game's observations replaced (the retraction path, R2). */
	lessonsSuperseded: number;
	strategiesPromoted: number;
	/** Raw model reply length — useful for diagnosing empty responses. */
	replyChars: number;
}

/**
 * Reflect on a finished game and persist what survives validation.
 *
 * Never throws: a failed reflection is reported, not propagated. The metrics
 * ledger is written on a separate path (SessionStore.finalize) precisely so that
 * these two concerns cannot take each other down.
 */
export async function runReflection(opts: RunReflectionOptions): Promise<ReflectionReport> {
	const now = opts.now ?? Date.now();
	const ctx = { sessionId: opts.facts.sessionId, seed: opts.facts.seed, now };

	// 反思必须看到**已记录了什么**，否则 `supersedes` 无从产生 ——
	// `supersededBy` 从 Phase C 起就存在、`selectLessons` 也按它过滤，
	// 但全项目没有一处给它赋值：记忆只增不减（R2）。
	const recorded = (() => {
		try {
			return readLessons(opts.dataDir).map((l) => ({ id: l.id, text: l.text }));
		} catch {
			return [];
		}
	})();
	const facts: ReflectionFacts = { ...opts.facts, recorded: opts.facts.recorded ?? recorded };

	let reply: string;
	try {
		reply = await opts.complete(buildReflectionPrompt(facts));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: message, lessonsSaved: 0, lessonsSuperseded: 0, strategiesPromoted: 0, replyChars: 0 };
	}

	const text = typeof reply === "string" ? reply : "";
	const lessons = reflectToLessons(text, ctx);
	const samples = reflectToStrategies(text, { sessionId: ctx.sessionId, now });

	let lessonsSaved = 0;
	let lessonsSuperseded = 0;
	try {
		// 先把 `supersedes` 落到库里（作废已有的、可能已被推翻的观察），
		// 再追加本局的新条目。落盘的库因此包含被作废者（带 supersededBy），
		// 而注入端 `selectLessons` 会把它们滤掉 —— 记忆**可以被推翻**。
		const existing = readLessons(opts.dataDir);
		const applied = applySupersessions(existing, lessons);
		const changed = applied.filter(
			(l) => l.supersededBy && !existing.find((e) => e.id === l.id)?.supersededBy,
		);
		appendLessons(opts.dataDir, changed);
		lessonsSuperseded = changed.length;
		lessonsSaved = appendLessons(opts.dataDir, lessons);
	} catch {
		// Persistence failure is reported as zero saved rather than thrown.
		lessonsSaved = 0;
		lessonsSuperseded = 0;
	}

	let strategiesPromoted = 0;
	try {
		const merged = readStrategies(opts.dataDir);
		// Accumulate this game's samples into the pool. `mergeStrategySamples` also
		// carries over each card's human `enabled` flag, so a confirmed strategy is
		// not silently un-confirmed by a later write.
		//
		// The **whole pool** is persisted, not just the promoted cards: a pattern
		// needs samples from 2 games before it can pass the gate, so the first
		// game's sample has to live somewhere. Writing only winners made the gate
		// unreachable (game 1's sample was discarded, so game 2 only ever saw
		// itself). Injectability is enforced in selectStrategies(), which requires
		// BOTH the gate and the human flag.
		const pool = mergeStrategySamples(samples, merged, now);
		appendStrategies(opts.dataDir, pool);
		strategiesPromoted = pool.filter((c) => evaluatePromotion(c).promoted).length;
	} catch {
		strategiesPromoted = 0;
	}

	return { ok: true, lessonsSaved, lessonsSuperseded, strategiesPromoted, replyChars: text.length };
}
