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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, statSync } from "node:fs";
// 存档文件名规则只有一处实现（`savegameName`）：这里复用它，避免两套命名分叉。
import { savegameName } from "./runner-helpers.js";
import { appendMetric } from "../evolution/store.js";
import { classifyOutcome, describeOutcome } from "../evolution/outcome.js";
import { buildCausalTimeline, type TimelineRow } from "./causal-timeline.js";
import path from "node:path";
import type { TelemetrySnapshot } from "./telemetry.js";
import type { GameEvent } from "../types.js";
import type { RunManifest } from "./manifest.js";

/**
 * Lifecycle states. `interrupted` is never written by a *running* process — it
 * is derived at read time when a heartbeat goes stale, or persisted by the next
 * process during startup reconciliation (docs/STARTUP-AND-LIFECYCLE.md §5).
 */
export type SessionStatus = "running" | "completed" | "aborted" | "error" | "interrupted";

/** A running session with no heartbeat for this long is presumed dead. */
export const STALE_AFTER_MS = 15_000;

/** One durable summary of a session (§2.5). */
/**
 * How much cross-game memory this run was given.
 *
 * 这是 SPEC §5.2 #3 对照实验的**自变量**：不记录它，"有/无 lessons" 的对比就不成立。
 * v0.3.1 之前还没有蒸馏与注入，因此默认全 0（即对照组）。
 */
export interface MemoryInjected {
	lessonsInjected: number;
	strategiesInjected: number;
	/** C-1: route facts injected from route-facts.jsonl (counts toward treatment). */
	routeFactsInjected: number;
}

