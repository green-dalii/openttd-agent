/**
 * Reflection statistics — 把"反思到底有没有干活"变成可聚合的事实（M1，SPEC §10.78）。
 *
 * 职责: 读一个 dataDir 下所有会话的 `audit.jsonl`，聚合 `type:"reflection"` 记录
 *   （调用了几次记录工具、被拒几次、重试几次、存下几条），供 verdict 打印。
 * 事实来源: `src/agent/reflect-run.ts` 写下的审计记录；M1/SPEC §10.77 的事故背景。
 * 禁止: 在这里读 metrics.jsonl（那是"这一局跑成什么样"；本模块只管"反思干了什么"）。
 *
 * 为什么单独成一个来源（2026-09-19）：
 *   反思发生在 `session.finalize()` **之后**（那一步已经把 metric 行写进 metrics.jsonl），
 *   所以 `reflectionRetries` 这类字段**不可能**出现在 metric 行里。
 *   硬塞进去只会得到一个永远 undefined 的字段（"声明了但没接线"，D19/D22 的经典形态）。
 *   审计是局后事件的正确归属地，聚合与缺省语义在这里只有一处实现。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { metricStat, type MetricStat } from "./metrics.js";

/** One `type:"reflection"` audit record, as written by reflect-run. */
export interface ReflectionAuditRecord {
	ok?: boolean;
	toolCalls?: number;
	retries?: number;
	lessonsSaved?: number;
	lessonsSuperseded?: number;
	rejections?: unknown[];
	error?: string | null;
}

export interface ReflectionStats {
	/** How many runs left a reflection record at all. */
	runs: number;
	/**
	 * Runs where a SUCCESSFUL reflection called no recording tool (protocol/wiring smell).
	 *
	 * 只数 `ok !== false` 的局：2026-09-19 真机上 provider 失败的一局
	 * （`ok:false, toolCalls:0`）曾被算进来，于是 WARNING 把**网络故障**报成了
	 * "协议/接线信号"。**两种成因必须分开**，否则基础设施问题会被读成提示词问题。
	 */
	zeroCallRuns: number;
	/** Runs whose reflection errored out (provider/network/parse) - not a protocol signal. */
	failedRuns: number;
	/** First error message seen, for the verdict line (null when none). */
	firstError: string | null;
	/** Runs that needed a re-ask. */
	runsWithRetry: number;
	/** Total recording-tool calls across runs; null when no run reported one. */
	toolCalls: MetricStat | null;
	/** Total re-asks; null when nothing reported it. */
	retries: MetricStat | null;
	/** Total observations stored; null when nothing reported it. */
	lessonsSaved: MetricStat | null;
}

/** All reflection records found under `<dataDir>/sessions/* / audit.jsonl`. */
export function readReflectionRecords(dataDir: string): ReflectionAuditRecord[] {
	const root = join(dataDir, "sessions");
	if (!existsSync(root)) return [];
	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		return [];
	}
	const out: ReflectionAuditRecord[] = [];
	for (const name of dirs) {
		const file = join(root, name, "audit.jsonl");
		if (!existsSync(file)) continue;
		let raw: string;
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(t);
			} catch {
				continue; // a malformed line is noise, not a reflection record
			}
			const rec = parsed as { type?: unknown };
			if (rec && typeof rec === "object" && rec.type === "reflection") {
				out.push(parsed as ReflectionAuditRecord);
			}
		}
	}
	return out;
}

/** Aggregate reflection records for a verdict line. Missing fields stay missing. */
export function reflectionStats(dataDir: string): ReflectionStats {
	const recs = readReflectionRecords(dataDir);
	const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
	const ok = recs.filter((r) => r.ok !== false);
	const failed = recs.filter((r) => r.ok === false);
	const firstError = failed.map((r) => r.error).find((e): e is string => typeof e === "string" && e.length > 0);
	return {
		runs: recs.length,
		zeroCallRuns: ok.filter((r) => num(r.toolCalls) === 0).length,
		failedRuns: failed.length,
		firstError: firstError ?? null,
		runsWithRetry: recs.filter((r) => (num(r.retries) ?? 0) > 0).length,
		// 失败局没机会调用工具 → 不混进"每次反思调了几次"的统计
		toolCalls: metricStat(ok.map((r) => num(r.toolCalls))),
		retries: metricStat(recs.map((r) => num(r.retries))),
		lessonsSaved: metricStat(ok.map((r) => num(r.lessonsSaved))),
	};
}
