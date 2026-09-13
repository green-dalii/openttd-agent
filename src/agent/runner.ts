/* eslint-disable no-console */
/**
 * Agent runner — boot the game and drive it with the pi-agent-core brain.
 *
 * 职责: 编排「LLM 决策 → 命令通道 → 施工 → 观测回灌」的完整 M2 闭环，复用
 *   v0.2 已验证的引导步骤（deploy packs / attach GS / start_ai）+ Bash 命令通道。
 *   provider 可插拔：默认 faux（脚本化，离线可复现地证明接线），可选真实 provider。
 * 事实来源: SPEC §4.2（决策循环）、§10.10-§10.15（引导与施工事实）。
 * 禁止: 在信号回调里做 async 收尾（§10.9）；阻塞等待施工（异步轮询）。
 */

import { OpenTTDProcessManager } from "../game/process-manager.js";
import { APP_VERSION } from "../version.js";
import { AdminClient } from "../game/admin-client.js";
import { WorldState } from "../game/world-state.js";
import path from "node:path";
import { renameSync, statSync } from "node:fs";
import { AdminUpdateType, ALL_COMPANIES } from "../game/admin-protocol.js";
import {
	deploySquirrelPacks,
	selectBridgeGsInConfig,
	BRIDGE_GS_NAME,
	EXECUTOR_AI_NAME,
} from "../game/squirrel-deploy.js";
import type { Config } from "../config.js";
import { createAgent } from "./runtime.js";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
/** pi-agent-core's StreamFn, via AgentOptions. */
type AgentOptionsStreamFn = AgentOptions["streamFn"];
import { runDecision, type DecisionPlan } from "./loop.js";
import { DecisionScheduler } from "./scheduler.js";
import { buildStageView } from "./stage-view.js";
import { captureMinimap, MINIMAP_REL_PATH } from "../game/minimap.js";
import {
	emptyTracker,
	recordAction,
	recordEvent,
	recordPhase,
	type DecisionTracker,
} from "./decision-context.js";
import type { GameEvent } from "../types.js";
import type { AgentDeps } from "./types.js";
import { summarizeState } from "./tools/index.js";
import { fauxAssistantMessage, fauxToolCall, createFauxCore } from "@earendil-works/pi-ai";
import { buildBrain, redactKey } from "./provider.js";
import { Telemetry } from "./telemetry.js";
import type { TelemetrySnapshot } from "./telemetry.js";
import { FileCredentialStore } from "./file-credential-store.js";
import {
	SessionStore,
	buildStageSummary,
	listSessions,
	newSessionId,
	readSession,
	readStageFile,
	reconcileStaleSessions,
} from "./session-store.js";
import type { SessionTotals } from "./session-store.js";
import { createLlmApi } from "./llm-api.js";
import { WebServer } from "../web/server.js";
import { pruningTransformContext } from "./context.js";
import { loadMemory, makeLessonProvider, memoryCounts, type LoadedMemory } from "../evolution/memory.js";
import { runReflection } from "../evolution/reflection-run.js";
import { buildReflectionEvidence } from "../evolution/reflect.js";
import { isErrorPhase, phaseStage } from "../game/executor-status.js";
import { evolutionView, setStrategyEnabled } from "../evolution/web-view.js";
import { AuditLog } from "./audit.js";
import { isLlmConfigured } from "../config.js";
import { toWireSnapshot } from "../game/wire-snapshot.js";

