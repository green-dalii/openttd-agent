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

import type { Lesson, LessonMetric, LessonOutcome } from "./types.js";

export type { Lesson, LessonMetric, LessonOutcome };

/** 单次注入的教训上限——不能把整个库塞进 prompt(SPEC §5.3「限量」)。 */
export const MAX_LESSONS_INJECTED = 8;

/** 超过这个年龄的教训不再注入:游戏版本/策略已变,旧结论未必成立。 */
export const LESSON_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** 反思未给置信度时的保守默认值(宁可少信一点)。 */
export const DEFAULT_CONFIDENCE = 0.4;

/** 反思输出的原始形状(未经校验,全部 unknown)。 */
export interface RawLesson {
	text?: unknown;
	/** 实测读数；旧库里的 `kind: "do"|"dont"` 不再是合法形状（见 types.ts）。 */
	outcome?: unknown;
	evidence?: unknown;
	confidence?: unknown;
	/** 这条观察推翻了哪些既有条目（id 列表）。 */
	supersedes?: unknown;
}

/** 反思发生的上下文——来源必须可追溯,否则教训无法被覆盖或追责。 */
export interface ReflectionContext {
	sessionId: string;
	seed: number;
	now: number;
}

/** The only metrics an observation may cite (SPEC §5.2 机制 1; types.ts). */
const LESSON_METRICS: readonly LessonMetric[] = [
	"delivered",
	"deliveredPerDay",
	"income",
	"money",
	"vehicles",
	"stations",
	"construction",
];

/**
 * 祈使/建议措辞的**内容级**检测（SPEC §10.22 边界）。
 *
 * 为什么必须是内容级（2026-09-18，R2，MEMORY D26）：旧的守卫断言注入行
 * `^DO\b` —— 而注入行本身是 `Previously an action like this paid off: <text>`，
 * 前缀在前，那条正则**永远不可能匹配**；于是真机库里 12 条有 10 条、27 条有 15 条
 * 是"Build a single bus route first…"这类祈使句，全都通过了守卫。
 * 守卫必须作用在**被判断的那段文本本身**。
 *
 * 这是启发式而非完备判定：宁可偶尔误杀（模型会被告知理由并改写），
 * 也不要让一句"你应当…"变成一条永久注入的经验。
 */
