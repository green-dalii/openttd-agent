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
import { WorldState } from "../game/world-state.js";
import { AdminClient } from "../game/admin-client.js";
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
import { DecisionScheduler } from "./scheduler.js";
import { buildStageView } from "./stage-view.js";
import { captureMinimap, MINIMAP_REL_PATH } from "../game/minimap.js";
import type { AgentDeps } from "./types.js";
import { fauxAssistantMessage, fauxToolCall, createFauxCore } from "@earendil-works/pi-ai";
import { buildBrain, redactKey } from "./provider.js";
import { Telemetry } from "./telemetry.js";
import { FileCredentialStore } from "./file-credential-store.js";
import {
	SessionStore,
	listSessions,
	newSessionId,
	readSession,
	readStageFile,
	reconcileStaleSessions,
} from "./session-store.js";
import { createLlmApi } from "./llm-api.js";
import { WebServer } from "../web/server.js";
import { pruningTransformContext } from "./context.js";
import { loadMemory, makeLessonProvider, memoryCounts, type LoadedMemory } from "../evolution/memory.js";
import { routeFactsProviderFor } from "../evolution/route-facts.js";
import { joinRoutesWithLedger } from "./route-stats.js";
import { makeFreezeController } from "./freeze.js";
import { RouteLedger } from "./route-ledger.js";
import { makeSignalHub, type SignalHub } from "./signal-hub.js";
import { createDecisionLoop } from "./decision-loop.js";
import { runDecision } from "./loop.js";
import { runFinalizeAndReflect } from "./reflect-run.js";
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
	 * Pause the world while the model thinks and acts (SPEC §10.59).
	 * Default false: frozen runs trade wall-clock for a snapshot the model can
	 * trust, which is an experiment variable, not an obvious default.
	 */
	freeze?: boolean;
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

