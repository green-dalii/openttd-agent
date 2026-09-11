/* eslint-disable no-console */
/**
 * Runner — v0.1.0 long-lived observation loop.
 *
 * 职责: 编排完整观测闭环:
 *   spawn dedicated server -> start_ai -> AdminClient (subscribe/poll)
 *     -> WorldState (accumulate) -> WebServer (snapshot + live events)
 *   + 周期 poll company economy 保持曲线新鲜。
 * 事实来源: SPEC v0.1.0; spike 实测 start_ai -> company_economy 轮询即时返回。
 * 禁止: LLM 决策 (v0.2); 修改用户全局配置; 泄漏句柄 (stop 时全关)。
 */

import { loadConfig, ConfigError, type Config } from "../config.js";
import { APP_VERSION } from "../version.js";
import { OpenTTDProcessManager } from "../game/process-manager.js";
import { AdminClient } from "../game/admin-client.js";
import { WorldState } from "../game/world-state.js";
import { WebServer } from "../web/server.js";
import { createLlmApi } from "../agent/llm-api.js";
import {
	SessionStore,
	buildStageSummary,
	listSessions,
	newSessionId,
	readSession,
	reconcileStaleSessions,
} from "../agent/session-store.js";
import { AdminUpdateType } from "../game/admin-protocol.js";
import { aiInstalledNames, isAiInstalled } from "./ai-registry.js";

export interface WatchOptions {
	/** Bundled/user AI name to start as the observed company. Default "CPU". */
	aiName?: string;
	/** Company economy poll interval ms. Default 5000. */
	pollIntervalMs?: number;
	/** Web host. */
	webHost?: string;
	/** Web port; 0 = ephemeral. Default 0. */
	webPort?: number;
	/**
	 * An already-running WebServer to attach to (supervised `--serve` mode).
	 * When given, this run must NOT create its own: one port, one WS fan-out.
	 * See docs/AGENT-LOOP-AND-CONTROL.md §3.1.
	 */
	web?: unknown;
	/** External control hooks (stop/pause/resume) for the supervisor. */
	control?: { onReady?: (h: { stop: () => void; pause: () => void; resume: () => void }) => void };
}

export interface WatchResult {
	exitCode: number;
	reason: string;
	companiesSeen: number;
	totalEvents: number;
	webPort: number;
	durationMs: number;
}

const DEFAULT_AI = "CPU";
const DEFAULT_POLL_MS = 5_000;

