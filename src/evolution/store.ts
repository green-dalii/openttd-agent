/**
 * Evolution metrics store — JSONL persistence (SPEC §7 D7).
 *
 * 职责: 把 `GameMetric` 追加/读取到 `<dataDir>/evolution/metrics.jsonl`，
 *   并保证**同一局只出现一条**（幂等）。
 *
 * 为什么需要幂等（真实风险）: 一局结束可能经过多条路径落账 —— 正常收尾、
 *   崩溃后的启动期 reconcile（`interrupted`）、以及进程被强杀后的补写。
 *   若不去重，跨局统计会把同一局算两次，让"进化曲线"凭空变好看。
 *   因此写入按 `id` 覆盖，读取按 `id` 只保留最后一条。
 *
 * 事实来源: SPEC §5.2 #3（每局结构化指标 JSONL）、§7 D7（JSONL + 不引入 SQLite）。
 * 禁止:
 *   - 在此做统计/推断（见 metrics.ts）。
 *   - 让损坏的行炸掉整个读取：**单行损坏不应丢掉整本账本**。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toGameMetric, type GameMetric, type SessionMetaLike } from "./metrics.js";
import { dedupeLessons, type Lesson } from "./lessons.js";
import type { StrategyCard } from "./types.js";

/** `<dataDir>/evolution/` — one folder for the whole evolution layer. */
export function evolutionDir(dataDir: string): string {
	return path.join(dataDir, "evolution");
}

export function metricsPath(dataDir: string): string {
	return path.join(evolutionDir(dataDir), "metrics.jsonl");
}

/**
 * Append one game's metric.
 *
 * JSONL is append-only for durability, but the readers collapse duplicates by
 * `id` (last wins), so re-recording the same session is safe and intentional.
 */
export function appendMetric(
	dataDir: string,
	meta: SessionMetaLike,
	memory?: { lessonsInjected?: number; strategiesInjected?: number; routeFactsInjected?: number },
): GameMetric {
	const metric = toGameMetric(meta, memory);
	mkdirSync(evolutionDir(dataDir), { recursive: true });
	appendFileSync(metricsPath(dataDir), `${JSON.stringify(metric)}\n`, "utf8");
	return metric;
}

/**
 * Read the ledger, newest wins per id.
 *
 * A corrupt line is skipped rather than thrown: losing one entry must not cost
 * the whole history.
 */
export function readMetrics(dataDir: string): GameMetric[] {
	const file = metricsPath(dataDir);
	if (!existsSync(file)) return [];
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const byId = new Map<string, GameMetric>();
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const parsed = JSON.parse(t) as GameMetric;
			if (parsed && typeof parsed.id === "string") byId.set(parsed.id, parsed);
		} catch {
			// Skip the damaged line; keep the rest of the ledger.
		}
	}
	// Oldest first, so a chart reads left-to-right in time.
	return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Rewrite the file with one entry per id (compaction).
 *
 * Append-only is fine while the ledger is small, but every re-record leaves a
 * stale line behind; this keeps the file from growing without bound. Written via
 * a temp file + rename so a crash cannot truncate the ledger.
 */
export function compactMetrics(dataDir: string): number {
	const list = readMetrics(dataDir);
	const file = metricsPath(dataDir);
	const tmp = `${file}.tmp`;
	mkdirSync(evolutionDir(dataDir), { recursive: true });
	writeFileSync(tmp, list.map((m) => JSON.stringify(m)).join("\n") + (list.length ? "\n" : ""), "utf8");
	// rename() is atomic within a filesystem, so a crash mid-compaction leaves the
	// previous ledger intact rather than a truncated one.
	renameSync(tmp, file);
	return list.length;
}

/* ----------------------------- learning library ----------------------------- */

/*
 * lessons.jsonl / strategies.jsonl 沿用 metrics.jsonl 的约定:
 * append-only、按 id 收敛、单个坏行不丢整本库、压缩走 temp + rename。
 *
 * 一处**刻意不同**于 metrics:lessons 读取时按「更可信者胜」收敛,
 * 而不是简单的最后一条胜出。理由:追加一条低置信度的重复项不应该把
 * 一个更好的结论挤掉 —— 而 append-only 的写入路径无法在写时判断哪条更好。
 */

export function lessonsPath(dataDir: string): string {
	return path.join(evolutionDir(dataDir), "lessons.jsonl");
}

export function strategiesPath(dataDir: string): string {
	return path.join(evolutionDir(dataDir), "strategies.jsonl");
}

/** Read a JSONL file into objects, skipping (not rethrowing) corrupt lines. */
function readJsonl<T>(file: string, isValid: (v: unknown) => v is T): T[] {
	if (!existsSync(file)) return [];
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const parsed: unknown = JSON.parse(t);
			if (isValid(parsed)) out.push(parsed);
		} catch {
			// Skip the damaged line; the rest of the library survives.
		}
	}
	return out;
}

/** Write via temp + rename so a crash cannot truncate the library. */
function writeAtomic(file: string, lines: string[]): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
	// rename() is atomic within a filesystem: a crash mid-compaction leaves the
	// previous library intact rather than a truncated one.
	renameSync(tmp, file);
}

/**
 * A stored lesson must be a **validated observation**, not merely id+text.
 *
 * R2（2026-09-18）：旧库里的条目是 `kind:"do"|"dont"` 的祈使句，**没有实测读数**。
 * 只查 id+text 会让它们继续当作"经验"载入（注入端再靠 formatForInjection 挡），
 * 那既浪费注入预算，也让"库里有多少条经验"这个数字变假。
 * 契约是"经验 = 带实测读数的观察"，所以这里按契约收口。
 */