// Pure helpers moved to ./runner-helpers.ts (REFACTOR Phase B-1).
import {
	savegameName,
	sleep,
	formatGameDate,
		gameDaysSinceStart,
	describeBrainSelection,
	HEARTBEAT_MS,
} from "./runner-helpers.js";

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
	const _world = new WorldState();
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

	// Decision cadence + the causality window handed to the model. The framework
	// owns *when* to ask; the LLM owns *what* to do (docs/AGENT-LOOP-AND-CONTROL §1).
	const scheduler = new DecisionScheduler({
		minGapMs: opts.decisionMinGapMs ?? 5_000,
		intervalGameDays: opts.decisionIntervalDays ?? 90,
	});
	// Decision->outcome ledger: which decision ordered which route, and what was
	// observed afterwards. Reflection used to receive only outcome summaries and
	// could only write vacuous lessons (SPEC §10.34) - it had no per-choice facts.
	const routeLedger = new RouteLedger();

	// Signal hub owns: world ingest routing, exec phase / stage state, build ack
	// recording, fleet/station notable detection, and boot-event buffering
	// (REFACTOR Phase B-3). It is created BEFORE `new AdminClient` because the
	// callback fires during boot, and lazy refs (getWeb/getSession) are
	// intentionally null until later in the run.
	const hub: SignalHub = makeSignalHub({
		world: _world,
		getWeb: () => web,
		getSession: () => sessionRef,
		routeLedger,
		getDecisionCount: () => scheduler.count(),
		onPhaseChange: (phase) => onPhaseChange?.(phase),
		onNotableEvent: (summary) => onNotableEvent?.(summary),
	});
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
	client = new AdminClient({
		cfg,
		callbacks: {
			onEvent: hub.onEvent,
			onStatusChange: (s, d) => {
				if (s === "error") console.error(`[agent] admin error: ${d ?? s}`);
			},
		},
	});
	await client.connect(10_000);

	const gsDeadline = Date.now() + 20_000;
	while (hub.getGsCount() === 0 && Date.now() < gsDeadline && !stopRequested) await sleep(250);
	if (hub.getGsCount() === 0) {
		console.error("[agent] ERROR: BridgeV1 GS never heartbeated.");
		await teardown();
		return 1;
	}
	console.log("[agent] GS alive. starting executor…");
	client.rcon(`start_ai "${EXECUTOR_AI_NAME}"`);

	// wait for the executor company to appear (boot phase)
	const bootDeadline = Date.now() + 20_000;
	while (hub.getStage() !== "boot" && Date.now() < bootDeadline && !stopRequested) {
		client.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		await sleep(500);
	}
	console.log(`[agent] executor booted (phase="${hub.getPhase()}")`);

	// --- assemble the brain ---
	// Real provider when configured (LLM_BASE_URL/LLM_MODEL, or dashboard/CLI);
	// otherwise the offline faux provider (scripted) so the wiring is still
	// demonstrable without a key. faux is NOT a real LLM — it cannot validate
	// decision quality, only the command plumbing.
	// Verified freeze controller (only when asked for). Defined before the loop and
	// reused at finalize so the run record can PROVE the freeze really happened.
	const freezeCtl =
		opts.freeze === true
			? makeFreezeController({
					pause: () => client!.rconAwait("pause"),
					unpause: () => client!.rconAwait("unpause"),
					now: () => Date.now(),
					log: (m) => console.log(m),
				})
			: undefined;

	// `routeStats` is what makes `inspect_route` possible (N2-2): the hub keeps the
	// newest reading per route, the tool reads it on demand. Wiring it here (not in
	// the tool) keeps the tool unit-testable with a fake.
	const deps: AgentDeps = {
		sink: client,
		state: _world,
		routeStats: () => hub.getRouteStats(),
	};
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
	hub.replayBootEvents(session);
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
			...(toWireSnapshot(_world) as Record<string, unknown>),
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
			route: hub.getLastRoute(),
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
	// Gated by the same switch as lessons: `--no-memory` must mean NO memory
	// of either kind, or the control arm is not a control (m3f).
	const routeFactsProvider = routeFactsProviderFor(cfg.dataDir, opts.injectMemory !== false);
	const injected = memoryCounts(memory);
	// Publish it for the dashboard (per-game truth: what THIS game was told).
	runMemory = memory;
	// C-1: the route-facts snapshot counts toward the injected-memory total so
	// the A/B arm split (compareArms) classifies facts-only runs as treatment.
	// The m3e run mis-split them as controls (injected-but-unaccounted).
	injected.routeFactsInjected = routeFactsProvider().length;
	session.setMemoryInjected(injected);
	if (injected.lessonsInjected || injected.strategiesInjected || injected.routeFactsInjected) {
		console.log(
			`[evolution] loaded memory: ${injected.lessonsInjected} lesson(s), ` +
				`${injected.strategiesInjected} strategy card(s), ` +
				`${injected.routeFactsInjected} route fact(s)`,
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
			// C-1: route facts from PREVIOUS games join the injected context
			// (snapshot taken once at boot - same stable-set semantics as memory,
			// which is the M3 experiment's independent variable).
			lessonsProvider: () => [...memoryProvider(), ...routeFactsProvider()],
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
	// See docs/AGENT-LOOP-AND-COMTROL.md §2.1; implementation: decision-loop.ts
	// (REFACTOR Phase B-4b — the while body moved there 1:1).
	const loop = createDecisionLoop({
		deps,
		agent,
		scheduler,
		hub,
		telemetry,
		audit,
		session,
		getWeb: () => web,
		pendingActions,
		opts: { decisionTickMs: opts.decisionTickMs, maxDecisions: opts.maxDecisions, seconds: opts.seconds },
		isStopRequested: () => stopRequested,
		// Verified freeze: acquire before the model thinks, release in a finally
		// (plus the controller's own watchdog). Uses rconAwait so a pause that was
		// never acknowledged is reported instead of assumed.
		freeze: freezeCtl,
		// N2-2b: the economics the GS reports are keyed by job; the ledger knows
		// which towns that job was ordered for. Joining them here is what lets the
		// model read "route 101 (9->12): 6 vehicles, 146 waiting, -308 profit".
		routesForContext: () => joinRoutesWithLedger(hub.getRouteStats(), routeLedger.all()),
		publishStage,
		runDecision: (agent, deps, o) => runDecision(agent, deps, o),
		now: () => Date.now(),
		gameDay: () => gameDaysSinceStart(deps),
	});
	onPhaseChange = (phase: string) => loop.handlePhase(phase);
	onNotableEvent = (summary: string) => loop.handleNotable(summary);
	scheduler.request("start");

	await loop.run();

	clearInterval(obs);
	clearInterval(heartbeatTimer);
	process.off("uncaughtException", onCrash);
	process.off("unhandledRejection", onCrash);
	finalized = true;
	// Proof that the freeze (if requested) really happened: an A/B comparing frozen
	// decisions is meaningless unless the runs can show how often the pause was
	// acknowledged. Printed on the normal path, which is where it matters.
	if (freezeCtl) {
		const f = freezeCtl.stats();
		console.log(
			`[agent] freeze: ${f.acquisitions} confirmed pause(s), ${f.acquireUnconfirmed} unconfirmed, ` +
				`${f.unpauseFailures} unpause failure(s), ${f.watchdogTrips} watchdog trip(s), ` +
				`max hold ${f.maxHoldMs}ms`,
		);
	}

	const exitCode = await runFinalizeAndReflect({
		cfg, world: _world, session, telemetry,
		executorPhase: hub.getPhase(), reachedDone: hub.getReachedDone(), scheduler, pendingActions, routeLedger,
		getRouteStats: () => hub.getRouteStats(),
		// The arm is ASSIGNED here (--no-memory = control), never inferred later
		// from how much memory happened to be injected (N2-5 defect).
		arm: opts.injectMemory === false ? "control" : "treatment",
		freezeStats: (() => {
			if (!freezeCtl) return null;
			const f = freezeCtl.stats();
			return {
				confirmed: f.acquisitions,
				unconfirmed: f.acquireUnconfirmed,
				failures: f.unpauseFailures,
				watchdogTrips: f.watchdogTrips,
				maxHoldMs: f.maxHoldMs,
			};
		})(),
		completeOnce,
	});

	await teardown();
	return exitCode;

	async function teardown() {
		if (stopRequested && !web) return;
		stopRequested = true;
		try {
			client?.rcon("pause");
		} catch {
			/* best-effort */
		}
		// Save the finished game so a human can load it in the OpenTTD client and
		// watch what the agent did (owner request, 2026-09-16). This runs AFTER
		// runFinalizeAndReflect wrote the metrics, so it cannot change the numbers;
		// the wait gives the server a tick to actually write the file before stop.
		try {
			client?.rcon(`save ${savegameName(session.id)}`);
			await sleep(2500);
		} catch {
			/* best-effort: a missing save must not break teardown */
		}
		await sleep(300);
		client?.close();
		// Only tear down a server we created; a supervised one outlives this run.
	if (web && !opts.web) await web.stop();
		await mgr.stop();
	}
}