export interface SessionMeta {
	id: string;
	mode: "watch" | "agent" | "v02" | "probe";
	status: SessionStatus;
	startedAt: number;
	endedAt?: number;
	/**
	 * Last liveness tick while running. Lets readers detect a process that died
	 * without finalizing (SIGKILL / crash / power loss) instead of showing a
	 * dead run as "running" forever. See docs/STARTUP-AND-LIFECYCLE.md §5.
	 */
	heartbeatAt?: number;
	seed: number;
	startYear: number;
	mapSize: [number, number];
	serverName: string;
	companyName: string;
	llm: { providerId: string; model: string; api: string; kind: "real" | "faux" };
	/** App version that produced this run (so logs map back to code). */
	appVersion?: string;
	/**
	 * Assigned experimental arm (N2-5 fix). Recorded by the runner because only it
	 * knows whether memory injection was requested; classifying arms later from
	 * injection counts mis-assigned the first treatment run of a fresh data dir
	 * (nothing existed to inject yet) and silently compared 4 vs 6.
	 */
	arm?: "treatment" | "control";
	/**
	 * Run manifest (D3b/S9): what the model actually was and under which
	 * scaffold. Field set + normalization live in `manifest.ts` (one source).
	 */
	manifest?: RunManifest;
	/**
	 * OpenTTD version this run actually used.
	 *
	 * Same seed on a different build is not the same world, and nothing else in
	 * the record can tell them apart. `undefined`/`null` = unknown, not "same as
	 * last time".
	 */
	gameVersion?: string | null;
	/** Verified-freeze stats (SPEC §10.60); null when never frozen. */
	freeze?: { confirmed: number; unconfirmed: number; failures: number; watchdogTrips: number; maxHoldMs: number } | null;
	outcome?: {
		constructionDone?: boolean;
		/** Company income at finalize (N2-4); absent when the packet never arrived. */
		income?: number;
		/** Cargo + passengers delivered (N2-4b) - the least confounded outcome. */
		delivered?: number;
		/**
		 * Cargo + passengers delivered across the whole session, integrated past OpenTTD's
		 * quarterly reset (SPEC §10.65). The comparable flow outcome.
		 */
		deliveredRun?: number;
		/** False when whole quarters went unseen (total is then a lower bound). */
		deliveredRunComplete?: boolean;
		/**
		 * GS error replies during the run (channel health, SPEC §10.66). A
		 * partially broken GS channel degrades per run, so this must be visible
		 * next to the outcome it silently affected.
		 */
		gsErrors?: number;
		/**
		 * 局是被"谁按的暂停"结束的（2026-09-25 真机：agent 在 turn 22 自己 `set_pause`，
		 * 世界冻结、决策循环再无动作，进程却"活着" 1 小时 —— `SPEC.md` §10.101）。
		 *
		 * 为什么必须是**可查事实**而不是页面提示：这类局会以 `status: "aborted"`（甚至
		 * 长时间 `running`）混进实验统计，把"被停掉的局"当成"没学会的局"来比较。
		 * true = 局在暂停中结束；false/undefined = 不是这个原因。
		 */
		blockedByPause?: boolean;
		/** 暂停归因：谁让它停的（agent = agent 自己用 set_pause；dashboard = 人按了按钮）。 */
		pausedBy?: "agent" | "dashboard" | null;
		/** 暂停发生时刻（墙钟 ms）；用于复盘"停在哪一刻"。 */
		pausedAt?: number | null;
		/**
		 * 局结束时的冻结判定（2026-09-25，SPEC §10.102）：世界超过
		 * `WORLD_FROZEN_AFTER_MS` 没有推进，且**harness 当时没按住它**。
		 * 与 `blockedByPause` 是两个独立事实：那个是"被人停的"，这个是
		 * "世界自己不动了"（例如 OpenTTD 自己的 pause_on_join —— 2026-09-12
		 * 的 executor 疑难就是这么来的）。两者都不该被平均成"没学会"。
		 */
		worldFrozen?: boolean;
		/**
		 * 距离世界最后一次推进过了多久（墙钟 ms，局结束时测得）。
		 * 始终记录（只要见过 GS 日期）：它是**证据**，而 `worldFrozen` 是结论；
		 * 有了证据才能事后重新判定阈值而不必重跑。
		 */
		worldFrozenMs?: number;
		/** Tool calls refused by the per-decision budget (R1; absent = not reported). */
		toolBudgetBlocks?: number;
		/** Oracle probe (M3-1): fleet size requested downward, and what was observed. */
		shrinkRequested?: number | null;
		fleetObservedAfterShrink?: number | null;
		/**
		 * Simulated days this run covered (G1, SPEC §10.68). The comparable
		 * opportunity denominator: two runs with different values measured
		 * different amounts of world.
		 */
		simulatedDays?: number;
		/** Episode horizon in simulated days (null = no horizon was set). */
		horizonDays?: number | null;
		/** False when the wall-clock cap fired first: the horizon was NOT reached. */
		reachedHorizon?: boolean;
		/**
		 * S1/G4 scenario: "freeform" = the agent builds the route inside the window;
		 * "prebuilt" = the route already existed when the window opened.
		 */
		scenario?: "freeform" | "prebuilt";
		/** "ready" | "timeout" | "order_refused" (prebuilt only). */
		scenarioReason?: string | null;
		/** Cargo already delivered when the measurement window opened. */
		deliveredAtReady?: number | null;
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
		/** False when the model has no price table (cost is unknown, not zero). */
		costKnown?: boolean;
		/**
		 * G6: largest single request prompt (input+cacheRead+cacheWrite).
		 *
		 * **可选**：这个字段既可能"没测到"，也可能是**旧记录**（本字段加入之前写的
		 * metric 行）。读取侧一律按"未测量"处理（`toGameMetric` → null，永远不是 0）。
		 * 生产侧的接线由 `runner-helpers.test.ts` 保证，而不是靠把字段设成必填——
		 * 必填只会让历史数据与夹具变得不合法，并不能证明它真的被填上。
		 */
		peakRequestTokens?: number;
		/** Which turn the peak happened on; null/absent when nothing was measured. */
		peakRequestTurn?: number | null;
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

/**
 * 本局存档文件的位置与状态。
 *
 * 事实依据（真机验证 2026-09-25）：`runner.ts` 收尾时执行
 * `rcon save ${savegameName(session.id)}`，而 OpenTTD 的默认 `save_dir` 是
 * `<data_dir>/save` —— `/tmp/openttd-agent-data/save/<sessionId>.sav` 确实存在。
 * 页面需要这个路径，用户才能把存档载入游戏**人工审核**。
 *
 * `exists: false` 时**仍然返回路径**：路径本身是有用信息（用户可以先去看目录），
 * 而"还没存"与"路径未知"是两件事。
 */
export interface SavegameInfo {
	path: string;
	exists: boolean;
	bytes?: number;
	mtimeMs?: number;
}

/** 存档文件的预期路径：`<dataDir>/save/<sessionId>.sav`。 */
export function savegameFile(dataDir: string, id: string): string {
	return path.join(dataDir, "save", `${savegameName(id)}.sav`);
}

/** 存档信息；id 不安全（路径穿越）时返回 null。 */
export function savegameInfo(dataDir: string, id: string): SavegameInfo | null {
	if (!id || id.includes("/") || id.includes("..")) return null;
	const file = savegameFile(dataDir, id);
	try {
		const st = statSync(file);
		return { path: file, exists: true, bytes: st.size, mtimeMs: st.mtimeMs };
	} catch {
		// 还没写过档（或已被移走）：路径照给，exists=false 由页面解释。
		return { path: file, exists: false };
	}
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
			peakRequestTokens: 0,
			peakRequestTurn: null,
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
		appVersion: typeof meta.appVersion === "string" ? meta.appVersion : undefined,
		heartbeatAt: typeof meta.heartbeatAt === "number" ? meta.heartbeatAt : undefined,
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
	private stageCount = 0;
	/** What cross-game memory this run was given; the experiment's variable. */
	private memoryInjected: MemoryInjected = { lessonsInjected: 0, strategiesInjected: 0, routeFactsInjected: 0 };

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

	/**
	 * Liveness tick. Cheap enough to call every couple of seconds: it rewrites
	 * meta.json and the index entry (readers consult the index first, so both
	 * must carry the heartbeat or a live run looks abandoned).
	 */
	heartbeat(at: number = Date.now()): SessionMeta {
		this.meta = { ...this.meta, heartbeatAt: at };
		this.writeMeta();
		this.upsertIndex(this.meta);
		return this.meta;
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

	/**
	 * Archive one stage snapshot (data-rendered map diagram) so the Sessions page
	 * can replay the run's construction progress. Stored as a numbered JSON file
	 * under `stages/` (index = order of capture).
	 */
	saveStage(view: unknown): void {
		try {
			const dir = path.join(this.dir, "stages");
			mkdirSync(dir, { recursive: true });
			const n = this.stageCount++;
			writeFileSync(path.join(dir, `${String(n).padStart(3, "0")}.json`), JSON.stringify(view, null, 2), "utf8");
		} catch {
			/* non-fatal: a missing snapshot must not break a run */
		}
	}

	/** Stage index the next capture will use (kept in sync with saveStage). */
	nextStageIndex(): number {
		return this.stageCount;
	}

	/** Absolute path where the minimap for the next stage should be archived. */
	minimapTarget(index: number): string {
		return path.join(this.dir, "stages", `${String(index).padStart(3, "0")}.png`);
	}

	/** All archived stage snapshots, oldest first (never throws). */
	readStages(): unknown[] {
		try {
			const dir = path.join(this.dir, "stages");
			return readdirSync(dir)
				.filter((f) => f.endsWith(".json"))
				.sort()
				.map((f) => readJsonSafe<unknown>(path.join(dir, f)))
				.filter((v) => v !== null);
		} catch {
			return [];
		}
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
				usage: {
					...t.usage.total,
					// Cost is only a measurement when the model has a price table:
					// custom endpoints register zero prices, and $0.00 would read as
					// "free". Kept next to the number it qualifies.
					costKnown: t.brain?.costKnown ?? false,
					// 旧版 telemetry.json 没有 peakRequest → 未测量（见 runner-helpers 的说明）
					peakRequestTokens: t.usage.peakRequest?.tokens,
					peakRequestTurn: t.usage.peakRequest?.turn ?? null,
				},
			},
		};
	}

	/** Mark the session finished (writes meta + index one last time). */
	/**
	 * Declare what cross-game memory this run received.
	 *
	 * Called once the game's opening context has been assembled. Defaults to zero
	 * (the control arm) which is the honest value until distillation exists.
	 */
	setMemoryInjected(memory: Partial<MemoryInjected>): void {
		this.memoryInjected = {
			lessonsInjected: Math.max(0, Number(memory.lessonsInjected) || 0),
			strategiesInjected: Math.max(0, Number(memory.strategiesInjected) || 0),
			routeFactsInjected: Math.max(0, Number(memory.routeFactsInjected) || 0),
		};
	}

	finalize(patch: Partial<SessionMeta> = {}): SessionMeta {
		const meta = this.update({ endedAt: Date.now(), ...patch });
		// Record the cross-game metric here rather than in the runner: every
		// completion path (normal, emergency, reconcile) goes through finalize or
		// the reconciler, so this is the one place that cannot be forgotten.
		// See src/evolution/metrics.ts (SPEC §5.2 #3).
		recordMetricSafe(this.dataDir, meta, this.memoryInjected);
		return meta;
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
export function listSessions(dataDir: string, now: number = Date.now()): SessionMeta[] {
	const file = path.join(sessionsDir(dataDir), INDEX_FILE);
	const cur = readJsonSafe<{ sessions?: SessionMeta[] }>(file);
	const list = Array.isArray(cur?.sessions) ? cur.sessions : [];
	// Report the *effective* status so a dead run is never listed as running.
	return list
		.map((m) => withEffectiveStatus(normalizeMeta(m), now))
		.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Append this session's cross-game metric, never throwing.
 *
 * 进化账本坏了不该影响一局游戏的收尾 —— 记账是**次要**副作用，收尾是主要职责。
 * 因此这里吞掉异常，但把原因打到 stderr，避免静默丢数据。
 */
function recordMetricSafe(dataDir: string, meta: SessionMeta, injected: MemoryInjected): void {
	try {
		appendMetric(dataDir, meta, injected);
	} catch (e) {
		// Swallowing this silently would lose data with no trace, so it is
		// reported here (the one deliberate console use in this file).
		// eslint-disable-next-line no-console
		console.error(`[session] could not record evolution metric: ${e instanceof Error ? e.message : e}`);
	}
}

/** Read an archived stage image, or null. Rejects traversal and non-PNG names. */
export function readStageFile(dataDir: string, id: string, file: string): Buffer | null {
	if (!id || id.includes("/") || id.includes("..")) return null;
	// Only `NNN.png` - never an arbitrary path.
	if (!/^\d{3}\.png$/.test(file)) return null;
	try {
		return readFileSync(path.join(sessionDir(dataDir, id), "stages", file));
	} catch {
		return null;
	}
}

/** Read one session's meta/telemetry/events/audit, or null when unknown. */
export function readSession(
	dataDir: string,
	id: string,
	opts: { limit?: number } = {},
	now: number = Date.now(),
): SessionReadResult | null {
	if (!id || id.includes("/") || id.includes("..")) return null;
	const dir = sessionDir(dataDir, id);
	const raw = readJsonSafe<SessionMeta>(path.join(dir, "meta.json"));
	if (!raw) return null;
	const meta = withEffectiveStatus(normalizeMeta(raw), now);
	return {
		meta,
		telemetry: readJsonSafe<TelemetrySnapshot>(path.join(dir, "telemetry.json")),
		events: readJsonlSafe<GameEvent>(path.join(dir, "events.jsonl"), opts.limit ?? 300),
		audit: readJsonlSafe<unknown>(path.join(dir, "audit.jsonl"), opts.limit ?? 300),
	};
}

/**
 * One page of a session's causal timeline (B3).
 *
 * `rows` are the newest first (the user cares about what just happened);
 * `total` is how many rows the session has, so the page can say "there are
 * more" without loading them.
 */
export interface SessionTimelinePage {
	rows: TimelineRow[];
	total: number;
	offset: number;
}

/**
 * Read one session's causal timeline.
 *
 * Why the whole audit trail is read and then paged: a decision's tools and
 * phases live in the window **after** it, so slicing the file first would cut
 * a decision off from its own evidence. The file is read whole, the timeline
 * is built, and only the page is returned.
 *
 * null = the session does not exist or cannot be read. An empty `rows` array
 * means "this session really has no decisions" — a different claim.
 */
export function readSessionTimeline(
	dataDir: string,
	id: string,
	opts: { limit?: number; offset?: number } = {},
): SessionTimelinePage | null {
	if (!id || id.includes("/") || id.includes("..")) return null;
	const dir = sessionDir(dataDir, id);
	if (!readJsonSafe<SessionMeta>(path.join(dir, "meta.json"))) return null;
	const audit = readJsonlSafe<unknown>(path.join(dir, "audit.jsonl"));
	if (!audit) return null;
	const all = buildCausalTimeline(audit);
	const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
	const offset = Math.max(0, opts.offset ?? 0);
	// Newest first.
	const ordered = [...all].reverse();
	return {
		rows: ordered.slice(offset, offset + limit),
		total: ordered.length,
		offset,
	};
}

/**
 * The dashboard's session hooks — **one** construction, shared by the supervised
 * server and the standalone runner.
 *
 * Why one: the runner calls `web.attach({sessions: …})`, which **replaces** the
 * server's hooks with its own. Two constructions therefore meant two contracts:
 * a hook the server had but the runner did not (the causal timeline) vanished
 * from the page **as soon as a run started** — the feature worked on an idle
 * dashboard and disappeared on a running one. That is the same "two places, one
 * fact" defect as D74/A5, and it is invisible in tests that never start a run.
 *
 * The savegame info is added here (not in one of the two callers) so the page
 * sees the same shape either way.
 */
export function sessionHooks(dataDir: string): {
	list: () => unknown[];
	read: (id: string, limit?: number) => unknown | null;
	stageFile: (id: string, file: string) => Buffer | null;
	timeline: (id: string, opts: { limit?: number; offset?: number }) => SessionTimelinePage | null;
} {
	return {
		list: () => listSessions(dataDir).map((s) => ({ ...s, savegame: savegameInfo(dataDir, s.id), outcome: withOutcomeClass(s) })),
		read: (id, limit) => {
			const one = readSession(dataDir, id, limit ? { limit } : {});
			return one
				? { ...one, savegame: savegameInfo(dataDir, id), outcome: withOutcomeClass(one.meta) }
				: one;
		},
		stageFile: (id, file) => readStageFile(dataDir, id, file),
		timeline: (id, opts) => readSessionTimeline(dataDir, id, opts),
	};
}

/**
 * The session's outcome, **named** (B5).
 *
 * 派生而非存储：类由事实算出（`classifyOutcome`），所以它不可能与事实不一致；
 * 名字与解释由服务端给（`describeOutcome`），页面不必自己写一份词表。
 * 缺读数 → `unknown`（"没测到"），不是"什么都没发生"（D60）。
 */
function withOutcomeClass(meta: SessionMeta): SessionMeta["outcome"] & {
	class?: string;
	label?: string;
	hint?: string;
} {
	const o = meta.outcome ?? {};
	const t = meta.totals;
	const d = describeOutcome(
		classifyOutcome({
			deliveredRun: o.deliveredRun ?? null,
			constructionDone: o.constructionDone ?? null,
			toolCalls: t?.toolCalls ?? null,
			toolFailures: t?.toolFailures ?? null,
			gsErrors: o.gsErrors ?? null,
			reachedHorizon: o.reachedHorizon ?? null,
			blockedByPause: o.blockedByPause ?? null,
			worldFrozen: o.worldFrozen ?? null,
			totalTokens: t?.usage?.totalTokens ?? null,
			costTotal: t?.usage?.costTotal ?? null,
			costKnown: t?.usage?.costKnown !== false,
			manifest: meta.manifest ?? null,
		}),
	);
	return { ...o, class: d.code, label: d.label, hint: d.hint };
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

/* ---------------------- lifecycle: liveness ---------------------- */

/**
 * Status a reader should show, accounting for a process that died without
 * finalizing. Pure: it never mutates or writes.
 *
 * A `running` record whose last heartbeat (or start, if it never beat) is older
 * than STALE_AFTER_MS is reported as `interrupted`; anything already finished is
 * returned unchanged regardless of age.
 */
export function effectiveStatus(meta: SessionMeta, now: number = Date.now()): SessionStatus {
	if (meta.status !== "running") return meta.status;
	const last = meta.heartbeatAt ?? meta.startedAt;
	return now - last > STALE_AFTER_MS ? "interrupted" : "running";
}

/** Apply effectiveStatus to a meta object (returns a copy when it changes). */
function withEffectiveStatus(meta: SessionMeta, now: number): SessionMeta {
	const eff = effectiveStatus(meta, now);
	return eff === meta.status ? meta : { ...meta, status: eff };
}

/**
 * Persist `interrupted` for records abandoned by a previous process.
 *
 * Called once at startup: it makes history self-healing so the dashboard never
 * shows a dead session as running, and it is idempotent.
 * Returns the ids that were changed.
 */
export function reconcileStaleSessions(dataDir: string, now: number = Date.now()): string[] {
	const changed: string[] = [];
	let list: SessionMeta[];
	try {
		// Read the RAW index: effectiveStatus() maps both "stale running" and
		// "already reconciled" to "interrupted", so it cannot tell them apart and
		// a second pass would keep re-writing (not idempotent). The stored status
		// is what distinguishes them.
		const file = path.join(sessionsDir(dataDir), INDEX_FILE);
		const cur = readJsonSafe<{ sessions?: SessionMeta[] }>(file);
		const raw = Array.isArray(cur?.sessions) ? cur.sessions : [];
		list = raw.map((m) => normalizeMeta(m));
	} catch {
		return changed;
	}
	for (const meta of list) {
		// Only a record that still *claims* to be running can be abandoned.
		if (meta.status !== "running") continue;
		if (effectiveStatus(meta, now) !== "interrupted") continue;
		try {
			const dir = sessionDir(dataDir, meta.id);
			const next: SessionMeta = {
				...meta,
				status: "interrupted",
				heartbeatAt: meta.heartbeatAt,
				endedAt: meta.heartbeatAt ?? meta.startedAt,
				error: meta.error ?? "interrupted: process exited without finalizing",
			};
			writeFileSync(path.join(dir, "meta.json"), JSON.stringify(next, null, 2), "utf8");
			// Same reason as finalize(): an abandoned run still belongs in the ledger.
			recordMetricSafe(dataDir, next, { lessonsInjected: 0, strategiesInjected: 0, routeFactsInjected: 0 });
			changed.push(meta.id);
		} catch {
			/* a record we cannot rewrite must not break startup */
		}
	}
	if (changed.length) {
		// Rewrite the index so a single read sees the corrected states.
		try {
			const file = path.join(sessionsDir(dataDir), INDEX_FILE);
			const cur = readJsonSafe<{ sessions?: SessionMeta[] }>(file);
			const all = Array.isArray(cur?.sessions) ? cur.sessions : [];
			const ids = new Set(changed);
			const next = all.map((m) =>
				ids.has(m.id) ? { ...m, status: "interrupted" as const, endedAt: m.heartbeatAt ?? m.startedAt } : m,
			);
			writeFileSync(file, JSON.stringify({ sessions: next }, null, 2), "utf8");
		} catch {
			/* non-fatal: meta.json is the source of truth */
		}
	}
	return changed;
}
