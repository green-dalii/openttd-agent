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
import { createAgent, SYSTEM_PROMPT, DEFAULT_MAX_TOOL_CALLS_PER_DECISION } from "./runtime.js";
import { agentDecisionAgent, laneDecisionAgent } from "./decision-agent.js";
import { readGameVersion } from "../game/version.js";

/**
 * The digest shape comes from the runtime, never a hand-written copy: adding a
 * field there must reach the manifest without touching this file (D74).
 */
type PayloadDigest = () => ReturnType<HarnessRuntime["getPayloadDigest"]>;
import { assertCostCapEnforceable, resolveRunLimits } from "./run-budget.js";
import { createHarnessRuntime, harnessEnabled, HARNESS_LANE_NAME, type HarnessRuntime } from "./harness-runtime.js";
import { scaffoldHash, type FingerprintableTool } from "./scaffold-fingerprint.js";
import type { AgentOptions } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
/** pi-agent-core's StreamFn, via AgentOptions. */
type AgentOptionsStreamFn = AgentOptions["streamFn"];
import { DecisionScheduler } from "./scheduler.js";
import { buildStageView } from "./stage-view.js";
import { captureMinimap, MINIMAP_REL_PATH } from "../game/minimap.js";
import type { ActionResult, AgentDeps } from "./types.js";
import type { Models } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { DecisionAgent } from "./decision-agent.js";
import { createTools } from "./tools/index.js";
import { fauxAssistantMessage, fauxToolCall, createFauxCore } from "@earendil-works/pi-ai";
import { buildBrain, redactKey } from "./provider.js";
import { Telemetry } from "./telemetry.js";
import { selectionStores } from "./selection.js";
import {
	SessionStore,
	newSessionId,
	reconcileStaleSessions,
	sessionHooks,
} from "./session-store.js";
import { createLlmApi } from "./llm-api.js";
import { WebServer } from "../web/server.js";
import { pruningTransformContext } from "./context.js";
import {
	loadMemory,
	makeLessonProvider,
	memoryCounts,
	recallLessons,
	renderRecallHit,
	type LoadedMemory,
} from "../evolution/memory.js";
import { routeFactsProviderFor } from "../evolution/route-facts.js";
import { pastRunScores, renderScoreHistory } from "../evolution/score-history.js";
import { readMetrics } from "../evolution/store.js";
import { joinRoutesWithLedger, routeWireFacts, fleetDecomposition } from "./route-stats.js";
import { makeFreezeController } from "./freeze.js";
import { actionCatalog } from "./tools/catalog.js";
import { RouteLedger } from "./route-ledger.js";
import { makeSignalHub, type SignalHub } from "./signal-hub.js";
import { createDecisionLoop } from "./decision-loop.js";
import { runDecision } from "./loop.js";
import { runFinalizeAndReflect } from "./reflect-run.js";
import { evolutionView, setStrategyEnabled } from "../evolution/web-view.js";
import { AuditLog } from "./audit.js";
import { isLlmConfigured } from "../config.js";
import { toWireSnapshot } from "../game/wire-snapshot.js";
import { createEpisode } from "./episode.js";
import { stringifyJson } from "../util/json.js";
import { runPrebuiltScenario } from "./prebuilt.js";

/** Blueprint job id used by the prebuilt scenario (same one the v02 oracle uses). */
export const PREBUILT_JOB = 101;