export interface AgentRunOptions {
	/** Seconds to observe construction after the decision(s). 0 = until Ctrl-C. */
	seconds?: number;
	/** Scripted plan for the faux provider: towns to build between. */
	planTowns?: { from?: number; to?: number };
	/**
	 * Explicit opt-in to the scripted (non-LLM) brain. Without it, agent mode
	 * refuses to run when no LLM is configured instead of silently simulating
	 * (docs/STARTUP-AND-LIFECYCLE.md §1).
	 */
	offlineDemo?: boolean;
	/**
	 * Seed the agent with cross-game memory. Default TRUE - this is the mechanism
	 * of self-evolution (src/evolution/memory.ts). Set false only for the control
	 * arm of the M3 experiment.
	 */
	injectMemory?: boolean;
	/** Max decision turns to run (default 1). */
	maxTurns?: number;
	/**
	 * An already-running WebServer to attach to (supervised mode). When given,
	 * the run must NOT start its own - two servers would fight over the port and
	 * the dashboard would only see half the state.
	 * See docs/AGENT-LOOP-AND-CONTROL.md §3.1.
	 */
	web?: unknown;
	/** External control hooks for the supervisor (stop/pause/resume). */
	control?: {
		onReady?: (h: { stop: () => void; pause: () => void; resume: () => void }) => void;
	};
	/** Min wall-clock gap between two LLM decisions (default 5s). */
	decisionMinGapMs?: number;
	/** Game days between periodic decisions (default 90). */
	decisionIntervalDays?: number;
	/** Scheduler poll interval (default 1s). */
	decisionTickMs?: number;
	/** Hard cap on decisions per run; 0 = unlimited (default). */
	maxDecisions?: number;
	/**
	 * Dashboard port in agent mode. Undefined ⇒ no dashboard (CLI-only run);
	 * 0 ⇒ ephemeral port. Agent mode serves the same live dashboard the watch
	 * mode does, including telemetry (SPEC §4 / docs/DASHBOARD-API.md).
	 */
	webPort?: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Format a game date for session checkpoints ("unknown" when not observed). */
function formatGameDate(d: { year: number; month: number; day: number } | null): string {
	if (!d) return "unknown";
	return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/**
 * Copy live telemetry into the session record's totals.
 *
 * Without this the session (and therefore every staged summary) reported
 * `0 decisions, 0 tool calls, 0 tokens` in agent mode, because only `events`
 * was ever synced — the flagship "总结" feature read as an empty run.
 * Kept as the single source of truth for both the per-turn and final writes.
 */
function totalsFromTelemetry(
	prev: SessionTotals,
	t: TelemetrySnapshot,
	events: number,
): SessionTotals {
	const u = t.usage.total;
	return {
		events,
		decisions: t.totals.decisions,
		toolCalls: t.totals.toolCalls,
		toolFailures: t.totals.toolFailures,
		usage: {
			input: u.input,
			output: u.output,
			cacheRead: u.cacheRead,
			cacheWrite: u.cacheWrite,
			reasoning: u.reasoning,
			totalTokens: u.totalTokens,
			costTotal: u.costTotal,
		},
	};
}

/**
 * Describe a fleet/station change worth the model's attention, or null when
 * nothing notable happened. Facts only - the model decides what it means.
 */
function describeNotable(
	prev: { vehicles: number; stations: number } | null,
	now: { vehicles?: number; stations?: number },
): string | null {
	if (!prev) return null;
	const parts: string[] = [];
	const dv = (now.vehicles ?? 0) - prev.vehicles;
	const ds = (now.stations ?? 0) - prev.stations;
	if (dv) parts.push(`vehicles ${dv > 0 ? "+" : ""}${dv}`);
	if (ds) parts.push(`stations ${ds > 0 ? "+" : ""}${ds}`);
	return parts.length ? parts.join(", ") : null;
}

/** Game days elapsed since the first observed date, for interval scheduling. */
function gameDaysSinceStart(deps: AgentDeps): number {
	const d = deps.state.snapshot().date;
	if (!d) return 0;
	return (d.year - 1950) * 360 + (d.month - 1) * 30 + (d.day - 1);
}

/** Comparable numbers for the next decision's delta. */
function baselineOf(snap: ReturnType<AgentDeps["state"]["snapshot"]>, gameDay: number) {
	const c = snap.companies.get(0) ?? [...snap.companies.values()][0];
	return {
		money: Number(c?.economy?.money ?? 0) || 0,
		income: c?.economy ? Number(BigInt.asIntN(64, c.economy.income)) || 0 : 0,
		vehicles: c?.stats?.vehicles ?? 0,
		stations: c?.stats?.stations ?? 0,
		gameDay,
	};
}

/** Human-readable description of the selected brain (never includes the key). */
function describeBrainSelection(cfg: Config): string {
	const src = cfg.llm.source === "catalog" ? "catalog" : cfg.llm.baseUrl ? "custom" : "catalog";
	const where = src === "custom" ? `base=${cfg.llm.baseUrl}` : `provider=${cfg.llm.providerId}`;
	return `${where} model=${cfg.llm.model} api=${cfg.llm.api}`;
}


/** How often to refresh the session heartbeat (docs/STARTUP-AND-LIFECYCLE.md §5). */
const HEARTBEAT_MS = 2000;

/** Run one agent-driven session. Returns process exit code. */
export async function runAgent(cfg: Config, opts: AgentRunOptions = {}): Promise<number> {
	// Self-heal history left behind by a previous process that died without
	// finalizing (SIGKILL / crash): those records would otherwise show as
	// "running" in the dashboard forever.
	const reconciled = reconcileStaleSessions(cfg.dataDir);
	if (reconciled.length) {
		console.log(`[agent] reconciled ${reconciled.length} abandoned session(s) -> interrupted`);
	}
	const mgr = new OpenTTDProcessManager(cfg);
	const world = new WorldState();
	let client: AdminClient | null = null;
	let stopRequested = false;
	// `stopRequested` alone is enough now that the decision loop checks it every
	// tick and owns the run length. There used to be a `resolveStop` promise here
	// purely to break a `Promise.race` that sat AFTER the loop - i.e. a wait that
	// could never start before the loop had already finished (SPEC §10.30).
	const requestStop = () => {
		if (stopRequested) return;
		stopRequested = true;
	};
	process.once("SIGINT", requestStop);
	process.once("SIGTERM", requestStop);
	mgr.onExit = (code) => {
		if (!stopRequested && code !== 0) console.error(`[agent] server exited unexpectedly code=${code}`);
	};

	// --- boot the game (same verified steps as v0.2) ---
	console.log(`[agent] deploying packs (${BRIDGE_GS_NAME}, ${EXECUTOR_AI_NAME})…`);
	await deploySquirrelPacks(cfg);
	await mgr.ensureSandboxConfig();
	await selectBridgeGsInConfig(cfg);
	await mgr.start();
	await mgr.waitForAdminPort(25_000);

	let gsStates = 0;
	let executorPhase = "";
	// Last phase STAGE (see phaseStage) - the news gate. MUST be declared here,
	// above `new AdminClient`: the event callback fires during boot, and a `let`
	// declared next to its first assignment is in the temporal dead zone at that
	// moment, which throws inside every callback (MEMORY.md A5 - four occurrences).
	let executorStage = "";
	// The executor's periodic bus dump overwrites the company name, so the
	// LAST phase is not the terminal one. Track "reached done" separately.
	let reachedDone = false;

	// Decision cadence + the causality window handed to the model. The framework
	// owns *when* to ask; the LLM owns *what* to do (docs/AGENT-LOOP-AND-CONTROL §1).
	const scheduler = new DecisionScheduler({
		minGapMs: opts.decisionMinGapMs ?? 5_000,
		intervalGameDays: opts.decisionIntervalDays ?? 90,
	});
	let tracker: DecisionTracker = emptyTracker();
	// The model's requested wake-up (SPEC §4.2 step 5), if it gave one.
	let waitUntil: { gameDays: number; from: number } | null = null;
	// Latest route ack from the executor (drives the map diagram).
	let lastRoute: Record<string, unknown> | null = null;
	// Last company stats, used to detect changes worth a decision.
	let prevStats: { vehicles: number; stations: number } | null = null;
	let waitCondition: string | null = null;
	// Set below (after the session exists) so events during boot are still safe.
	let onPhaseChange: ((phase: string) => void) | null = null;
	let onNotableEvent: ((summary: string) => void) | null = null;

	// --- forward declarations, deliberately ABOVE `new AdminClient` -------------
	//
	// The admin callbacks below fire DURING boot, i.e. before the SessionStore
	// (further down) and the dashboard (much further down) are constructed. A
	// `let web` declared next to its assignment is in the temporal dead zone when
	// those callbacks run: reading it throws "Cannot access 'web' before
	// initialization", which kills every callback, so the GS never heartbeats and
	// the run aborts with a message that points nowhere near the real cause.
	//
	// Anything the callbacks touch must therefore be declared here. `web` starts
	// null because there is genuinely nothing to publish to yet.
	let web: WebServer | null = null;
	let sessionRef: SessionStore | null = null;
	// Events that arrive before the session exists are BUFFERED, not dropped.
	// They are handshake/connect frames; dropping them silently would make the
	// audit trail begin mid-conversation with no record of why.
	const bootEvents: GameEvent[] = [];
	const BOOT_EVENT_CAP = 256;

	client = new AdminClient({
		cfg,
		callbacks: {
			onEvent: (ev) => {
				world.ingest(ev);
				// Forward to the dashboard. The `--watch` runner has always done this
				// (src/game/runner.ts) but the agent path did not, so during `--agent`
				// - the main mode - the page received NO event frames at all: its
				// company mirror and history never advanced, and the KPIs stayed frozen
				// at whatever the connect-time snapshot said until a manual reload.
				// Same shape as the toWireSnapshot bug (MEMORY.md C1): two paths, one of
				// them missing a piece, and the other path "looking fine" hid it.
				web?.publishEvent(ev);
				if (sessionRef) sessionRef.appendEvent(ev);
				else if (bootEvents.length < BOOT_EVENT_CAP) bootEvents.push(ev);
				if (ev.kind === "gamescript") {
					const p = ev.payload as Record<string, unknown>;
					if (p.cmd === "state") {
						gsStates++;
						// The GS owns the town list; the agent only reads it. Without
						// this the agent could not see the options it was choosing
						// between, which is what made the M3 experiment saturated
						// (SPEC §10.32).
						if (Array.isArray(p.town_list)) {
							world.setTowns(
								(p.town_list as { id?: unknown; pop?: unknown; x?: unknown; y?: unknown }[]).map((t) => ({
									id: Number(t.id),
									population: Number(t.pop),
									x: Number(t.x),
									y: Number(t.y),
								})),
							);
						}
						// Sample the GS's own clock. This is the only way to tell
						// "the game is not running" from "the executor is not
						// looping": the GS sends these every 200 ticks, so if the
						// DATE does not advance, the game is stopped; if the date
						// advances but the executor stays silent, the executor is
						// starved of script ticks (ROADMAP 4b follow-up).
						if (gsStates % 5 === 1) {
							console.log(
								`[agent] GS state #${gsStates} date=${String(p.date)} towns=${String(p.towns)} signs=${String(p.signs)}`,
							);
						}
					}
					else {
						console.log(`[agent] GS: ${JSON.stringify(p)}`);
						// Remember the coordinates the executor acknowledged, so each
						// stage snapshot can draw the actual built route.
						if (p.kind === "ack" && p.cmd === "build_bus_route") lastRoute = p;
					}
				}
				// Notable events (fleet/station changes) are worth the model's
				// attention, so they open a decision window (scheduler throttles).
				if (ev.kind === "company_stats") {
					const st = ev.payload as { vehicles?: number; stations?: number };
					const notable = describeNotable(prevStats, st);
					if (notable) onNotableEvent?.(notable);
					prevStats = { vehicles: st.vehicles ?? 0, stations: st.stations ?? 0 };
				}
				if (ev.kind === "company_info") {
					const p = ev.payload as { id: number; name: string; isAi: boolean };
					// Compare the phase IDENTITY, not the raw string. The heartbeat is
					// `hb <stage> #<seq> s<signs>` and increments `seq` every loop, so a
					// raw comparison made every beat look like a phase change: measured
					// 197 of 212 decisions triggered that way, ~36 per game, with money
					// unmoved in 83% of the intervals (MEASURED 2026-09-12).
					// A heartbeat means nothing happened - it must never wake the model.
					const stage = phaseStage(p.name);
					if (p.isAi && p.name.startsWith("EX ") && (stage !== executorStage || isErrorPhase(p.name))) {
						executorStage = stage;
						executorPhase = p.name;
						if (p.name.startsWith("EX done")) reachedDone = true;
						console.log(`[agent] executor phase -> "${p.name}"`);
						// A phase change means the world moved: it is a reason to ask
						// the model again (it may want to react to the new situation).
						onPhaseChange?.(p.name);
					}
				}
			},
			onStatusChange: (s, d) => {
				if (s === "error") console.error(`[agent] admin error: ${d ?? s}`);
			},
		},
	});
	await client.connect(10_000);

	const gsDeadline = Date.now() + 20_000;
	while (gsStates === 0 && Date.now() < gsDeadline && !stopRequested) await sleep(250);
	if (gsStates === 0) {
		console.error("[agent] ERROR: BridgeV1 GS never heartbeated.");
		await teardown();
		return 1;
	}
	console.log("[agent] GS alive. starting executor…");
	client.rcon(`start_ai "${EXECUTOR_AI_NAME}"`);

	// wait for the executor company to appear (boot phase)
	const bootDeadline = Date.now() + 20_000;
	while (!executorPhase.startsWith("EX boot") && Date.now() < bootDeadline && !stopRequested) {
		client.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		await sleep(500);
	}
	console.log(`[agent] executor booted (phase="${executorPhase}")`);

	// --- assemble the brain ---
	// Real provider when configured (LLM_BASE_URL/LLM_MODEL, or dashboard/CLI);
	// otherwise the offline faux provider (scripted) so the wiring is still
	// demonstrable without a key. faux is NOT a real LLM — it cannot validate
	// decision quality, only the command plumbing.
	const deps: AgentDeps = { sink: client, state: world };
	let streamFn: AgentOptionsStreamFn;
	let model: Model<string>;
	let brainKind: "real" | "faux" = "faux";
	const mustServeDashboard = opts.webPort !== undefined;

	// The credential store keeps dashboard-saved keys across restarts (pi-ai's
	// default store is in-memory only).
	const credentials = new FileCredentialStore(path.join(cfg.dataDir, "credentials.json"));
	if (isLlmConfigured(cfg.llm)) {
		// Catalog = pi-ai built-in provider; custom = arbitrary OpenAI-compatible
		// endpoint (docs/DASHBOARD-API.md §6.5).
		const built = await buildBrain(cfg.llm, { credentials });
		streamFn = built.streamFn as unknown as AgentOptionsStreamFn;
		model = built.model;
		brainKind = "real";
		console.log(
			`[agent] brain: REAL ${built.source} provider ${describeBrainSelection(cfg)} key=${redactKey(cfg.llm.apiKey)}`,
		);
	} else if (!opts.offlineDemo) {
		// No silent fallback. Preflight normally catches this before we get here;
		// reaching it means the runner was invoked directly (library/tests), and
		// pretending to work would be worse than failing.
		throw new Error(
			"no LLM configured: refusing to run a simulated game. " +
				"Configure a provider (Providers page, or LLM_PROVIDER/LLM_MODEL), " +
				"or pass --offline-demo to run the scripted demo explicitly.",
		);
	} else {
		// Explicit offline demo: scripted plan, clearly labelled as such in the UI
		// (brain.kind = "faux") so it can never be mistaken for a real run.
		const faux = createFauxCore({});
		const plan = opts.planTowns ?? {};
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("build_bus_route", {
					...(plan.from !== undefined ? { from_town: plan.from } : {}),
					...(plan.to !== undefined ? { to_town: plan.to } : {}),
				}),
			]),
			fauxAssistantMessage("Route requested; awaiting in-game construction."),
		]);
		streamFn = faux.streamSimple as unknown as AgentOptionsStreamFn;
		model = faux.getModel() as unknown as Model<string>;
		console.log("[agent] brain: FAUX provider (--offline-demo — NOT a real LLM)");
	}
	// Audit trail (SPEC §7): decisions + action results -> JSONL under dataDir.
	const audit = new AuditLog(cfg.dataDir, "agent-audit.jsonl");
	audit.write({ type: "note", ts: Date.now(), message: "agent session start" });
	console.log(`[agent] audit: ${audit.path()}`);

	// Session record + telemetry (dashboard: sessions page, token accounting).
	const session = new SessionStore(cfg.dataDir);
	// Unblock the boot callbacks that were buffering while this did not exist.
	sessionRef = session;
	for (const ev of bootEvents) session.appendEvent(ev);
	bootEvents.length = 0;
	session.create({
		id: newSessionId(cfg.seed),
		mode: "agent",
		status: "running",
		appVersion: APP_VERSION,
		startedAt: Date.now(),
		seed: cfg.seed,
		startYear: cfg.startYear,
		mapSize: [cfg.mapSizeX, cfg.mapSizeY],
		serverName: cfg.serverName,
		companyName: cfg.companyName,
		llm: {
			providerId: cfg.llm.providerId,
			model: cfg.llm.model,
			api: cfg.llm.api,
			kind: brainKind,
		},
	});
	const telemetry = new Telemetry({ sessionId: session.id });
	telemetry.setBrain({
		provider: cfg.llm.providerId || (brainKind === "faux" ? "faux" : ""),
		model: cfg.llm.model || (brainKind === "faux" ? "faux" : ""),
		kind: brainKind,
	});
	session.saveTelemetry(telemetry.snapshot());
	console.log(`[agent] session: ${session.id}`);

	// Keep the record provably alive, and make a hard failure end it properly.
	session.heartbeat();
	const heartbeatTimer = setInterval(() => session.heartbeat(), HEARTBEAT_MS);
	heartbeatTimer.unref();

	// Last-resort finalization: an uncaught error or a hard signal must not leave
	// the session claiming to be running.
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
		console.error(`[agent] fatal: ${msg}`);
		emergencyFinalize("error", msg.slice(0, 300));
	};
	process.once("uncaughtException", onCrash);
	process.once("unhandledRejection", onCrash);
	process.once("SIGHUP", requestStop);

	// --- dashboard (same shape as watch mode; docs/DASHBOARD-API.md §3) ---
	// Supervised mode attaches to an existing server (one port, one fan-out).
	const attachedWeb = opts.web as WebServer | undefined;
	// The snapshot has to report what memory this game was given, but `loadMemory()`
	// runs further down (after the provider is built). Holding it here avoids a
	// temporal-dead-zone read when a client connects before the library is loaded.
	let runMemory: LoadedMemory = { lessons: [], strategies: [], lines: [] };
	const wired = {
		version: APP_VERSION,
		getSnapshot: () => ({
			...(toWireSnapshot(world) as Record<string, unknown>),
			telemetry: telemetry.snapshot(),
			sessionId: session.id,
			// Backlog for late subscribers / reloads (docs/DASHBOARD-UI.md §7).
			checkpoints: session.current().checkpoints,
			stages: stageViews.slice(-24),
			// What this game was TOLD, not just how many items were counted.
			// The ledger records `lessonsInjected: 1`; without the content that count
			// is unverifiable, and "we think it is wired" is the exact failure this
			// repo has already paid for once (AGENTS §5.1).
			memory: {
				lessonsInjected: runMemory.lessons.length,
				strategiesInjected: runMemory.strategies.length,
				lessons: runMemory.lessons.map((l) => ({
					text: l.text,
					kind: l.kind,
					confidence: l.confidence,
					evidence: l.evidence,
				})),
				strategies: runMemory.strategies.map((c) => ({ action: c.action, params: c.params })),
			},
		}),
		telemetry: () => telemetry.snapshot(),
		sessions: {
			list: () => listSessions(cfg.dataDir),
			read: (id: string, limit?: number) => readSession(cfg.dataDir, id, limit ? { limit } : {}),
			stageFile: (id: string, file: string) => readStageFile(cfg.dataDir, id, file),
		},
		// Same evolution view as the supervised server, so an unsupervised run
		// serves the identical contract instead of a second implementation.
		evolution: {
			metrics: () => evolutionView(cfg.dataDir).metrics,
			lessons: () => evolutionView(cfg.dataDir).lessons,
			strategies: () => evolutionView(cfg.dataDir).strategies,
			arms: () => evolutionView(cfg.dataDir).arms,
			setStrategyEnabled: (id: string, enabled: boolean) =>
				setStrategyEnabled(cfg.dataDir, id, enabled),
		},
	};
	if (attachedWeb) {
		attachedWeb.attach(wired);
		web = attachedWeb;
	} else if (mustServeDashboard) {
		const llmApi = createLlmApi({ dataDir: cfg.dataDir, cfg, envLlm: cfg.llm });
		web = new WebServer({
			host: "127.0.0.1",
			port: opts.webPort ?? 0,
			...wired,
			llm: llmApi.llm,
			catalog: llmApi.catalog,
		});
		await web.start();
		console.log(`[agent] dashboard: http://127.0.0.1:${web.actualPort}/`);
	}

	// Publish the session id and expose stop/pause/resume to the supervisor.
	if (web) web.publishRun({ state: "running", sessionId: session.id, mode: "agent" });
	opts.control?.onReady?.({
		stop: requestStop,
		pause: () => {
			scheduler.pause();
			try {
				client?.rcon("pause");
			} catch {
				/* ignore */
			}
		},
		resume: () => {
			scheduler.resume(gameDaysSinceStart(deps));
			try {
				client?.rcon("unpause");
			} catch {
				/* ignore */
			}
		},
	});

	// Telemetry -> WS (throttled) + session archive. ≥250ms per contract §4.
	let lastBroadcast = 0;
	const broadcast = () => {
		const now = Date.now();
		if (now - lastBroadcast < 250) return;
		lastBroadcast = now;
		web?.publishTelemetry(telemetry.snapshot());
	};
	telemetry.onStep = (step) => {
		const { ts: stepTs, ...rest } = step;
		session.appendAudit({ type: "step", ts: stepTs, ...rest });
		web?.publishStep(step);
		broadcast();
	};
	telemetry.onActivity = broadcast;

	/** Tool outcomes since the last decision, fed back to the model next time. */
	const pendingActions: { tool: string; ok: boolean; summary: string }[] = [];
	/** Stage snapshots this run produced (also archived per session). */
	const stageViews: (ReturnType<typeof buildStageView> & { index: number; image?: string })[] = [];

	/**
	 * Capture the game's real minimap for this stage, if the game can produce one.
	 *
	 * `screenshot minimap` works even on a headless dedicated server (the minimap
	 * is rendered from map data, not the 3D viewport) - see src/game/minimap.ts.
	 * Best effort: a failure only means this stage has no image.
	 */
	const captureStageImage = async (index: number): Promise<string | null> => {
		const target = session.minimapTarget(index);
		const ok = await captureMinimap(
			{
				send: (cmd) => client?.rcon(cmd),
				statMtime: () => {
					try {
						return statSync(path.join(cfg.dataDir, MINIMAP_REL_PATH)).mtimeMs;
					} catch {
						return null;
					}
				},
				move: (from, to) => renameSync(from, to),
				sleep,
				now: () => Date.now(),
			},
			{ target, source: path.join(cfg.dataDir, MINIMAP_REL_PATH) },
		);
		return ok ? path.basename(target) : null;
	};

	/** Build + push a stage snapshot (map diagram) for the dashboard timeline. */
	const publishStage = (phase?: string) => {
		const snap = deps.state.snapshot();
		const c0 = snap.companies.get(0);
		const view = buildStageView({
			gameDate: formatGameDate(snap.date),
			mapSize: [cfg.mapSizeX, cfg.mapSizeY],
			companies: [...snap.companies.values()].map((c) => ({
				id: c.info?.id ?? 0,
				name: c.info?.name ?? null,
				money: c.economy?.money,
				vehicles: c.stats?.vehicles,
				stations: c.stats?.stations,
			})),
			route: lastRoute,
			...(phase ? { phase } : {}),
		});
		void c0;
		const index = session.nextStageIndex();
		// Pair the view with its archive index so the page can request the image.
		const stamped = { ...view, index };
		stageViews.push(stamped);
		session.saveStage(view);
		web?.publishStage(stamped);
		// The real image is captured asynchronously; the diagram is immediate.
		void captureStageImage(index).then((img) => {
			if (!img) return;
			const st = stageViews.find((x) => x.index === index);
			if (st) st.image = img;
			web?.publishStageImage({ index, file: img, gameDate: view.gameDate });
		});
	};

	// --- cross-game memory (SPEC §5.1 first + last steps of the game loop) ---
	// Load the library once, before the agent is assembled, so the opening context
	// already carries previous games' lessons. Injection is off unless the library
	// actually has confirmed content (see docs/EVOLUTION.md §3).
	const memory = loadMemory(cfg.dataDir, { inject: opts.injectMemory !== false });
	const memoryProvider = makeLessonProvider(memory);
	const injected = memoryCounts(memory);
	// Publish it for the dashboard (per-game truth: what THIS game was told).
	runMemory = memory;
	session.setMemoryInjected(injected);
	if (injected.lessonsInjected || injected.strategiesInjected) {
		console.log(
			`[evolution] loaded memory: ${injected.lessonsInjected} lesson(s), ` +
				`${injected.strategiesInjected} strategy card(s)`,
		);
	}

	/**
	 * One tool-free model call, used only by end-of-game reflection.
	 *
	 * Deliberately not routed through the agent: reflection must not be able to
	 * act on the game, and it must not pollute the agent's own turn/telemetry
	 * accounting with a call that is not a decision.
	 */
	async function completeOnce(prompt: { system: string; user: string }): Promise<string> {
		const stream = (await streamFn(
			model,
			{
				systemPrompt: prompt.system,
				messages: [{ role: "user", content: prompt.user }],
			} as never,
			{} as never,
		)) as AsyncIterable<{ type?: string; delta?: unknown }>;
		let text = "";
		for await (const ev of stream) {
			if (ev && ev.type === "text_delta" && typeof ev.delta === "string") text += ev.delta;
		}
		return text;
	}

	const { agent } = createAgent({
		deps,
		streamFn,
		model,
		// Context hygiene + cross-game lesson injection (SPEC §4.1).
		//
		// `lessonsProvider` existed as an unfed hook since v0.2.1: every game ran in
		// complete isolation because nothing ever supplied it. Loading the memory once
		// here (rather than per LLM call) keeps the injected set stable for the whole
		// run, and `setMemoryInjected` records what was ACTUALLY injected - that count
		// is the independent variable of the M3 "with/without lessons" experiment.
		transformContext: pruningTransformContext({
			keepRecent: 40,
			lessonsProvider: memoryProvider,
		}),
		onActionResult: (tool, r) => {
			console.log(`[agent] tool ${tool}: ok=${r.ok} ${r.summary}`);
			// Failures are recorded too: the model must be able to see its own
			// mistakes on the next decision (docs/AGENT-LOOP-AND-CONTROL §2.4).
			pendingActions.push({ tool, ok: r.ok, summary: r.summary });
			audit.write({ type: "action_result", ts: Date.now(), tool, ok: r.ok, summary: r.summary, data: r.data });
			session.appendAudit({ type: "action_result", ts: Date.now(), tool, ok: r.ok, summary: r.summary, data: r.data });
		},
	});

	// Feed every agent event into telemetry (token usage, thinking, tool steps).
	agent.subscribe((event) => {
		telemetry.ingestAgentEvent(event);
	});

	// Polling must start BEFORE the decision loop: it is what discovers the
	// executor's phase transitions and fresh economy numbers, which is exactly
	// what the scheduler reacts to. Leaving it after the loop meant the loop
	// never saw a phase change and therefore never asked again.
	console.log("[agent] polling state (economy/phase)…");
	const obs = setInterval(() => {
		if (stopRequested) return;
		try {
			client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
			client?.poll(AdminUpdateType.CompanyStats, 0);
			client?.poll(AdminUpdateType.CompanyEconomy, 0);
		} catch {
			/* closed */
		}
	}, 700);

	// --- decision loop (continuous, not once) ---
	// v0.5.0 and earlier ran exactly one decision (`maxTurns ?? 1`), so the model
	// built a line and was never consulted again — income decayed with nobody
	// asked to fix it. The scheduler now keeps asking on phase changes, periodic
	// intervals and notable events until the run ends.
	// See docs/AGENT-LOOP-AND-CONTROL.md §2.1.
	onPhaseChange = (phase: string) => {
		recordPhase(tracker, phase);
		// One snapshot per construction phase: this is the "阶段性游戏画面"
		// (a data-rendered diagram, not a screenshot - see stage-view.ts).
		publishStage(phase);
		// A model-supplied wait condition matching this phase is its wake-up call.
		if (waitCondition && phase.toLowerCase().includes(waitCondition)) {
			waitCondition = null;
			scheduler.request("wait_until");
			return;
		}
		scheduler.request("phase_change");
	};
	onNotableEvent = (summary: string) => {
		recordEvent(tracker, summary);
		scheduler.request("event");
	};
	scheduler.request("start");

	const decisionTickMs = opts.decisionTickMs ?? 1_000;
	const maxDecisions = opts.maxDecisions ?? 0; // 0 = bounded only by run length
	// `seconds` bounds the RUN, and it has to be checked INSIDE the loop.
	//
	// Measured 2026-09-12: `--demo-seconds 190` ran for 28 minutes and 251
	// decisions before I killed it. The run was healthy - the limit simply did
	// not exist: the loop was `while (!stopRequested)` with no deadline, and
	// `opts.seconds` was only consulted AFTER the loop in a
	// `Promise.race([stopPromise, sleep(seconds)])`, which by then could only
	// shorten a wait that had already ended. An unbounded game length makes a
	// controlled experiment (M3: same seed, 3 runs per arm) impossible.
	const deadline = opts.seconds && opts.seconds > 0 ? Date.now() + opts.seconds * 1000 : null;
	while (!stopRequested) {
		if (deadline !== null && Date.now() >= deadline) {
			console.log(`[agent] run length reached (${opts.seconds}s) - stopping`);
			break;
		}
		const nowDay = gameDaysSinceStart(deps);
		if (waitUntil && nowDay - waitUntil.from >= waitUntil.gameDays) {
			waitUntil = null;
			scheduler.request("wait_until");
		}
		const due = scheduler.take(Date.now(), nowDay);
		if (!due) {
			await sleep(decisionTickMs);
			continue;
		}
		if (maxDecisions && scheduler.count() > maxDecisions) {
			console.log(`[agent] decision cap reached (${maxDecisions})`);
			break;
		}

		// Snapshot the window BEFORE acting, so the next decision can compare.
		const preState = summarizeState(deps.state.snapshot());
		const preSnap = deps.state.snapshot();
		telemetry.decisionPoint();
		audit.write({
			type: "decision",
			ts: Date.now(),
			turn: scheduler.count(),
			trigger: due.trigger,
			date: String(preState.date ?? "?"),
			state: preState,
		});
		session.appendAudit({ type: "decision", ts: Date.now(), turn: scheduler.count(), trigger: due.trigger, state: preState });

		const history = session.current().checkpoints.map((c) => c.note);
		// SPEC §1.1 step 2 (REVISED 2026-09-12): the framework NO LONGER pauses the
		// game around a decision.
		//
		// The original design froze the world so it could not move under the LLM.
		// In practice the freeze was ONE-WAY. `rcon("pause")` posts
		// `Commands::Pause(PM_NORMAL, true)` into the game loop; once paused that
		// loop stops draining the queue, so the matching unpause posted afterwards
		// never runs. OpenTTD's console handler documents the trap exactly:
		//
		//   if (_pause_mode.Test(PauseMode::Normal)) { Post(PM_NORMAL, false); }
		//   else if (_pause_mode.Any())
		//     "Game cannot be unpaused manually; disable
		//      pause_on_join/min_active_clients."
		//
		// MEASURED (2026-09-12): with the pause in place the game calendar advanced
		// 1 day in 120s while the GS kept sending state (3200 script ticks) - i.e.
		// scripts ran while the world stood still, the signature of a paused game.
		// With the pause removed the calendar advanced 13.5 days per 1000 ticks and
		// the executor went boot -> work -> stA_ok -> road_start.
		//
		// Every "executor is stuck at boot" / "no heartbeat" / "GS not ticking"
		// symptom we chased for days was this one call.
		//
		// What protects decision quality instead: the observation is taken BEFORE
		// the model is asked, and `sinceLastDecision` reports everything that
		// changed while it thought (money/income/vehicles/phases/actions). The model
		// is told the truth about a world that kept moving, rather than a
		// comforting lie about one that never did.
		let plan: DecisionPlan | null = null;
		{
			const out = await runDecision(agent, deps, {
				trigger: due.trigger,
				tracker,
				gameDay: gameDaysSinceStart(deps),
				history,
				...(executorPhase ? { phase: executorPhase } : {}),
			});
			plan = out.plan;
			telemetry.onActivity?.();
		}

		// SPEC §4.2 step 5: honour the model's own wake-up ("或等待条件满足").
		// The framework only parses it; the content is the model's call.
		if (plan && plan.wait_until) {
			const w = plan.wait_until;
			const days = Number(w.game_days);
			if (Number.isFinite(days) && days > 0) {
				waitUntil = { gameDays: days, from: gameDaysSinceStart(deps) };
			} else if (typeof w.condition === "string" && w.condition.trim()) {
				// A textual condition is matched against the next phase change.
				waitCondition = w.condition.trim().toLowerCase();
			}
		}
		publishStage(plan && plan.goal ? plan.goal : undefined);
		if (plan && plan.goal) {
			audit.write({ type: "note", ts: Date.now(), message: `plan: ${plan.goal}`, data: { plan } });
			session.appendAudit({ type: "plan", ts: Date.now(), plan });
		}

		// Record the outcome of whatever the model asked for, then open a new
		// window so the next decision sees the effect of this one.
		for (const a of pendingActions) {
			recordAction(tracker, a);
		}
		pendingActions.length = 0;
		tracker = {
			baseline: baselineOf(preSnap, gameDaysSinceStart(deps)),
			phases: [],
			actions: [],
			notableEvents: [],
		};

		const snap = deps.state.snapshot();
		session.update({ totals: totalsFromTelemetry(session.current().totals, telemetry.snapshot(), snap.totalEvents) });
		const cp = buildStageSummary(session.current(), formatGameDate(snap.date), scheduler.count());
		session.addCheckpoint(cp);
		web?.publishCheckpoint(cp);
		console.log(`[agent] decision ${scheduler.count()} (${due.trigger}) at ${snap.date ? formatGameDate(snap.date) : "?"}`);
	}

	// The loop owns the run length now (see `deadline` above): it exits either
	// because we were asked to stop (`stopRequested`, set by requestStop) or
	// because the deadline passed. There is nothing left to wait for here.
	clearInterval(obs);

	const snap = world.snapshot();
	const c0 = snap.companies.get(0);
	console.log(
		`[agent] RESULT: constructionDone=${reachedDone} phase="${executorPhase}" vehicles=${c0?.stats?.vehicles ?? "?"} stations=${c0?.stats?.stations ?? "?"} money=${c0?.economy ? c0.economy.money.toString() : "?"}`,
	);

	// Persist the run for the sessions page (staged summary + outcome).
	const finalTelemetry = telemetry.snapshot();
	session.saveTelemetry(finalTelemetry);
	session.update({ totals: totalsFromTelemetry(session.current().totals, finalTelemetry, snap.totalEvents) });
	session.addCheckpoint(
		buildStageSummary(session.current(), formatGameDate(snap.date), Math.max(1, scheduler.count())),
	);
	console.log(
		`[agent] tokens: in=${finalTelemetry.usage.total.input} out=${finalTelemetry.usage.total.output} ` +
			`reasoning=${finalTelemetry.usage.total.reasoning} total=${finalTelemetry.usage.total.totalTokens} ` +
			`cost=$${finalTelemetry.usage.total.costTotal.toFixed(4)}`,
	);
	console.log(
		`[agent] tools: ${finalTelemetry.totals.toolCalls} calls, ${finalTelemetry.totals.toolFailures} failed`,
	);
	clearInterval(heartbeatTimer);
	process.off("uncaughtException", onCrash);
	process.off("unhandledRejection", onCrash);
	finalized = true;
	session.finalize({
		status: reachedDone ? "completed" : "aborted",
		outcome: {
			constructionDone: reachedDone,
			phase: executorPhase || undefined,
			vehicles: c0?.stats?.vehicles ?? undefined,
			stations: c0?.stats?.stations ?? undefined,
			money: c0?.economy ? c0.economy.money.toString() : undefined,
			totalEvents: snap.totalEvents,
		},
	});

	// --- reflection: close the loop (SPEC §5.1 last step) ---
	//
	// Deliberately AFTER finalize: the metrics ledger is the foundation of the
	// "with/without lessons" experiment, so it must be on disk before anything that
	// can fail. `runReflection` never throws - a network blip during reflection must
	// not cost us the game's record.
	if (finalTelemetry.totals.decisions > 0) {
		try {
			const report = await runReflection({
				complete: completeOnce,
				dataDir: cfg.dataDir,
				facts: {
					sessionId: session.id,
					seed: cfg.seed,
					summary: {
						money: c0?.economy ? Number(c0.economy.money) : 0,
						vehicleCount: c0?.stats?.vehicles ?? 0,
						stationCount: c0?.stats?.stations ?? 0,
						decisions: finalTelemetry.totals.decisions,
						toolCalls: finalTelemetry.totals.toolCalls,
						toolFailures: finalTelemetry.totals.toolFailures,
						constructionDone: reachedDone,
						durationMs: Math.max(0, Date.now() - Number(session.current().startedAt || Date.now())),
					},
					evidence: buildReflectionEvidence({
						stages: session.current().checkpoints,
						actions: pendingActions,
					}),
				},
			});
			console.log(
				report.ok
					? `[evolution] reflection: ${report.lessonsSaved} lesson(s) kept, ` +
							`${report.strategiesPromoted} strategy card(s) promoted`
					: `[evolution] reflection failed: ${report.error}`,
			);
		} catch (err) {
			// Belt and braces: runReflection already swallows failures.
			console.log(`[evolution] reflection error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	await teardown();
	return reachedDone ? 0 : 1;

	async function teardown() {
		if (stopRequested && !web) return;
		stopRequested = true;
		try {
			client?.rcon("pause");
		} catch {
			/* best-effort */
		}
		await sleep(300);
		client?.close();
		// Only tear down a server we created; a supervised one outlives this run.
	if (web && !opts.web) await web.stop();
		await mgr.stop();
	}
}