function isLesson(v: unknown): v is Lesson {
	if (!v || typeof v !== "object") return false;
	const l = v as Partial<Lesson>;
	if (typeof l.id !== "string" || l.id === "" || typeof l.text !== "string") return false;
	const o = l.outcome;
	return Boolean(
		o &&
			typeof o === "object" &&
			typeof o.metric === "string" &&
			Number.isFinite(Number(o.before)) &&
			Number.isFinite(Number(o.after)),
	);
}

/** A well-formed JSON line that is a lesson in every way except the R2 outcome field. */
function isLegacyLesson(v: unknown): boolean {
	if (!v || typeof v !== "object") return false;
	const l = v as Partial<Lesson>;
	return typeof l.id === "string" && l.id !== "" && typeof l.text === "string" && !isLesson(v);
}

function isStrategyCard(v: unknown): v is StrategyCard {
	if (!v || typeof v !== "object") return false;
	const c = v as StrategyCard;
	return (
		typeof c.id === "string" &&
		c.id !== "" &&
		typeof c.action === "string" &&
		Array.isArray(c.valuePerRun)
	);
}

/** Append lessons. Invalid entries are dropped rather than persisted. */
/**
 * Read the library **and report what was excluded**.
 *
 * R2 迁移（2026-09-18）：旧文件里是祈使句形状的条目。这里不重写磁盘
 * （破坏性、且那是用户数据），而是读取时排除并**报出数量**——
 * 静默过滤正是让一次比较开始说谎的方式（项目铁律）。
 */
export function readLessonsReport(dataDir: string): { lessons: Lesson[]; legacyDropped: number } {
	const file = lessonsPath(dataDir);
	if (!existsSync(file)) return { lessons: [], legacyDropped: 0 };
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { lessons: [], legacyDropped: 0 };
	}
	const valid: Lesson[] = [];
	let legacyDropped = 0;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(t);
		} catch {
			continue; // malformed line: not a legacy lesson, just noise
		}
		if (isLesson(parsed)) valid.push(parsed);
		else if (isLegacyLesson(parsed)) legacyDropped += 1;
	}
	return { lessons: dedupeLessons(valid), legacyDropped };
}

export function appendLessons(dataDir: string, lessons: Lesson[]): number {
	const valid = (Array.isArray(lessons) ? lessons : []).filter(isLesson);
	if (valid.length === 0) return 0;
	mkdirSync(evolutionDir(dataDir), { recursive: true });
	appendFileSync(lessonsPath(dataDir), valid.map((l) => `${JSON.stringify(l)}\n`).join(""), "utf8");
	return valid.length;
}

/**
 * Read the lesson library, collapsing duplicates by "most credible wins".
 *
 * Reuses `dedupeLessons` so the on-disk view and the in-memory view can never
 * disagree about which of two same-id lessons survives.
 */
export function readLessons(dataDir: string): Lesson[] {
	return dedupeLessons(readJsonl(lessonsPath(dataDir), isLesson));
}

export function compactLessons(dataDir: string): number {
	const list = readLessons(dataDir);
	writeAtomic(lessonsPath(dataDir), list.map((l) => JSON.stringify(l)));
	return list.length;
}

/** Append strategy cards. Cards are full merged snapshots, not deltas. */
export function appendStrategies(dataDir: string, cards: StrategyCard[]): number {
	const valid = (Array.isArray(cards) ? cards : []).filter(isStrategyCard);
	if (valid.length === 0) return 0;
	mkdirSync(evolutionDir(dataDir), { recursive: true });
	appendFileSync(
		strategiesPath(dataDir),
		valid.map((c) => `${JSON.stringify(c)}\n`).join(""),
		"utf8",
	);
	return valid.length;
}

/**
 * Read strategy cards, last wins per id.
 *
 * Unlike lessons this is a plain last-wins collapse: a card is written as the
 * already-merged snapshot (including `valuePerRun` accumulated across games and
 * the human `enabled` flag), so the newest record is by definition the complete one.
 */
export function readStrategies(dataDir: string): StrategyCard[] {
	const byId = new Map<string, StrategyCard>();
	for (const c of readJsonl(strategiesPath(dataDir), isStrategyCard)) byId.set(c.id, c);
	return [...byId.values()].sort((a, b) =>
		a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt,
	);
}

export function compactStrategies(dataDir: string): number {
	const list = readStrategies(dataDir);
	writeAtomic(strategiesPath(dataDir), list.map((c) => JSON.stringify(c)));
	return list.length;
}

/**
 * Flip one strategy card's human confirmation flag (SPEC §5.3 guardrail).
 *
 * Returns false when the id is unknown so the API can answer 404 rather than
 * silently pretending it worked. Rewrites the library atomically: the toggle is
 * the one write a human performs, and losing it would silently disable a
 * strategy they had already reviewed.
 */
export function setStrategyEnabled(dataDir: string, id: string, enabled: boolean): boolean {
	if (!id) return false;
	const list = readStrategies(dataDir);
	const idx = list.findIndex((c) => c.id === id);
	if (idx === -1) return false;
	const next = list.slice();
	next[idx] = { ...next[idx]!, enabled: Boolean(enabled) };
	writeAtomic(strategiesPath(dataDir), next.map((c) => JSON.stringify(c)));
	return true;
}