export interface AgentRunOptions {
	/** Seconds to observe construction after the decision(s). 0 = until Ctrl-C. */
	seconds?: number;
	/**
	 * Episode horizon in SIMULATED game days (G1, SPEC §10.68). Preferred over
	 * `seconds`: the wall clock is only a safety cap, so the same episode length
	 * means the same amount of world regardless of machine load or pauses.
	 */
	gameDays?: number;
	/**
	 * Which runtime drives the loop.
	 *
	 * `undefined` = follow the process (`AGENT_HARNESS=1` ⇒ harness, else the
	 * plain agent). Set explicitly by the dashboard, which may only choose among
	 * the backends the process allows — the harness one stays off unless the
	 * operator enabled it (ROADMAP §3 不变量).
	 */
	backend?: "agent" | "harness";
	/**
	 * S1/G4: build a deterministic route BEFORE the measurement window opens, so
	 * the episode measures management decisions instead of construction luck.
	 * Default "freeform" keeps the historical behaviour.
	 */
	scenario?: "freeform" | "prebuilt";
	/** Wall-clock bound on the prebuilt setup (protects against a wedged game). */
	prebuiltTimeoutMs?: number;
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
		/**
		 * agent **自己**改了暂停状态（`set_pause`）。serve 用它把归因写进 supervisor
		 * （唯一写者）；没有它（CLI 单跑）时 runner 自己 publishRun。
		 */
		onAgentPause?: (paused: boolean, at: number) => void;
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
import { savegameName,
	sleep,
	formatGameDate,
		gameDaysSinceStart,
	describeBrainSelection,
	HEARTBEAT_MS, sendControlCommand } from "./runner-helpers.js";

/** Run one agent-driven session. Returns process exit code. */
export async function runAgent(cfg: Config, opts: AgentRunOptions = {}): Promise<number> {
	// When this run started: the score history (S5) must not list the current
	// run's own row as a past run.
	const runStartedAtMs = Date.now();
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
	// 握手要等到 Welcome（不是 TCP 连上就算数）：OpenTTD 自举窗口里连接会被
	// 踢/被 reset，一次失败必须重试（2026-10-07 真机事故，见 admin-client 注释）。
	await client.connectAuthed(30_000);

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
	// W2（SPEC §10.102）：**harness 自己按住世界**的时刻表，单一写者。
	//
	// 背景：agent 在 turn 22 自己 `set_pause` 后，世界冻结了一小时，而"世界不推进"
	// 当时只是页面上一句话，run 记录里没有任何事实。要判定"世界冻了"，必须先能
	// 回答"是不是我们自己按住的"——三条路径都会按住世界，全部写这里：
	//   ① agent 的 set_pause（onPauseChanged）
	//   ② 页面按钮 / serve 的 pause 钩子（opts.control.onReady）
	//   ③ freeze 模式为快照决策持有的暂停（下面的 freezeCtl）
	// 于是"日期不动且**没有人**按住它"才能被写成 worldFrozen；反之就是 W1 的
	// blockedByPause（被人为停掉的局，不是"没学会"）。
	let worldHeldSince: number | null = null;
	const markWorldHeld = (): void => {
		if (worldHeldSince === null) worldHeldSince = Date.now();
	};
	const markWorldReleased = (): void => {
		worldHeldSince = null;
	};

	const freezeCtl =
		opts.freeze === true
			? makeFreezeController({
					pause: () => {
						markWorldHeld();
						return client!.rconAwait("pause");
					},
					unpause: () => {
						markWorldReleased();
						return client!.rconAwait("unpause");
					},
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
		// agent 自己调 `set_pause` → 记录归因并推给页面（"谁让它停的"是独立事实）。
		onPauseChanged: (paused: boolean, at: number) => {
			agentPause = { paused, at };
			// W2：这也是"我们自己按住世界"的一种，必须记进同一本账。
			if (paused) markWorldHeld();
			else markWorldReleased();
			// **决策节奏必须与世界一起停**（2026-09-25 真实事故）：agent 调 `set_pause`
			// 后只发了 rcon，`scheduler` 仍在按"游戏日期推进"找触发 —— 而日期永远不再
			// 推进，于是循环空转、页面只看到"进程活着但没进展"，直到人发现。
			// 走与页面按钮**同一条**路径：scheduler.pause/resume + rcon（`reportControl`）。
			if (paused) scheduler.pause();
			else scheduler.resume(gameDaysSinceStart(deps));
			// 归因交给 supervisor（`--serve` 时它是 run 状态的**唯一写者**；
			// 这里若自己 publishRun，会被 supervisor 随后的 publish 覆盖回去，
			// 于是页面又退回"未知是谁停的"）。CLI 单跑没有 supervisor，走下面的直发。
			if (opts.control && typeof opts.control.onAgentPause === "function") {
				opts.control.onAgentPause(paused, at);
			} else {
				web?.publishRun({
					state: paused ? "paused" : "running",
					sessionId: session.id,
		// D3b/D4: the RESOLVED knobs (not the requested ones) so the manifest can
		// record what actually drove the run.
		thinkingLevel: scaffold.thinkingLevel,
		maxToolCallsPerDecision: scaffold.toolBudget,
					mode: "agent",
					pausedBy: paused ? "agent" : null,
					pausedAt: paused ? at : null,
				});
			}
		},
	};
	let streamFn: AgentOptionsStreamFn;
	let model: Model<string>;
	/**
	 * Provider registry for the harness backend (D6a). The bare-Agent path only
	 * needs `streamFn`; the harness streams through `models.streamSimple`.
	 */
	let models: Models | null = null;
	let brainKind: "real" | "faux" = "faux";
	/** Whether the model has a price table (custom endpoints: no). */
	let brainCostKnown = false;
	/** The resolved selection facts of the brain (null for the faux demo). */
	let brainFacts: { model: string; api: string; contextWindow: number } | null = null;
	const mustServeDashboard = opts.webPort !== undefined;

	// The credential store keeps dashboard-saved keys across restarts (pi-ai's
	// default store is in-memory only).
	// P4: spend caps, already validated by loadConfig (so CLI overrides and the
	// settings file are included). Resolved before the provider so a bad value
	// fails before a game starts.
	const limits = cfg.llm.limits ?? resolveRunLimits({});
	if (limits.tokens !== null || limits.cost !== null) {
		console.log(
			`[agent] limits: tokens=${limits.tokens ?? "none"} cost=${limits.cost === null ? "none" : `$${limits.cost}`}`,
		);
	}
	// The SAME stores the gate uses (credential store + persisted model overlay).
	// Two copies of this wiring is how the gate and the runner drifted apart (A5).
	const stores = selectionStores(cfg.dataDir);
	if (isLlmConfigured(cfg.llm)) {
		// Catalog = pi-ai built-in provider; custom = arbitrary OpenAI-compatible
		// endpoint (docs/DASHBOARD-API.md §6.5).
		// The overlay (models the Providers page refreshed) is restored inside the
		// resolver, so a model newer than pi-ai's bundled snapshot is runnable.
		const built = await buildBrain(cfg.llm, stores);
		streamFn = built.streamFn as unknown as AgentOptionsStreamFn;
		model = built.model;
		models = built.models;
		brainCostKnown = built.costKnown;
		brainFacts = {
			model: built.facts.model,
			api: built.facts.api,
			contextWindow: built.facts.contextWindow,
		};
		// Refuse a cost cap this model cannot measure (it would never fire).
		assertCostCapEnforceable(limits, brainCostKnown);
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
		// Same shape the faux tests use: the harness needs `streamSimple` and
		// `getModel` (the latter per checkpoint, even with compaction disabled).
		models = {
			streamSimple: faux.streamSimple,
			getModel: () => faux.getModel(),
		} as unknown as Models;
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
		costKnown: brainCostKnown,
	});
	session.saveTelemetry(telemetry.snapshot());
	// Provenance: which OpenTTD build is producing this world. Same seed on a
	// different build is a different world, and nothing else records it.
	const gameVersion = await readGameVersion(cfg.openttdBinary);
	console.log(`[agent] game: OpenTTD ${gameVersion ?? "(version unknown)"}`);
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
	// 最近一次由 **agent 自己** 发起的暂停/恢复（页面据此区分"agent 停的"与"人按的"）。
	let agentPause: { paused: boolean; at: number } | null = null;
	const wired = {
		version: APP_VERSION,
		getSnapshot: () => ({
			...(toWireSnapshot(_world, {
				// 线路事实：GS 读数（车辆/等待/利润）× 账本（两端城镇）。
				// 仪表盘此前**完全没有**线路信息——数据一直存在，只是没被发出去。
				routes: routeWireFacts(hub.getRouteStats(), routeLedger.all()),
				routesAvailable: true,
				// P1-3：FLEET 分解（在途/在库/差额具名）——服务端算，页面只渲染。
				// 恒等式 owned + unattributed === companyTotal（route-stats.ts）。
				fleet: fleetDecomposition(
					hub.getRouteStats(),
					_world.snapshot().companies.get(0)?.stats?.vehicles ?? null,
				),
				townsAvailable: true,
				industryAvailable: true,
				companyCargoAvailable: true,
			}) as Record<string, unknown>),
			telemetry: telemetry.snapshot(),
			sessionId: session.id,
			// 暂停归因（谁让它停的）：只有 agent 侧才有这条信息；页面按钮走 supervisor。
			control: agentPause ? { pausedByAgent: agentPause.paused, agentPausedAt: agentPause.at } : null,
		// 执行器异常的**完整**文本（2026-09-25）。公司名上限 31 字符，所以生产端分块、
		// hub 拼回（`getExecutorError`）后才发到页面；null = 这一局没有报告过异常。
		// 页面此前只能显示 24 字符的截断串，"为什么卡住"当场不可诊断。
		executorError: hub.getExecutorError(),
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
					// 实测读数取代了旧的 do/dont：面板要能显示"依据的数字"，
					// 否则用户无法判断这条经验可不可信（R2）。
					outcome: l.outcome,
					confidence: l.confidence,
					evidence: l.evidence,
				})),
				strategies: runMemory.strategies.map((c) => ({ action: c.action, params: c.params })),
			},
		}),
		telemetry: () => telemetry.snapshot(),
		// Static action surface for the dashboard (AB-1). Same shape across
		// supervised and unsupervised runs — see docs/DASHBOARD-API.md §3.6.
		capabilities: () => actionCatalog(),
		// The session hooks come from ONE construction (session-store.ts): the
		// runner's `attach()` **replaces** the server's hooks with these, so a
		// hook that only the server had would vanish from the page the moment a
		// run started (the causal timeline did exactly that).
		sessions: sessionHooks(cfg.dataDir),
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
	/**
	 * 发送暂停/恢复并**记录投递结果**（不再是 fire-and-forget）。
	 *
	 * 为什么（2026-09-23）：旧实现是 `try { client?.rcon("pause") } catch {}`——
	 * 不 await 的异步失败永远进不了 catch（空 catch 是假的），且结果无人记录，
	 * 于是页面可以声称"已暂停"而世界仍在跑。投递与效果必须分开陈述。
	 */
	const reportControl = (cmd: "pause" | "unpause") => {
		void sendControlCommand(client, cmd).then((r) => {
			const how = r.delivered ? (r.reply === "" ? "delivered (no console output — normal)" : `delivered: ${r.reply}`) : `NOT CONFIRMED: ${r.error}`;
			console.log(`[agent] rcon ${cmd} → ${how}`);
		});
	};

	opts.control?.onReady?.({
		stop: requestStop,
		pause: () => {
			// W2：页面按钮与 supervisor.pause("agent") 都走这里（同一funnel），
			// 所以这一处就能覆盖 serve 模式下**所有**人为暂停的来源。
			markWorldHeld();
			scheduler.pause();
			reportControl("pause");
		},
		resume: () => {
			markWorldReleased();
			scheduler.resume(gameDaysSinceStart(deps));
			reportControl("unpause");
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
	// M4a（SPEC §10.89）：把**这一局的记忆快照**接到 `recall` 工具上。
	//
	// 两条硬要求：
	//   ① 与开局注入的是**同一份快照**（计数一致，"我读到的"与"我被告知的"不能是两回事）；
	//   ② `--no-memory` 时必须**缺席**（工具据此具名拒绝）——否则控制臂会"有记忆但不注入"，
	//      两臂之差就不再干净（D4：每个注入通道都要被开关控制并在判据里披露）。
	if (opts.injectMemory !== false) {
		deps.recall = (q) => recallLessons(memory, q).map((l) => ({ id: l.id, line: renderRecallHit(l) }));
	}
	deps.onRecall = (r) =>
		session.appendAudit({ type: "recall", ts: Date.now(), query: r.query, hits: r.hits, ids: r.ids });
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

	// D3a/S4: which of the agent's own actions ordered which job. It must
	// outlive a decision window (construction spans many decisions), so it
	// lives at run level, not in the per-window tracker.
	const jobActions: Record<number, string> = {};
	// D4/S6: the knobs actually applied to this run (validated at config load;
	// defaults keep the historical behaviour).
	const scaffold = cfg.llm.scaffold ?? { thinkingLevel: "off" as const, toolBudget: DEFAULT_MAX_TOOL_CALLS_PER_DECISION };

	/**
	 * One handler for tool results, shared by both brain paths (D6a). Two copies
	 * would let the audit trail diverge between them — and the audit trail is
	 * what the run is judged on.
	 */
	const handleActionResult = (tool: string, r: ActionResult): void => {
		console.log(`[agent] tool ${tool}: ok=${r.ok} ${r.summary}`);
		// Failures are recorded too: the model must be able to see its own
		// mistakes on the next decision (docs/AGENT-LOOP-AND-CONTROL §2.4).
		// D3a/S4: carry the ordered job id with the action, so the executor
		// phases that follow can be joined back to the action that caused
		// them (credit assignment needs that link).
		const job = typeof (r.data as { job?: unknown } | undefined)?.job === "number"
			? Number((r.data as { job: number }).job)
			: undefined;
		if (job !== undefined) jobActions[job] = tool;
		pendingActions.push({ tool, ok: r.ok, summary: r.summary, ...(job !== undefined ? { job } : {}) });
		audit.write({ type: "action_result", ts: Date.now(), tool, ok: r.ok, summary: r.summary, data: r.data });
		session.appendAudit({ type: "action_result", ts: Date.now(), tool, ok: r.ok, summary: r.summary, data: r.data });
	};

	// Context hygiene + cross-game lesson injection (SPEC §4.1).
	// Built ONCE so both brain paths inject the identical set: a second copy of
	// these options would be a silent scaffold difference (D6a).
	//
	// `lessonsProvider` existed as an unfed hook since v0.2.1: every game ran in
	// complete isolation because nothing ever supplied it. Loading the memory once
	// here (rather than per LLM call) keeps the injected set stable for the whole
	// run, and `setMemoryInjected` records what was ACTUALLY injected - that count
	// is the independent variable of the M3 "with/without lessons" experiment.
	const transformContext = pruningTransformContext({
		keepRecent: 40,
		// C-1: route facts from PREVIOUS games join the injected context
		// (snapshot taken once at boot - same stable-set semantics as memory,
		// which is the M3 experiment's independent variable).
		// 存在性事实（ADR §10.74 决策 4）：注入的是"选中的那几条"，而库里可能还有更多。
		// 不说出来，模型就不知道自己还能查——`recall` 会永远不被调用，
		// 而"记忆有没有被用"这个问题就永远没有答案（SPEC §10.89）。
		lessonsProvider: () => [
			...memoryProvider(),
			...routeFactsProvider(),
			...(memory.lessons.length > injected.lessonsInjected
				? [
						`${memory.lessons.length - injected.lessonsInjected} more recorded observation(s) from ` +
							"earlier games are not shown here and can be listed or searched with recall().",
					]
				: []),
		],
		// S5: the agent's own measured scores in earlier comparable games.
		// Facts (numbers + the conditions they were measured under), never a
		// verdict. OFF in the control arm like every other cross-game memory:
		// `--no-memory` must mean "no memory at all", or the A/B is void.
		scoreHistoryProvider: () => {
			if (opts.injectMemory === false) return null;
			const history = pastRunScores(readMetrics(cfg.dataDir), {
				scenario: opts.scenario === "prebuilt" ? "prebuilt" : "freeform",
				horizonDays: opts.gameDays ?? null,
				sinceMs: runStartedAtMs,
				limit: 10,
			});
			const text = renderScoreHistory(history);
			if (text) console.log(`[agent] score history injected (${history.runs.length} comparable run(s))`);
		return text;
	},
});

	// --- brain backend (D6a) ---
	// Two interchangeable backends, same scaffold:
	//   - "agent": bare pi-agent-core Agent (historical path, default)
	//   - "harness": AgentHarness + a durable, replayable session transcript
	// The flag exists so the migration is reversible by configuration, not by a
	// revert: docs/HARNESS-MIGRATION.md §4.
	//
	// `opts.backend` is the **per-run** choice (the dashboard's knob); without
	// it the process decides (`AGENT_HARNESS=1`). The page may only choose
	// among the backends the process allows, so this cannot turn the harness on
	// behind the operator's back (ROADMAP §3 不变量: harness 默认关).
	const backend = opts.backend ?? (harnessEnabled(process.env) ? "harness" : "agent");
	let tools: AgentTool[];
	let decisionAgent: DecisionAgent;
	let getBudgetBlocks: () => number;
	/** Harness only (D6b): real payload fingerprint + request count. */
	// Typed from the harness runtime itself: a hand-written copy here would be the
	// "second projection" trap (D74) one layer up - add a digest field there and
	// this annotation would silently drop it.
	let getPayloadDigest: PayloadDigest | null = null;
	let closeBrain: (() => Promise<void>) | null = null;

	tools = createTools(deps);

	if (backend === "harness") {
		const hr = await createHarnessRuntime({
			dataDir: cfg.dataDir,
			sessionId: session.id,
			models: models as Models,
			model,
			systemPrompt: SYSTEM_PROMPT,
			tools,
			maxToolCallsPerDecision: scaffold.toolBudget,
			thinkingLevel: scaffold.thinkingLevel,
			transformContext,
			onActionResult: handleActionResult,
			onEvent: (event: unknown) => telemetry.ingestAgentEvent(event as never),
		});
		decisionAgent = laneDecisionAgent(hr.lane, hr.context);
		getBudgetBlocks = hr.getBudgetBlocks;
		getPayloadDigest = hr.getPayloadDigest;
		closeBrain = hr.close;
		console.log(`[agent] brain backend: harness (lane=${HARNESS_LANE_NAME} session=${session.id})`);
	} else {
		const runtime = createAgent({
			deps,
			streamFn,
			model,
			// Provider prompt cache key (ADR §10.74): stable for the whole run, so a
			// cache-aware provider can reuse the system prompt + tool schemas that are
			// re-sent on every one of the run's decisions.
			sessionId: session.id,
			transformContext,
			onActionResult: handleActionResult,
			maxToolCallsPerDecision: scaffold.toolBudget,
			thinkingLevel: scaffold.thinkingLevel,
		});
		tools = runtime.tools;
		decisionAgent = agentDecisionAgent(runtime.agent);
		getBudgetBlocks = runtime.getBudgetBlocks;
		console.log(`[agent] brain backend: agent (session=${session.id})`);

		// Feed every agent event into telemetry (token usage, thinking, tool steps).
		runtime.agent.subscribe((event) => {
			telemetry.ingestAgentEvent(event);
		});
	}
	// D3b/S9: the scaffold fingerprint - the prompt and the tool set that are
	// actually sent to the model. Two runs with the same fingerprint saw the
	// same scaffold; without it a benchmark cannot claim that.
	const fingerprint = scaffoldHash(SYSTEM_PROMPT, tools as unknown as FingerprintableTool[]);
	console.log(`[agent] scaffold: thinking=${scaffold.thinkingLevel} toolBudget=${scaffold.toolBudget} hash=${fingerprint}`);

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
	// The episode clock starts when the decision loop does, so "same episode" means
	// "same simulated opportunity" (SPEC §10.68).
	// ONE clock for the episode, the decision loop and the metric (D19: a contract
	// that is not wired into the execution path is not a contract). The GS raw date
	// (~3 game days) beats the admin Date subscription (monthly, 30 game days).
	const gameDayNow = (): number => hub.getGameDay() ?? gameDaysSinceStart(deps);

	// S1/G4: with the prebuilt scenario the measurement window opens only once the
	// route can carry cargo, so every run measures the SAME kind of opportunity
	// (management) instead of "how much of the window construction left over".
	const scenario: "freeform" | "prebuilt" = opts.scenario === "prebuilt" ? "prebuilt" : "freeform";
	let prebuiltReason: string | null = null;
	let deliveredAtReady: number | null = null;
	/** S1: the game day the measurement window opened (prebuilt only). */
	let prebuiltWindowDay: number | null = null;
	if (scenario === "prebuilt") {
		const r = await runPrebuiltScenario(
			{
				sendOrder: () => {
					try {
						client.gameScript(stringifyJson({ cmd: "build_bus_route", company: 0, job: PREBUILT_JOB }));
						return true;
					} catch {
						return false;
					}
				},
				snapshot: () => {
					const c = deps.state.snapshot().companies.get(0);
					return { stations: c?.stats?.stations ?? 0, vehicles: c?.stats?.vehicles ?? 0 };
				},
				sleep: (ms) => sleep(ms),
				now: () => Date.now(),
				log: (l) => console.log(l),
			},
			{ timeoutMs: opts.prebuiltTimeoutMs ?? 20 * 60_000 },
		);
		prebuiltReason = r.reason;
		if (r.ready) {
			const c = deps.state.snapshot().companies.get(0);
			deliveredAtReady = c?.deliveredRun?.total ?? null;
			// The day the window opened: the model is told when the scored part of
			// the run began, so a pre-window zero is not read as "delivering
			// nothing" (S1).
			prebuiltWindowDay = gameDayNow();
		} else {
			// Honest refusal: the scenario is NOT set up, so this run cannot measure
			// management decisions. It keeps running (useful to debug) but the metric
			// marks it and the verdict excludes it.
			console.error(`[agent] prebuilt scenario NOT ready (${r.reason}) - run marked invalid`);
		}
	}

	const episode = createEpisode({
		horizonDays: opts.gameDays ?? null,
		capMs: opts.seconds && opts.seconds > 0 ? opts.seconds * 1000 : null,
		startedAtMs: Date.now(),
		startGameDay: gameDayNow(),
	});

	const loop = createDecisionLoop({
		deps,
		agent: decisionAgent,
		scheduler,
		hub,
		telemetry,
		audit,
		session,
		getWeb: () => web,
		pendingActions,
		opts: {
			decisionTickMs: opts.decisionTickMs,
			maxDecisions: opts.maxDecisions,
			seconds: opts.seconds,
			episode: episode ?? undefined,
			limits,
			costKnown: brainCostKnown,
		},
		isStopRequested: () => stopRequested,
		requestStop: () => {
			stopRequested = true;
		},
		// Verified freeze: acquire before the model thinks, release in a finally
		// (plus the controller's own watchdog). Uses rconAwait so a pause that was
		// never acknowledged is reported instead of assumed.
		freeze: freezeCtl,
		// S1: the measurement window. In freeform the whole run is the window
		// (scoredFromGameDay = null); in the prebuilt scenario the window opens
		// when the route can actually carry cargo, and until then the run's
		// deliveries are setup, not performance.
		// D3a/S4: which command ordered which job (from the GS acks).
		routeActions: () =>
			routeLedger.all().flatMap((l) => (l.order.command ? [{ job: l.order.job, command: l.order.command }] : [])),
		measurementWindow: () => ({
			scoredFromGameDay: scenario === "prebuilt" ? prebuiltWindowDay : null,
			windowOpened: scenario === "prebuilt" ? prebuiltWindowDay !== null : true,
		}),
		// N2-2b: the economics the GS reports are keyed by job; the ledger knows
		// which towns that job was ordered for. Joining them here is what lets the
		// model read "route 101 (9->12): 6 vehicles, 146 waiting, -308 profit".
		executorFact: () => {
			const p = hub.getExecutorProgress();
			// Absence stays absent: before the first `rd` phase there is nothing to
			// report, and inventing zeros would read as "the road is finished".
			if (p.job === null || p.job < 0) return undefined;
			return {
				job: p.job,
				remainingTiles: p.remainingTiles,
				tilesPerDay: p.tilesPerDay,
				etaDays: p.etaDays,
				stalledDays: p.stalledDays,
				jobsSeen: p.jobsSeen,
			};
		},
		routesForContext: () => joinRoutesWithLedger(hub.getRouteStats(), routeLedger.all()),
		publishStage,
		runDecision: (agent, deps, o) => runDecision(agent, deps, o),
		now: () => Date.now(),
		gameDay: gameDayNow,
	});
	onPhaseChange = (phase: string) => loop.handlePhase(phase);
	onNotableEvent = (summary: string) => loop.handleNotable(summary);
	scheduler.request("start");

	await loop.run();

	// D6b: the payload fingerprint is only meaningful after at least one request
	// left, so it is reported at the end (and recorded in the manifest).
	if (getPayloadDigest) {
		const d = getPayloadDigest();
		// Two fingerprints on purpose: `hash` proves "this exact request", `shape`
		// proves "the same question apart from the world's numbers" - the only one
		// that can match across seeds.
		console.log(
			`[agent] payload: hash=${d.payloadHash ?? "(none)"} shape=${d.payloadShapeHash ?? "(none)"} ` +
				`requests=${d.payloadCount}`,
		);
	}

	// D6a: flush the harness transcript and release the session. Done after the
	// loop (no more decisions) and before finalize so the on-disk transcript is
	// complete when the metric row is written.
	if (closeBrain) await closeBrain();

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
		gsErrors: hub.getGsErrors(),
		toolBudgetBlocks: getBudgetBlocks(),
		// 局是在**暂停中**结束的吗（agent 自己按的）？这是 outcome 的独立事实，
		// 让统计能把这局从"完成/中止"里剔除（SPEC §10.101）。
		agentPause,
		// W2：世界时钟有多久没动 + harness 是不是正按着它。两个事实一起才能
		// 区分"世界被冻"与"我们让它停"（SPEC §10.102）。
		worldFrozen: {
			frozenForMs: hub.getWorldClock().frozenForMs,
			harnessHeld: worldHeldSince !== null,
		},
		scenario,
		scenarioReason: prebuiltReason,
		gameVersion,
		manifest: {
			backend,
			thinkingLevel: scaffold.thinkingLevel,
			toolBudget: scaffold.toolBudget,
			scaffoldHash: fingerprint,
			// The model the run ASKED for, and the facts of that model (its api
			// and context window) — resolved by the same resolver the next-run
			// preview uses, so the two agree field by field. `servedModel` (what
			// the provider answered with) is added by reflect-run from telemetry.
			model: brainFacts?.model ?? null,
			api: brainFacts?.api ?? null,
			contextWindow: brainFacts?.contextWindow ?? null,
			costKnown: brainFacts ? brainCostKnown : null,
			// P4: the cap that may have ended this run belongs to its identity.
			tokenLimit: limits.tokens,
			costLimit: limits.cost,
			// D6b: only the harness can report the payload it actually sent. Absent
			// on the bare path - a number derived from our own source would be a
			// claim, and a null here is the honest "not measured".
			...(getPayloadDigest ? getPayloadDigest() : {}),
		},
		deliveredAtReady,
		episode: {
			...episode.check({ gameDay: gameDayNow(), nowMs: Date.now() }),
			horizonDays: episode.plan.horizonDays,
		},
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
		// R2b: 反思也用 pi-agent-core 的 Agent（工具契约 + 拒绝回到模型），
		// 因此它需要 provider 与模型，而不是一个"文本补全"回调。
		reflectLlm: { streamFn, model },
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
