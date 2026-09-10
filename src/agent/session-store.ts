/**
 * Session store — persist one "game session" (局) plus an index across sessions.
 *
 * 职责: 每次 `--watch`/`--agent`/`--v02`/`--probe` 运行 = 一个 session，落盘到
 *   `<dataDir>/sessions/<id>/`：meta.json（含阶段性总结 checkpoints）、
 *   events.jsonl（游戏事件）、audit.jsonl（决策/动作）、telemetry.json（末次遥测）。
 *   另维护 `<dataDir>/sessions/index.json` 供 dashboard 列出历史局。
 * 事实来源: docs/DASHBOARD-API.md §2.5/§6.2（冻结契约）。
 * 禁止: 任何写入失败抛穿到 agent 循环（审计同款语义：失败即忽略）；越出 dataDir。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TelemetrySnapshot } from "./telemetry.js";
import type { GameEvent } from "../types.js";

/** One durable summary of a session (§2.5). */
export interface SessionMeta {
	id: string;
	mode: "watch" | "agent" | "v02" | "probe";
	status: "running" | "completed" | "aborted" | "error";
	startedAt: number;
	endedAt?: number;
	seed: number;
	startYear: number;
	mapSize: [number, number];
	serverName: string;
	companyName: string;
	llm: { providerId: string; model: string; api: string; kind: "real" | "faux" };
	outcome?: {
		constructionDone?: boolean;
		phase?: string;
		vehicles?: number;
		stations?: number;
		money?: string;
		totalEvents?: number;
	};
	totals: SessionTotals;
	checkpoints: SessionCheckpoint[];
	error?: string;
}

export interface SessionTotals {
	events: number;
	decisions: number;
	toolCalls: number;
	toolFailures: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		reasoning: number;
		totalTokens: number;
		costTotal: number;
	};
}

/** A staged milestone ("阶段性总结"), §2.5. */
export interface SessionCheckpoint {
	at: number;
	gameDate: string;
	turn: number;
	note: string;
	totals: { events: number; decisions: number; toolCalls: number; usage: SessionTotals["usage"] };
}

export interface SessionReadResult {
	meta: SessionMeta;
	telemetry: TelemetrySnapshot | null;
	events: GameEvent[];
	audit: unknown[];
}

/** Input for `create()`: totals/checkpoints are optional and normalized. */
export type NewSessionMeta = Omit<SessionMeta, "checkpoints" | "totals"> & {
	checkpoints?: SessionCheckpoint[];
	totals?: SessionTotals;
};

const INDEX_FILE = "index.json";
const MAX_INDEXED = 200;

function emptyTotals(): SessionTotals {
	return {
		events: 0,
		decisions: 0,
		toolCalls: 0,
		toolFailures: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 0,
			costTotal: 0,
		},
	};
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

/** Build a sortable, filesystem-safe session id: "20260910-213000-seed7". */
export function newSessionId(seed: number, at: Date = new Date()): string {
	const stamp =
		`${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
		`-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
	return `${stamp}-seed${seed}`;
}

function sessionsDir(dataDir: string): string {
	return path.join(dataDir, "sessions");
}

function sessionDir(dataDir: string, id: string): string {
	return path.join(sessionsDir(dataDir), id);
}

function readJsonSafe<T>(file: string): T | null {
	try {
		if (!existsSync(file)) return null;
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

function readJsonlSafe<T>(file: string, limit?: number): T[] {
	try {
		if (!existsSync(file)) return [];
		const lines = readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim().length > 0);
		const parsed: T[] = [];
		for (const l of lines) {
			try {
				parsed.push(JSON.parse(l) as T);
			} catch {
				/* skip corrupt line */
			}
		}
		return limit ? parsed.slice(-limit) : parsed;
	} catch {
		return [];
	}
}

function appendJsonl(file: string, rec: unknown): void {
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
	} catch {
		/* audit/event persistence must never break the run */
	}
}

/**
 * Fill in optional collections so partial input (or a legacy/missing field in a
 * hand-written meta) can never produce `undefined.checkpoints` later.
 */
function normalizeMeta(meta: NewSessionMeta | SessionMeta): SessionMeta {
	return {
		...meta,
		checkpoints: Array.isArray(meta.checkpoints) ? meta.checkpoints : [],
		totals: { ...emptyTotals(), ...(meta.totals ?? {}) },
	};
}

/**
 * A single session's writer. Construct with a dataDir for a fresh run, or with
 * an existing meta to resume writing an id.
 */
export class SessionStore {
	readonly dir: string;
	readonly id: string;
	private meta: SessionMeta;

	constructor(dataDir: string, meta?: SessionMeta) {
		this.dataDir = dataDir;
		if (meta) {
			this.id = meta.id;
			this.meta = normalizeMeta(meta);
			this.dir = sessionDir(dataDir, meta.id);
		} else {
			this.id = "";
			this.dir = sessionsDir(dataDir);
			this.meta = normalizeMeta({
				id: "",
				mode: "watch",
				status: "running",
				startedAt: Date.now(),
				seed: 0,
				startYear: 1950,
				mapSize: [256, 256],
				serverName: "",
				companyName: "",
				llm: { providerId: "", model: "", api: "openai-completions", kind: "faux" },
			});
		}
	}

	private readonly dataDir: string;