export function isImperative(text: unknown): boolean {
	const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
	if (!t) return false;
	// 1) 旧的显式标记
	if (/^(DO|DONT|DON'T|AVOID|ALWAYS|NEVER)\s*[:,-]/i.test(t)) return true;
	// 2) 以动词原形开头的祈使句（"Build…", "expand…", "Add…", "Prefer…"）
	// 动词表来自**真机库里的实际措辞**（2026-09-18 用 /tmp/{pbcal,ab900,cal2} 的
	// 53 条旧条目校准），不是凭空想象的列表：只列"计划/调度/开单"这一类
	// 真实出现过的祈使句开头。
	if (
		/^(build|add|expand|buy|sell|use|open|target|aim|focus|invest|spend|plan|re-?plan|prioriti[sz]e|front-?load|scale|defer|order|issue|cluster|chain|cap|top|double|pick|set|keep|make|ensure|check|send|wait|try|consider|avoid|prefer|choose|select|start|stop|reduce|increase|raise|lower|upgrade|replace|remove|place|connect|leave|do|don't|dont|never|always|first)\b/i.test(
			t,
		)
	) {
		return true;
	}
	// 3) 建议/义务的情态与劝告短语
	if (/\b(you should|you must|you need to|we should|it is better to|it's better to|make sure|be sure|recommend(ed|s)?|ought to|instead of|preferable)\b/i.test(t)) {
		return true;
	}
	// 4) 句中出现祈使式"应当"
	if (/\b(should|must)\b\s+\w+/i.test(t) && !/\b(was|were|had|did|would have|might have)\b/i.test(t)) return true;
	return false;
}

/**
 * Validate the measured readings. Missing values must be REJECTED, never zeroed:
 * `Number(null)` is 0, which would turn "nobody measured it" into a confident
 * "nothing happened" (the same trap as the old `toFiniteNumber` comment).
 */
function toOutcome(v: unknown): LessonOutcome | null {
	if (!v || typeof v !== "object" || Array.isArray(v)) return null;
	const o = v as { metric?: unknown; before?: unknown; after?: unknown };
	if (typeof o.metric !== "string" || !LESSON_METRICS.includes(o.metric as LessonMetric)) return null;
	const before = toStrictNumber(o.before);
	const after = toStrictNumber(o.after);
	if (before === null || after === null) return null;
	return { metric: o.metric as LessonMetric, before, after };
}

/** Numeric coercion that refuses null/undefined/boolean/blank-string (≠ 0). */
function toStrictNumber(v: unknown): number | null {
	if (v === null || v === undefined || typeof v === "boolean") return null;
	if (typeof v === "string" && !v.trim()) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** Ids this entry claims to contradict (strings only, self-references dropped). */
function toSupersedes(v: unknown, selfId: string): string[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out = new Set<string>();
	for (const item of v) {
		if (typeof item !== "string") continue;
		const t = item.trim();
		if (t && t !== selfId) out.add(t);
	}
	return out.size ? [...out] : undefined;
}

/**
 * 把新观察的 `supersedes` 落到库里的 `supersededBy` 上——经验因此**可以被推翻**。
 *
 * 为什么需要（2026-09-18）：`supersededBy` 字段从 Phase C 起就存在、
 * `selectLessons` 也一直在按它过滤，但**全项目没有任何地方给它赋值**：
 * 记忆于是只增不减，一条错误的观察会永久注入。不存在的 id 不会被凭空创造成记录。
 */
export function applySupersessions(existing: Lesson[], incoming: Lesson[]): Lesson[] {
	const byId = new Map<string, Lesson>();
	for (const l of [...existing, ...incoming]) {
		if (l && typeof l.id === "string" && l.id) byId.set(l.id, l);
	}
	for (const l of incoming) {
		if (!l || !Array.isArray(l.supersedes)) continue;
		for (const target of l.supersedes) {
			const victim = byId.get(target);
			// 只作废**已在库中**的条目；自引用不可作废（`toSupersedes` 已剔除）。
			if (!victim || target === l.id) continue;
			byId.set(target, { ...victim, supersededBy: l.id });
		}
	}
	return dedupeLessons([...byId.values()]);
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

/**
 * Validate one reflection entry into a Lesson.
 *
 * Returns null when the entry cannot be trusted: no text, an imperative/bad-advice
 * sentence, **no measured outcome**, **no game-fact evidence**, or no source session. Callers must drop nulls rather than invent
 * defaults — a lesson with fabricated evidence is worse than no lesson.
 */
export type LessonVerdict = { ok: true; lesson: Lesson } | { ok: false; reason: string };

/**
 * Validate one candidate and explain the refusal.
 *
 * 为什么需要**理由**（2026-09-18, R2b）：拒绝在两条路上被消费——
 * ① 解析旧式 JSON 回复时静默丢弃；② 反思走 pi-agent-core 的工具时，
 * 理由会作为**工具错误回到模型**，模型因此可以改写成一条观察句再试。
 * 一条"为什么被拒"是给模型的反馈，不是日志装饰。
 */
export function validateLesson(raw: unknown, ctx: ReflectionContext): LessonVerdict {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, reason: "argument must be an object with text/outcome/evidence" };
	}
	const r = raw as RawLesson;

	const text = typeof r.text === "string" ? r.text.replace(/\s+/g, " ").trim() : "";
	if (!text) return { ok: false, reason: "text is required" };

	// 内容级边界：一条经验必须是**对已发生事实的陈述**。
	if (isImperative(text)) {
		return {
			ok: false,
			reason:
				"this reads as an instruction or advice. Record what HAPPENED instead " +
				"(e.g. 'the route delivered 137 units in 300 game days'), not what to do.",
		};
	}

	const outcome = toOutcome(r.outcome);
	if (!outcome) {
		return {
			ok: false,
			reason:
				"outcome is required and must be a MEASURED reading: " +
				'{metric: "delivered"|"deliveredPerDay"|"income"|"money"|"vehicles"|"stations"|"construction", ' +
				"before: <number>, after: <number>}. A missing reading cannot be zero.",
		};
	}

	const evidence = cleanEvidence(r.evidence);
	if (evidence.length === 0) {
		return { ok: false, reason: "evidence is required: cite the game facts this observation rests on" };
	}

	if (!ctx || typeof ctx.sessionId !== "string" || !ctx.sessionId) {
		return { ok: false, reason: "no source session: an unattributable lesson cannot be stored" };
	}

	const id = lessonId(text);
	return {
		ok: true,
		lesson: {
			id,
			text,
			outcome,
			confidence: clampConfidence(r.confidence),
			evidence,
			supersedes: toSupersedes(r.supersedes, id),
			sourceSessionId: ctx.sessionId,
			sourceSeed: Number.isFinite(Number(ctx.seed)) ? Number(ctx.seed) : -1,
			createdAt: Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : 0,
		},
	};
}

/** Back-compat wrapper: the long-standing "null means rejected" entry point. */
export function fromReflection(raw: unknown, ctx: ReflectionContext): Lesson | null {
	const v = validateLesson(raw, ctx);
	return v.ok ? v.lesson : null;
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
		// 作废优先于一切（2026-09-18, R2）：作废是**以追加形式**表达的
		// （写一条带 `supersededBy` 的同 id 记录），而两者 confidence 与
		// createdAt 完全相同 —— 若只按"更可信/更新"择优，先到的原条会赢，
		// **作废会被静默丢弃**（记忆又变成只增不减）。
		// 语义：一条被标记作废的记录是关于这条经验的最新事实。
		const retractionWins = Boolean(l.supersededBy) && !prev.supersededBy;
		const bothRetracted = Boolean(l.supersededBy) === Boolean(prev.supersededBy);
		const better =
			retractionWins ||
			(bothRetracted &&
				(l.confidence > prev.confidence ||
					(l.confidence === prev.confidence && l.createdAt > prev.createdAt)));
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
		// 纵深防御：即使一条祈使句混进了库（历史数据、手写文件），也不得被注入。
		.filter((l) => !isImperative(l.text))
		.map((l) => {
			const text = l.text.replace(/\s+/g, " ").trim();
			// 记一条**记录**并附上它依据的实测读数——这样模型看到的是
			// "上一次发生了什么、数字是多少"，而不是"你该怎么做"。
			// 旧格式（`Previously an action like this paid off:`）替模型断言了因果，
			// 而那条因果从未被验证过（MEMORY D26）。
			const o = l.outcome;
			const reading = o ? ` [${o.metric} ${o.before} -> ${o.after}, seed ${l.sourceSeed}]` : "";
			return `Recorded in an earlier game: ${text}${reading}`;
		});
}
