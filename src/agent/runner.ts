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
import { buildProvider, redactKey } from "./provider.js";
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
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
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
	if (isLlmConfigured(cfg.llm)) {
		const built = await buildProvider(cfg.llm);
		streamFn = built.streamFn as unknown as AgentOptionsStreamFn;
		model = built.model;
		console.log(
			`[agent] brain: REAL provider "${cfg.llm.providerId}" model=${cfg.llm.model} base=${cfg.llm.baseUrl} key=${redactKey(cfg.llm.apiKey)}`,
		);
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

	const { agent } = createAgent({
		deps,
		streamFn,
		model,
		// Context hygiene + (v0.3) lesson injection (SPEC §4.1).
		transformContext: pruningTransformContext({ keepRecent: 40 }),
		onActionResult: (tool, r) => {
			console.log(`[agent] tool ${tool}: ok=${r.ok} ${r.summary}`);
			audit.write({ type: "action_result", ts: Date.now(), tool, ok: r.ok, summary: r.summary, data: r.data });
		},
	});

	// --- decision turn(s) ---
	const maxTurns = opts.maxTurns ?? 1;
	for (let i = 0; i < maxTurns && !stopRequested; i++) {
		// Record the decision point (state seen) BEFORE the agent acts, so the
		// trail reads decision -> action_result.
		const preState = summarizeState(deps.state.snapshot());
		audit.write({ type: "decision", ts: Date.now(), turn: i + 1, date: String(preState.date ?? "?"), state: preState });
		const state = await runDecision(agent, deps);
		console.log(`[agent] decision turn ${i + 1}: ${JSON.stringify(state.date)}`);
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
	await teardown();
	return reachedDone ? 0 : 1;

	async function teardown() {
		if (stopRequested) return;
		stopRequested = true;
		try {
			client?.rcon("pause");
		} catch {
			/* best-effort */
		}
		await sleep(300);
		client?.close();
		await mgr.stop();
	}
}
