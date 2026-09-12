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
	memory?: { lessonsInjected?: number; strategiesInjected?: number },
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
