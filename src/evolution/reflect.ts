/**
 * Reflection — 局终反思的 prompt 构造与响应解析（SPEC §5.1 反思阶段）。
 *
 * 职责: 把一局的**结构化事实**编成 prompt，并把模型的响应**强校验**成
 *   lessons / 策略采样。除"发请求"之外全是纯函数。
 * 事实来源: SPEC §5.1（反思）、§5.3（禁止臆测因果、只接受游戏事实佐证）,
 *   docs/EVOLUTION.md §5。
 * 禁止: 在此发网络请求或读写磁盘（由调用方 runner 负责）。
 *
 * 为什么校验这么严:反思是幻觉进入**长期记忆**的唯一入口。模型很擅长给出听起来
 * 合理、但游戏里根本没发生过的因果解释;一旦入库,它会在之后每一局被重复注入。
 * 所以宁可整条丢掉,不可放行。
 */

import { dedupeLessons, fromReflection, type Lesson, type RawLesson } from "./lessons.js";
import type { StrategySample } from "./strategies.js";

/** Structured facts about the finished game — the only input reflection gets. */
export interface ReflectionFacts {
	sessionId: string;
	seed: number;
	summary: {
		money: number;
		vehicleCount: number;
		stationCount: number;
		decisions: number;
		toolCalls: number;
		toolFailures: number;
		constructionDone: boolean | null;
		durationMs: number;
	};
	/** Action outcomes / notable events, already reduced to factual statements. */
	evidence: string[];
}

/**
 * Phrases that mark a causal guess rather than an observation (SPEC §5.3).
 *
 * Deliberately narrow: only textbook speculation. "may" is excluded so that
 * "Maytown" / "monthly" are not rejected — a false positive here silently
 * deletes a real lesson, which is worse than letting one guess through.
 */
const SPECULATION_PATTERNS: RegExp[] = [
	/\bprobably\b/i,
	/\bperhaps\b/i,
	/\bmaybe\b/i,
	/\bi\s+think\b/i,
	/\bit\s+(might|may|could)\s+have\b/i,
	/\bseems?\s+(like|that)\b/i,
	/\bpresumably\b/i,
	/\bi\s+(guess|assume|suspect)\b/i,
	/\b(possibly|likely)\s+because\b/i,
	/可能/,
	/大概/,
	/也许/,
	/似乎/,
	/估计是/,
	/应该是因为/,
];

/** True when the sentence speculates about causes instead of citing game facts. */
export function isSpeculative(text: unknown): boolean {
	if (typeof text !== "string" || !text) return false;
	return SPECULATION_PATTERNS.some((re) => re.test(text));
}

export interface ReflectionPrompt {
	system: string;
	user: string;
}

/**
 * Build the reflection prompt.
 *
 * The prohibition on speculation is stated in BOTH the system and the user turn:
 * it is the single constraint that keeps the memory library from filling with
 * confident nonsense, and instructions buried in one place are easy to drift from.
 */
export function buildReflectionPrompt(facts: ReflectionFacts): ReflectionPrompt {
	const s = facts.summary;
	const factsBlock = facts.evidence.length
		? facts.evidence.map((e) => `- ${e}`).join("\n")
		: "(no structured evidence was recorded for this game)";

	const system = [
		"You review one finished OpenTTD game and extract reusable lessons.",
		"",
		"HARD RULES:",
		"1. Do NOT speculate about causes. Do not use words like probably, perhaps,",
		"   maybe, seems, or I think. If the game did not record it, you do not know it.",
		"2. Every lesson MUST cite game facts in its `evidence` array. A lesson with an",
		"   empty `evidence` array is discarded, so omitting it only wastes the entry.",
		"3. Only report what the evidence below supports. Do not invent events.",
		"4. Keep each lesson to one short, reusable sentence.",
		"",
		"Reply with JSON only, no prose:",
		'{"lessons":[{"text":"...","kind":"do"|"dont","evidence":["..."],"confidence":0.0-1.0}],',
		' "strategies":[{"action":"<tool name>","params":{},"value":<money delta>,"evidence":["..."]}]}',
	].join("\n");

	const user = [
		`Game session ${facts.sessionId} (seed ${facts.seed}) has ended.`,
		"",
		"Outcome:",
		`- final money: ${s.money}`,
		`- vehicles: ${s.vehicleCount}, stations: ${s.stationCount}`,
		`- construction completed: ${s.constructionDone === null ? "unknown" : String(s.constructionDone)}`,
		`- LLM decisions: ${s.decisions}, tool calls: ${s.toolCalls}, failures: ${s.toolFailures}`,
		`- duration: ${Math.round(s.durationMs / 1000)}s`,
		"",
		"Recorded evidence (the only facts you may rely on):",
		factsBlock,
	].join("\n");

	return { system, user };
}

export interface ParsedReflection {
	lessons: RawLesson[];
	strategies: Record<string, unknown>[];
}