	/**
	 * Create a session directory + write meta + register it in the index.
	 * The id is derived from the meta, so a store is constructed empty first
	 * (`new SessionStore(dir).create(meta)`).
	 */
	create(meta: NewSessionMeta): SessionMeta {
		const full = normalizeMeta(meta);
		this.meta = full;
		// id/dir are readonly (single-writer semantics): assign via a fresh view.
		const created = this as unknown as { id: string; dir: string };
		created.id = full.id;
		created.dir = sessionDir(this.dataDir, full.id);
		try {
			mkdirSync(this.dir, { recursive: true });
			this.writeMeta();
			this.upsertIndex(full);
		} catch {
			/* non-fatal */
		}
		return full;
	}

	/** Current meta (in-memory, always populated). */
	current(): SessionMeta {
		return this.meta;
	}

	/** Merge a patch into meta and persist it. */
	update(patch: Partial<SessionMeta>): SessionMeta {
		this.meta = { ...this.meta, ...patch };
		this.writeMeta();
		this.upsertIndex(this.meta);
		return this.meta;
	}

	/** Append a staged summary (阶段性总结) and persist. */
	addCheckpoint(cp: SessionCheckpoint): void {
		this.meta = { ...this.meta, checkpoints: [...this.meta.checkpoints, cp] };
		this.writeMeta();
		this.upsertIndex(this.meta);
	}

	appendEvent(ev: GameEvent): void {
		appendJsonl(path.join(this.dir, "events.jsonl"), ev);
	}

	appendAudit(rec: Record<string, unknown>): void {
		appendJsonl(path.join(this.dir, "audit.jsonl"), rec);
	}

	/** Persist the latest telemetry snapshot + refresh derived totals. */
	saveTelemetry(t: TelemetrySnapshot): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			writeFileSync(path.join(this.dir, "telemetry.json"), JSON.stringify(t, null, 2), "utf8");
		} catch {
			/* non-fatal */
		}
		this.meta = {
			...this.meta,
			totals: {
				...this.meta.totals,
				decisions: t.totals.decisions,
				toolCalls: t.totals.toolCalls,
				toolFailures: t.totals.toolFailures,
				usage: { ...t.usage.total },
			},
		};
	}

	/** Mark the session finished (writes meta + index one last time). */
	finalize(patch: Partial<SessionMeta> = {}): SessionMeta {
		return this.update({ endedAt: Date.now(), ...patch });
	}

	private writeMeta(): void {
		try {
			mkdirSync(this.dir, { recursive: true });
			writeFileSync(path.join(this.dir, "meta.json"), JSON.stringify(this.meta, null, 2), "utf8");
		} catch {
			/* non-fatal */
		}
	}

	private upsertIndex(meta: SessionMeta): void {
		try {
			const file = path.join(sessionsDir(this.dataDir), INDEX_FILE);
			const cur = readJsonSafe<{ sessions?: SessionMeta[] }>(file);
			const list = Array.isArray(cur?.sessions) ? cur.sessions : [];
			const next = [{ ...meta }, ...list.filter((s) => s.id !== meta.id)].slice(0, MAX_INDEXED);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, JSON.stringify({ sessions: next }, null, 2), "utf8");
		} catch {
			/* non-fatal */
		}
	}
}

/** All sessions, newest first (never throws). */
export function listSessions(dataDir: string): SessionMeta[] {
	const file = path.join(sessionsDir(dataDir), INDEX_FILE);
	const cur = readJsonSafe<{ sessions?: SessionMeta[] }>(file);
	const list = Array.isArray(cur?.sessions) ? cur.sessions : [];
	return [...list].sort((a, b) => b.startedAt - a.startedAt);
}

/** Read one session's meta/telemetry/events/audit, or null when unknown. */
export function readSession(
	dataDir: string,
	id: string,
	opts: { limit?: number } = {},
): SessionReadResult | null {
	if (!id || id.includes("/") || id.includes("..")) return null;
	const dir = sessionDir(dataDir, id);
	const meta = readJsonSafe<SessionMeta>(path.join(dir, "meta.json"));
	if (!meta) return null;
	return {
		meta,
		telemetry: readJsonSafe<TelemetrySnapshot>(path.join(dir, "telemetry.json")),
		events: readJsonlSafe<GameEvent>(path.join(dir, "events.jsonl"), opts.limit ?? 300),
		audit: readJsonlSafe<unknown>(path.join(dir, "audit.jsonl"), opts.limit ?? 300),
	};
}

/**
 * Staged summary ("阶段性总结") for a decision point: totals + a one-line note.
 * The `note` is what the dashboard/CLI prints; the rest is machine-readable.
 */
export function buildStageSummary(
	meta: SessionMeta,
	gameDate: string,
	turn: number,
): SessionCheckpoint {
	const t = meta.totals;
	const tokens = t.usage.totalTokens.toLocaleString("en-US");
	return {
		at: Date.now(),
		gameDate,
		turn,
		note:
			`${gameDate}: ${t.decisions} decisions, ${t.toolCalls} tool calls ` +
			`(${t.toolFailures} failed), ${t.events} events, ${tokens} tokens`,
		totals: { events: t.events, decisions: t.decisions, toolCalls: t.toolCalls, usage: { ...t.usage } },
	};
}
