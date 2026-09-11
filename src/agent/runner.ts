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
import { AdminClient } from "../game/admin-client.js";
import { WorldState } from "../game/world-state.js";
import path from "node:path";
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
import { runDecision } from "./loop.js";
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
} from "./session-store.js";
import type { SessionTotals } from "./session-store.js";
import { createLlmApi } from "./llm-api.js";
import { WebServer } from "../web/server.js";
import { pruningTransformContext } from "./context.js";
import { AuditLog } from "./audit.js";
import { isLlmConfigured } from "../config.js";

export interface AgentRunOptions {
	/** Seconds to observe construction after the decision(s). 0 = until Ctrl-C. */
	seconds?: number;
	/** Scripted plan for the faux provider: towns to build between. */
	planTowns?: { from?: number; to?: number };
	/** Max decision turns to run (default 1). */
	maxTurns?: number;
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

/** Human-readable description of the selected brain (never includes the key). */
function describeBrainSelection(cfg: Config): string {
	const src = cfg.llm.source === "catalog" ? "catalog" : cfg.llm.baseUrl ? "custom" : "catalog";
	const where = src === "custom" ? `base=${cfg.llm.baseUrl}` : `provider=${cfg.llm.providerId}`;
	return `${where} model=${cfg.llm.model} api=${cfg.llm.api}`;
}

/** Snapshot of the game world for the dashboard (companies are Maps). */
function toWireSnapshot(world: WorldState): unknown {
	const snap = world.snapshot();
	const companies: Record<string, unknown> = {};
	for (const [id, cs] of snap.companies) {
		companies[String(id)] = { info: cs.info, economy: cs.economy, stats: cs.stats };
	}
	return {
		date: snap.date,
		companies,
		totalEvents: snap.totalEvents,
		recent: snap.recent.slice(-100),
	};
}

/** Run one agent-driven session. Returns process exit code. */
export async function runAgent(cfg: Config, opts: AgentRunOptions = {}): Promise<number> {
	const mgr = new OpenTTDProcessManager(cfg);
	const world = new WorldState();
	let client: AdminClient | null = null;
	let stopRequested = false;
	let resolveStop: (() => void) | null = null;
	const requestStop = () => {
		if (stopRequested) return;
		stopRequested = true;
		resolveStop?.();
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
	// The executor's periodic bus dump overwrites the company name, so the
	// LAST phase is not the terminal one. Track "reached done" separately.
	let reachedDone = false;
	client = new AdminClient({
		cfg,
		callbacks: {
			onEvent: (ev) => {
				world.ingest(ev);
				if (ev.kind === "gamescript") {
					const p = ev.payload as Record<string, unknown>;
					if (p.cmd === "state") gsStates++;
					else console.log(`[agent] GS: ${JSON.stringify(p)}`);
				}
				if (ev.kind === "company_info") {
					const p = ev.payload as { id: number; name: string; isAi: boolean };
					if (p.isAi && p.name.startsWith("EX ") && p.name !== executorPhase) {
						executorPhase = p.name;
						if (p.name.startsWith("EX done")) reachedDone = true;
						console.log(`[agent] executor phase -> "${p.name}"`);
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
	} else if (mustServeDashboard) {
		// Dashboard needs a model to render telemetry against; the faux provider
		// keeps the UI demonstrable offline (it is NOT a real LLM).
		const fauxForUi = createFauxCore({});
		fauxForUi.setResponses([fauxAssistantMessage("No LLM configured yet — configure a provider in the dashboard.")]);
		streamFn = fauxForUi.streamSimple as unknown as AgentOptionsStreamFn;
		model = fauxForUi.getModel() as unknown as Model<string>;
		console.log("[agent] brain: FAUX provider (dashboard only — configure a provider in the Providers page)");
	} else {
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
		console.log("[agent] brain: FAUX provider (offline demo — no real LLM configured)");
	}
	// Audit trail (SPEC §7): decisions + action results -> JSONL under dataDir.
	const audit = new AuditLog(cfg.dataDir, "agent-audit.jsonl");
	audit.write({ type: "note", ts: Date.now(), message: "agent session start" });
	console.log(`[agent] audit: ${audit.path()}`);

	// Session record + telemetry (dashboard: sessions page, token accounting).
	const session = new SessionStore(cfg.dataDir);
	session.create({
		id: newSessionId(cfg.seed),
		mode: "agent",
		status: "running",
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

	// --- dashboard (same shape as watch mode; docs/DASHBOARD-API.md §3) ---
	let web: WebServer | null = null;
	if (mustServeDashboard) {
		const llmApi = createLlmApi({ dataDir: cfg.dataDir, cfg, envLlm: cfg.llm });
		web = new WebServer({
			host: "127.0.0.1",
			port: opts.webPort ?? 0,
			getSnapshot: () => ({
				...(toWireSnapshot(world) as Record<string, unknown>),
				telemetry: telemetry.snapshot(),
				sessionId: session.id,
				// Backlog for late subscribers / reloads (docs/DASHBOARD-UI.md §7).
				checkpoints: session.current().checkpoints,
			}),
			llm: llmApi.llm,
			catalog: llmApi.catalog,
			telemetry: () => telemetry.snapshot(),
			sessions: {
				list: () => listSessions(cfg.dataDir),
				read: (id, limit) => readSession(cfg.dataDir, id, limit ? { limit } : {}),
			},
		});
		await web.start();
		console.log(`[agent] dashboard: http://127.0.0.1:${web.actualPort}/`);
	}

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

	const { agent } = createAgent({
		deps,
		streamFn,
		model,
		// Context hygiene + (v0.3) lesson injection (SPEC §4.1).
		transformContext: pruningTransformContext({ keepRecent: 40 }),
		onActionResult: (tool, r) => {
			console.log(`[agent] tool ${tool}: ok=${r.ok} ${r.summary}`);
			audit.write({ type: "action_result", ts: Date.now(), tool, ok: r.ok, summary: r.summary, data: r.data });
			session.appendAudit({ type: "action_result", ts: Date.now(), tool, ok: r.ok, summary: r.summary, data: r.data });
		},
	});

	// Feed every agent event into telemetry (token usage, thinking, tool steps).
	agent.subscribe((event) => {
		telemetry.ingestAgentEvent(event);
	});

	// --- decision turn(s) ---
	const maxTurns = opts.maxTurns ?? 1;
	for (let i = 0; i < maxTurns && !stopRequested; i++) {
		// Record the decision point (state seen) BEFORE the agent acts, so the
		// trail reads decision -> action_result. Telemetry counts it too.
		telemetry.decisionPoint();
		const preState = summarizeState(deps.state.snapshot());
		audit.write({ type: "decision", ts: Date.now(), turn: i + 1, date: String(preState.date ?? "?"), state: preState });
		session.appendAudit({ type: "decision", ts: Date.now(), turn: i + 1, state: preState });
		const state = await runDecision(agent, deps);
		console.log(`[agent] decision turn ${i + 1}: ${JSON.stringify(state.date)}`);
		telemetry.onActivity?.();

		// Staged summary per completed decision turn, so the Live page's timeline
		// fills up during the run instead of only at shutdown
		// (docs/DASHBOARD-UI.md §7).
		const snap = deps.state.snapshot();
		session.update({ totals: totalsFromTelemetry(session.current().totals, telemetry.snapshot(), snap.totalEvents) });
		const cp = buildStageSummary(session.current(), formatGameDate(snap.date), i + 1);
		session.addCheckpoint(cp);
		web?.publishCheckpoint(cp);
	}

	// --- observe construction + report ---
	console.log("[agent] observing construction…");
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
	const stopPromise = new Promise<void>((res) => {
		resolveStop = res;
		const check = () => (stopRequested ? res() : setTimeout(check, 300));
		check();
	});
	if (opts.seconds && opts.seconds > 0) {
		await Promise.race([stopPromise, sleep(opts.seconds * 1000)]);
	} else {
		await stopPromise;
	}
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
		buildStageSummary(session.current(), formatGameDate(snap.date), Math.max(1, maxTurns)),
	);
	console.log(
		`[agent] tokens: in=${finalTelemetry.usage.total.input} out=${finalTelemetry.usage.total.output} ` +
			`reasoning=${finalTelemetry.usage.total.reasoning} total=${finalTelemetry.usage.total.totalTokens} ` +
			`cost=$${finalTelemetry.usage.total.costTotal.toFixed(4)}`,
	);
	console.log(
		`[agent] tools: ${finalTelemetry.totals.toolCalls} calls, ${finalTelemetry.totals.toolFailures} failed`,
	);
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
		if (web) await web.stop();
		await mgr.stop();
	}
}