function asObjectArray(v: unknown): Record<string, unknown>[] {
	if (!Array.isArray(v)) return [];
	return v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x));
}

/** Pull the first JSON object out of a model response that may wrap it in prose or fences. */
function extractJsonObject(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		// fall through to brace scanning
	}
	const start = trimmed.indexOf("{");
	if (start === -1) return null;
	// Scan for the balanced closing brace, ignoring braces inside strings.
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(trimmed.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/**
 * Parse a reflection response. Never throws: a malformed response yields empty
 * arrays, because a bad reflection must not take down the run.
 */
export function parseReflection(text: unknown): ParsedReflection {
	if (typeof text !== "string" || !text.trim()) return { lessons: [], strategies: [] };
	const obj = extractJsonObject(text);
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { lessons: [], strategies: [] };
	const o = obj as Record<string, unknown>;
	return {
		lessons: asObjectArray(o.lessons) as RawLesson[],
		strategies: asObjectArray(o.strategies),
	};
}

export interface LessonContext {
	sessionId: string;
	seed: number;
	now: number;
}

/**
 * Parse + validate + dedupe lessons in one step.
 *
 * Rejections here are intentional: no evidence, or a speculative sentence. The
 * prompt asks the model not to speculate, and this enforces it — an instruction
 * the model can ignore is not a guardrail.
 */
export function reflectToLessons(text: unknown, ctx: LessonContext): Lesson[] {
	const parsed = parseReflection(text);
	const kept: Lesson[] = [];
	for (const raw of parsed.lessons) {
		if (isSpeculative((raw as { text?: unknown }).text)) continue;
		const lesson = fromReflection(raw, ctx);
		if (lesson) kept.push(lesson);
	}
	return dedupeLessons(kept);
}

export interface StrategyContext {
	sessionId: string;
	now: number;
}

function cleanEvidenceList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out = new Set<string>();
	for (const item of v) {
		if (typeof item !== "string") continue;
		const t = item.replace(/\s+/g, " ").trim();
		if (t) out.add(t);
	}
	return [...out];
}

/**
 * Coerce a model-supplied number strictly.
 *
 * `Number(null)` is 0 and `Number("")` is 0, which would turn a MISSING value into
 * a confident "no payoff" — and then the promotion gate would treat it as a real
 * sample. Absent/junk must be rejected, not zeroed (the same trap as `fmtInt(null)`).
 */
function toFiniteNumber(v: unknown): number | null {
	if (v === null || v === undefined || typeof v === "boolean") return null;
	if (typeof v === "string" && !v.trim()) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/** Validate strategy candidates into samples the promotion gate can consume. */
export function reflectToStrategies(text: unknown, ctx: StrategyContext): StrategySample[] {
	const parsed = parseReflection(text);
	const out: StrategySample[] = [];
	for (const raw of parsed.strategies) {
		const action = typeof raw.action === "string" ? raw.action.trim() : "";
		if (!action) continue;
		const value = toFiniteNumber(raw.value);
		if (value === null) continue;
		const evidence = cleanEvidenceList(raw.evidence);
		if (evidence.length === 0) continue;
		const params =
			raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
				? (raw.params as Record<string, number | string>)
				: {};
		out.push({ action, params, value, evidence, sessionId: ctx.sessionId, createdAt: ctx.now });
	}
	return out;
}

/** Minimal shapes so this stays decoupled from agent/runtime types. */
export interface EvidenceInput {
	stages?: Array<{ gameDate?: unknown; turn?: unknown; note?: unknown }>;
	actions?: Array<{ tool?: unknown; ok?: unknown; summary?: unknown }>;
}

/**
 * Reduce a game's recorded stage summaries and action results to factual lines.
 *
 * This is the *only* evidence reflection is allowed to reason from (SPEC §5.3),
 * so it stays strictly descriptive: what happened, when, and whether it worked.
 * No interpretation is added here — interpretation is exactly what we refuse to
 * let the model invent, and we must not smuggle it in through input either.
 */
export function buildReflectionEvidence(input: EvidenceInput): string[] {
	const out: string[] = [];
	for (const s of Array.isArray(input?.stages) ? input.stages : []) {
		const when = typeof s?.gameDate === "string" && s.gameDate ? s.gameDate : "?";
		const turn = Number.isFinite(Number(s?.turn)) ? `turn ${Number(s?.turn)}` : "?";
		const note = typeof s?.note === "string" ? s.note.replace(/\s+/g, " ").trim() : "";
		if (!note) continue;
		out.push(`${when} (${turn}): ${note}`);
	}
	for (const a of Array.isArray(input?.actions) ? input.actions : []) {
		const tool = typeof a?.tool === "string" ? a.tool : "";
		if (!tool) continue;
		const summary =
			typeof a?.summary === "string" ? a.summary.replace(/\s+/g, " ").trim() : "";
		out.push(`${tool} -> ${a?.ok === false ? "failed" : "ok"}${summary ? `: ${summary}` : ""}`);
	}
	return out;
}