/** Format a game date for checkpoints ("unknown" when not yet observed). */
function formatGameDate(d: { year: number; month: number; day: number } | null): string {
	if (!d) return "unknown";
	return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export async function runWatch(
	cfg: Config,
	opts: WatchOptions = {},
): Promise<WatchResult> {
	// Heal history abandoned by a previous crash before adding to it.
	const reconciled = reconcileStaleSessions(cfg.dataDir);
	if (reconciled.length) console.log(`[watch] reconciled ${reconciled.length} abandoned session(s)`);
	const started = Date.now();
	const aiName = opts.aiName ?? DEFAULT_AI;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

	// Validate AI availability before spawning (fast fail).
	if (!isAiInstalled(cfg, aiName)) {
		const avail = aiInstalledNames(cfg).join(", ") || "(none found)";
		throw new ConfigError(
			`AI "${aiName}" not found in OpenTTD ai search path. Available: ${avail}`,
		);
	}

	const mgr = new OpenTTDProcessManager(cfg);
	const world = new WorldState();
	let client: AdminClient | null = null;
	let web: WebServer | null = null;
	let companiesSeen = 0;
	let stopRequested = false;
	let resolveStopped: (() => void) | null = null;

	// Control-C / SIGTERM handling. IMPORTANT: the signal handlers only flip a
	// flag / resolve a promise — they must NOT run async shutdown directly.
	// Empirically (OpenTTD 15.0) invoking socket writes/close as an async
	// continuation of a signal callback races the server's admin receive loop
	// and aborts it (SPEC §10.8). Shutdown runs in normal event-loop flow below.
	const requestStop = (_code: number) => {
		if (stopRequested) return;
		stopRequested = true;
		console.log("[watch] shutting down…");
		resolveStopped?.();
	};
	process.once("SIGINT", () => requestStop(0));
	process.once("SIGTERM", () => requestStop(0));
	mgr.onExit = (code) => {
		if (!stopRequested && code !== 0) {
			console.error(`[watch] server exited unexpectedly code=${code}`);
		}
	};

	// --- start server ---
	console.log(`[watch] sandbox config…`);
	await mgr.ensureSandboxConfig();
	console.log(`[watch] spawning dedicated server (${cfg.dataDir})`);
	await mgr.start();
	console.log(`[watch] waiting for admin port ${cfg.adminHost}:${cfg.adminPort}…`);
	await mgr.waitForAdminPort(20_000);
	console.log(`[watch] admin port open.`);

	// --- admin client ---
	client = new AdminClient({
		cfg,
		callbacks: {
			onEvent: (ev) => {
				world.ingest(ev);
				web?.publishEvent(ev);
				session?.appendEvent(ev);
				// Staged summary every ~60 observed events (docs/DASHBOARD-UI.md §7).
				// Declared as a hoisted function: events can arrive during connect(),
				// before a const arrow would be initialized.
				maybeCheckpoint(false);
				if (ev.kind === "company_new") {
					companiesSeen++;
					console.log(`[watch] company created: id=${(ev.payload as { id: number }).id}`);
				}
			},
			onStatusChange: (s, d) => {
				if (s === "error") console.error(`[watch] admin client error: ${d ?? s}`);
			},
			onWelcome: () => {
				console.log(`[watch] admin authed.`);
				// Start the observed AI right after auth.
				client?.rcon(`start_ai "${aiName}"`);
				console.log(`[watch] rcon start_ai "${aiName}"`);
			},
		},
	});
	await client.connect(10_000);

	// --- web server (dashboard) ---
	// --- session record (dashboard: historical sessions page) ---
	const session = new SessionStore(cfg.dataDir);
	session.create({
		id: newSessionId(cfg.seed),
		mode: "watch",
		status: "running",
		appVersion: APP_VERSION,
		startedAt: Date.now(),
		seed: cfg.seed,
		startYear: cfg.startYear,
		mapSize: [cfg.mapSizeX, cfg.mapSizeY],
		serverName: cfg.serverName,
		companyName: cfg.companyName,
		llm: { providerId: "", model: "", api: "", kind: "faux" },
	});
	console.log(`[watch] session: ${session.id}`);

	// Liveness + last-resort finalization (docs/STARTUP-AND-LIFECYCLE.md §5):
	// without these a killed process leaves the run showing as running forever.
	session.heartbeat();
	const heartbeatTimer = setInterval(() => session.heartbeat(), 2000);
	heartbeatTimer.unref();
	let finalized = false;
	const emergencyFinalize = (status: "error" | "aborted", reason?: string) => {
		if (finalized) return;
		finalized = true;
		try {
			session.finalize({ status, ...(reason ? { error: reason } : {}) });
		} catch {
			/* shutdown must not throw */
		}
	};
	const onCrash = (err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[watch] fatal: ${msg}`);
		emergencyFinalize("error", msg.slice(0, 300));
	};
	process.once("uncaughtException", onCrash);
	process.once("unhandledRejection", onCrash);

	// --- web server (dashboard) ---
	// In supervised mode a server already exists; attach to it so the dashboard
	// keeps a single port and a single WS fan-out across start/stop cycles.
	const attached = opts.web as WebServer | undefined;
	const wired = {
		version: APP_VERSION,
		getSnapshot: () => ({
			...(toWireSnapshot(world) as Record<string, unknown>),
			// Backlog for late subscribers / reloads (docs/DASHBOARD-UI.md §7).
			checkpoints: session.current().checkpoints,
		}),
		sessions: {
			list: () => listSessions(cfg.dataDir),
			read: (id: string, limit?: number) =>
				readSession(cfg.dataDir, id, limit ? { limit } : {}),
		},
	};
	if (attached) {
		attached.attach(wired);
		web = attached;
	} else {
		const llmApi = createLlmApi({ dataDir: cfg.dataDir, cfg, envLlm: cfg.llm });
		web = new WebServer({
			host: opts.webHost ?? "127.0.0.1",
			port: opts.webPort ?? 0,
			...wired,
			onFirstClient: () => {
				web?.publishSnapshot(toWireSnapshot(world));
			},
			// LLM provider settings + built-in provider catalog (SPEC §4).
			llm: llmApi.llm,
			catalog: llmApi.catalog,
		});
		await web.start();
	}
	console.log(`[watch] dashboard: http://127.0.0.1:${web.actualPort}/`);

	// --- staged summaries DURING the run (docs/DASHBOARD-UI.md §7) ---
	// Checkpoints used to be written only at shutdown, so the Live page's timeline
	// stayed empty for the whole game. Emit one every ~60 observed events, and
	// push it over WS so the timeline fills in as it runs.
	let lastCheckpointEvents = 0;
	function maybeCheckpoint(force: boolean): void {
		if (!session) return;
		const snap = world.snapshot();
		const events = snap.totalEvents;
		if (!force && events - lastCheckpointEvents < 60) return;
		lastCheckpointEvents = events;
		session.update({ totals: { ...session.current().totals, events } });
		const cp = buildStageSummary(session.current(), formatGameDate(snap.date), 0);
		session.addCheckpoint(cp);
		web?.publishCheckpoint(cp);
	}

	// Expose stop/pause/resume to the supervisor (docs §3).
	if (web) web.publishRun({ state: "running", sessionId: session.id, mode: "watch" });
	opts.control?.onReady?.({
		stop: () => {
			stopRequested = true;
			resolveStopped?.();
		},
		pause: () => {
			try {
				client?.rcon("pause");
			} catch {
				/* ignore */
			}
		},
		resume: () => {
			try {
				client?.rcon("unpause");
			} catch {
				/* ignore */
			}
		},
	});

	// --- periodic economy poll (keeps curve fresh between quarters) ---
	const pollTimer = setInterval(() => {
		const snap = world.snapshot();
		for (const [id] of snap.companies) {
			client?.pollCompanyEconomy(id);
		}
		// Also poll date to keep "today" current.
		client?.poll(AdminUpdateType.Date, 0);
	}, pollIntervalMs);
	pollTimer.unref();

	console.log(`[watch] observing… (Ctrl-C to stop)`);

	// Wait for a stop request. The signal handler only flips stopRequested; the
	// actual teardown runs here in normal event-loop flow (see requestStop note).
	await new Promise<void>((resolve) => {
		resolveStopped = resolve;
		const check = () => {
			if (stopRequested) resolve();
			else setTimeout(check, 300);
		};
		check();
	});

	// --- graceful teardown (normal flow, NOT from a signal callback) ---
	clearInterval(pollTimer);
	try {
		client?.rcon("pause");
		client?.rcon("save");
	} catch {
		/* best-effort */
	}
	await sleep(300);
	client?.close();
	// Only tear down a server we created; a supervised one outlives this run.
	if (web && !opts.web) await web.stop();
	await mgr.stop();

	// Finalize the session record so the dashboard can list/replay it.
	clearInterval(heartbeatTimer);
	process.off("uncaughtException", onCrash);
	process.off("unhandledRejection", onCrash);
	finalized = true;
	try {
		const snap = world.snapshot();
		const c0 = snap.companies.get(0);
		session.update({ totals: { ...session.current().totals, events: snap.totalEvents } });
		// Closing checkpoint: always the last one, even if the periodic one just ran.
		const cp = buildStageSummary(session.current(), formatGameDate(snap.date), 0);
		session.addCheckpoint(cp);
		web?.publishCheckpoint(cp);
		session.finalize({
			status: "completed",
			outcome: {
				vehicles: c0?.stats?.vehicles ?? undefined,
				stations: c0?.stats?.stations ?? undefined,
				money: c0?.economy ? String(c0.economy.money) : undefined,
				totalEvents: snap.totalEvents,
			},
		});
	} catch {
		/* a failed session write must not break shutdown */
	}

	const durationMs = Date.now() - started;
	return {
		exitCode: 0,
		reason: "user-stop",
		companiesSeen,
		totalEvents: world.getTotalEvents(),
		webPort: web?.actualPort ?? 0,
		durationMs,
	};
}

/** Wire-friendly snapshot: Map -> plain object; BigInt already string via caller? No — keep raw, serialize at send. */
function toWireSnapshot(world: WorldState): unknown {
	const snap = world.snapshot();
	const companies: Record<string, unknown> = {};
	for (const [id, cs] of snap.companies) {
		companies[String(id)] = {
			info: cs.info,
			economy: cs.economy,
			stats: cs.stats,
			// Server-owned curve so a refresh does not blank the chart.
			history: cs.history.slice(-400),
		};
	}
	return {
		date: snap.date,
		companies,
		totalEvents: snap.totalEvents,
		recent: snap.recent.slice(-100),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export { loadConfig };
export type { Config };
