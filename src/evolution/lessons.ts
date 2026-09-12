/**
 * Lessons — 记忆蒸馏的第一片（SPEC §5.2 机制 1）。
 *
 * 职责: Lesson 的数据契约 + 三道闸(证据非空 / 去重 / 注入限量与过期),
 *   **全部是纯函数**。反思产出的原始条目必须经 `fromReflection` 校验才能入库。
 * 事实来源: SPEC §5.2（机制 1）、§5.3（收敛防抖）、docs/EVOLUTION.md §2.1/§3。
 * 禁止: 在此调用 LLM 或读写磁盘(存储见 store.ts,反思见 reflect.ts)。
 *
 * 为什么"证据非空"是硬约束:记忆系统的失败模式不是报错,而是**安静地变蠢**——
 * 把没有事实支撑的臆测固化下来,并在之后每一局重复注入。一个把错误教训固化的
 * 系统比没有记忆的系统更糟,所以没有证据的条目**整条丢弃**(不是降级保留)。
 */

import type { Lesson, LessonKind } from "./types.js";

export type { Lesson, LessonKind };

/** 单次注入的教训上限——不能把整个库塞进 prompt(SPEC §5.3「限量」)。 */
export const MAX_LESSONS_INJECTED = 8;

/** 超过这个年龄的教训不再注入:游戏版本/策略已变,旧结论未必成立。 */
export const LESSON_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 反思未给置信度时的保守默认值(宁可少信一点)。 */
export const DEFAULT_CONFIDENCE = 0.4;

/** 反思输出的原始形状(未经校验,全部 unknown)。 */
export interface RawLesson {
	text?: unknown;
	kind?: unknown;
	evidence?: unknown;
	confidence?: unknown;
}

/** 反思发生的上下文——来源必须可追溯,否则教训无法被覆盖或追责。 */
export interface ReflectionContext {
	sessionId: string;
	seed: number;
	now: number;
}

/**
 * Normalize lesson text for identity comparison.
 *
 * 折叠空白、转小写、去掉首尾标点——让 "  Build near a town. " 与
 * "build near a town" 落到同一条教训上。大小写与尾标点不该制造两条记忆。
 */
export function normalizeLessonText(text: unknown): string {
	if (typeof text !== "string") return "";
	return text
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase()
		.replace(/^[^\p{L}\p{N}]+/u, "")
		.replace(/[^\p{L}\p{N}]+$/u, "");
}

/** FNV-1a — 稳定、无依赖,同文本在任何进程/机器都得到同一个 id。 */
function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

/** Stable id for a lesson. Empty text yields "" so callers can reject it. */
export function lessonId(text: unknown): string {
	const norm = normalizeLessonText(text);
	return norm ? `l_${fnv1a(norm)}` : "";
}

/** Clamp a reflection-supplied confidence; junk falls back to the default. */
function clampConfidence(v: unknown): number {
	const n = Number(v);
	if (!Number.isFinite(n)) return DEFAULT_CONFIDENCE;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

/** Trim, drop empties, dedupe — evidence feeds assertions elsewhere, keep it clean. */
function cleanEvidence(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of v) {
		if (typeof item !== "string") continue;
		const t = item.replace(/\s+/g, " ").trim();
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

function isKind(v: unknown): v is LessonKind {
	return v === "do" || v === "dont";
}

/**
 * Validate one reflection entry into a Lesson.
 *
 * Returns null when the entry cannot be trusted: no text, no kind, **no game-fact
 * evidence**, or no source session. Callers must drop nulls rather than invent
 * defaults — a lesson with fabricated evidence is worse than no lesson.
 */
export function fromReflection(raw: unknown, ctx: ReflectionContext): Lesson | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as RawLesson;

	const text = typeof r.text === "string" ? r.text.replace(/\s+/g, " ").trim() : "";
	if (!text) return null;

	if (!isKind(r.kind)) return null;

	const evidence = cleanEvidence(r.evidence);
	if (evidence.length === 0) return null;

	if (!ctx || typeof ctx.sessionId !== "string" || !ctx.sessionId) return null;

	return {
		id: lessonId(text),
		text,
		kind: r.kind,
		confidence: clampConfidence(r.confidence),
		evidence,
		sourceSessionId: ctx.sessionId,
		sourceSeed: Number.isFinite(Number(ctx.seed)) ? Number(ctx.seed) : -1,
		createdAt: Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : 0,
	};
}

/**
 * Keep one entry per lesson id: highest confidence wins, newest breaks ties.
 *
 * Output is sorted by id so the result does not depend on input order — callers
 * diff these lists (and tests assert determinism), so a stable order matters.
 */
export function dedupeLessons(list: Lesson[]): Lesson[] {
	const best = new Map<string, Lesson>();
	for (const l of Array.isArray(list) ? list : []) {
		if (!l || typeof l !== "object") continue;
		const id = typeof l.id === "string" && l.id ? l.id : lessonId(l.text);
		if (!id) continue;
		const prev = best.get(id);
		if (!prev) {
			best.set(id, l);
			continue;
		}
		const better =
			l.confidence > prev.confidence ||
			(l.confidence === prev.confidence && l.createdAt > prev.createdAt);
		if (better) best.set(id, l);
	}
	return [...best.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((e) => e[1]);
}

export interface SelectOptions {
	/** Max lessons to inject. Defaults to MAX_LESSONS_INJECTED. */
	limit?: number;
	/** Reference time for the age cutoff. Defaults to Date.now(). */
	now?: number;
	/** Age cutoff. Defaults to LESSON_MAX_AGE_MS. */
	maxAgeMs?: number;
}

/**
 * Filter + rank the library down to what may be injected this game.
 *
 * Order matters and is deliberate: dedupe **first** so duplicates cannot consume
 * the injection budget, then drop superseded and expired entries, then rank by
 * confidence (then recency, then id for stability).
 */
export function selectLessons(list: Lesson[], opts: SelectOptions = {}): Lesson[] {
	const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
	const limit = Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : MAX_LESSONS_INJECTED;
	const maxAge =
		Number.isFinite(Number(opts.maxAgeMs)) && Number(opts.maxAgeMs) >= 0
			? Number(opts.maxAgeMs)
			: LESSON_MAX_AGE_MS;

	return dedupeLessons(list)
		.filter((l) => !l.supersededBy)
		.filter((l) => now - Number(l.createdAt ?? 0) <= maxAge)
		.sort((a, b) => {
			if (b.confidence !== a.confidence) return b.confidence - a.confidence;
			if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		})
		.slice(0, Math.max(0, limit));
}

/**
 * Render lessons for injection. One line each: this text is spliced into a
 * prompt, so an embedded newline could forge structure.
 */
export function formatForInjection(list: Lesson[]): string[] {
	return (Array.isArray(list) ? list : [])
		.filter((l) => l && typeof l.text === "string" && l.text.trim())
		.map((l) => {
			const text = l.text.replace(/\s+/g, " ").trim();
			return l.kind === "dont" ? `AVOID: ${text}` : `DO: ${text}`;
		});
}
