/**
 * Agent audit — structured JSONL trail of decisions, actions and results.
 *
 * 职责: 把 LLM 决策与每次动作结果落成 JSONL（SPEC §3.1 第 5 条 / §7 审计：
 *   可 grep、可回放、供进化引擎读取）。append-only，一行一事件。
 * 事实来源: SPEC §7（审计 JSONL）、§5.2（metrics 供进化引擎）。
 * 禁止: 记录明文密钥；阻塞决策循环（写入 best-effort，失败不抛给调用方）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export type AuditRecord =
	| {
			type: "decision";
			ts: number;
			turn: number;
			/** Why the model was asked (docs/AGENT-LOOP-AND-CONTROL.md §2.1). */
			trigger?: string;
			date: string;
			state: Record<string, unknown>;
	  }
	| {
			type: "action_result";
			ts: number;
			tool: string;
			ok: boolean;
			summary: string;
			data?: Record<string, unknown>;
	  }
	| { type: "note"; ts: number; message: string; data?: Record<string, unknown> };

/** Redact anything that looks like a secret before writing. */
function sanitize(v: unknown): unknown {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.map(sanitize);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
			if (/key|token|secret|password|authorization/i.test(k)) {
				out[k] = "(redacted)";
			} else {
				out[k] = sanitize(val);
			}
		}
		return out;
	}
	return v;
}

export class AuditLog {
	private readonly file: string;

	/** @param dir directory for audit files (created if missing). */
	constructor(dir: string, name = "audit.jsonl") {
		mkdirSync(dir, { recursive: true });
		this.file = path.join(dir, name);
	}

	/** Append one record. Never throws (audit must not break the loop). */
	write(rec: AuditRecord): void {
		try {
			appendFileSync(this.file, `${JSON.stringify(sanitize(rec))}\n`, "utf8");
		} catch {
			/* best-effort */
		}
	}

	path(): string {
		return this.file;
	}
}
