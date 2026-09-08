/* eslint-disable no-console */
/**
 * v0.2 Runner — minimal decision-loop demo (M2 skeleton).
 *
 * 职责: 编排「外部 → Bridge GS → GSSign → Executor AI → 可观测动作」全链路:
 *   1. deploy squirrel packs (BridgeV1 GS + ExecutorV1 AI) 到 sandbox
 *   2. openttd.cfg [game_scripts] 选 BridgeV1 → -G 生成地图即 attach GS
 *   3. AdminClient 起; 等 BridgeV1 心跳 (gamescript 事件) 证明 GS 活着
 *   4. rcon start_ai ExecutorV1 (agent 公司)
 *   5. 发 demo 蓝图 → GS 放 NUTZ 标牌 → ExecutorV1 读到 → 施工/汇报
 * 验收 (v0.2 骨架): 全链路事件可观测; Executor 公司名带 phase (COMPANY_INFO)。
 * 事实来源: SPEC §10.10/§10.11。
 * 禁止: LLM 决策 (后续接 Pi Agent); 触碰用户全局配置。
 */

import { type Config } from "../config.js";
import { OpenTTDProcessManager } from "../game/process-manager.js";
import { AdminClient } from "../game/admin-client.js";
import { WorldState } from "../game/world-state.js";
import { AdminUpdateType, ALL_COMPANIES } from "../game/admin-protocol.js";
import {
	deploySquirrelPacks,
	selectBridgeGsInConfig,
	BRIDGE_GS_NAME,
	EXECUTOR_AI_NAME,
} from "./squirrel-deploy.js";
import { stringifyJson } from "../util/json.js";

export interface V02Options {
	/** Seconds to run the demo before auto-exit. 0 = until Ctrl-C. */
	demoSeconds?: number;
}

export async function runV02(cfg: Config, opts: V02Options = {}): Promise<number> {
	const mgr = new OpenTTDProcessManager(cfg);
	const world = new WorldState();
	let client: AdminClient | null = null;
	let stopRequested = false;
	let resolveStopped: (() => void) | null = null;

	const requestStop = (_code: number) => {
		if (stopRequested) return;
		stopRequested = true;
		console.log("[v02] shutting down…");
		resolveStopped?.();
	};
	process.once("SIGINT", () => requestStop(0));
	process.once("SIGTERM", () => requestStop(0));
	mgr.onExit = (code) => {
		if (!stopRequested && code !== 0) console.error(`[v02] server exited unexpectedly code=${code}`);
	};

	// --- 1. deploy packs (before first server start so scanner picks them up) ---
	console.log(`[v02] deploying squirrel packs (${BRIDGE_GS_NAME}, ${EXECUTOR_AI_NAME})…`);
	await deploySquirrelPacks(cfg);

	console.log(`[v02] sandbox config…`);
	await mgr.ensureSandboxConfig();
	await selectBridgeGsInConfig(cfg);
	console.log(`[v02] BridgeV1 selected in [game_scripts]`);

	console.log(`[v02] spawning dedicated server…`);
	await mgr.start();
	console.log(`[v02] waiting for admin port…`);
	await mgr.waitForAdminPort(25_000);
	console.log(`[v02] admin port open.`);

	// --- 2. AdminClient ---
	let gsStates = 0;
	let executorPhase = "";
	const companiesByName = new Map<string, number>(); // name -> id

	client = new AdminClient({
		cfg,
		callbacks: {
			onEvent: (ev) => {
				world.ingest(ev);
				if (ev.kind === "gamescript") {
					const p = ev.payload as Record<string, unknown>;
					if (p.cmd === "state") {
						gsStates++;
						if (true) { // debug: log all state
							console.log(`[v02] GS state #${gsStates}: tick=${p.tick} towns=${p.towns} signs=${p.signs}`);
						}
					} else {
						console.log(`[v02] GS msg: ${stringifyJson(p)}`);
					}
				}
				if (ev.kind === "company_info") {
					const p = ev.payload as { id: number; name: string; isAi: boolean };
					if (p.isAi) {
						companiesByName.set(p.name, p.id);
						if (p.name.startsWith("EX ")) {
							if (executorPhase !== p.name) {
								executorPhase = p.name;
								console.log(`[v02] Executor phase -> "${p.name}"`);
							}
						}
					}
				}
				if (ev.kind === "company_new") {
					console.log(`[v02] company created: id=${(ev.payload as { id: number }).id}`);
				}
			},
			onStatusChange: (s, d) => {
				if (s === "error") console.error(`[v02] admin client error: ${d ?? s}`);
			},
			onWelcome: async () => {
				console.log(`[v02] admin authed. waiting for GS heartbeat…`);
			},
		},
	});
	await client.connect(10_000);

	// --- 3. wait for GS state heartbeat (proves BridgeV1 attached) ---
	const gsDeadline = Date.now() + 20_000;
	while (gsStates === 0 && Date.now() < gsDeadline && !stopRequested) {
		await sleep(250);
	}
	if (gsStates === 0) {
		console.error("[v02] ERROR: BridgeV1 GS never heartbeated. Check [game_scripts] selection.");
		await teardown();
		return 1;
	}
	console.log(`[v02] BridgeV1 GS confirmed alive (state #1 received).`);

	// --- 4. start our executor AI company ---
	console.log(`[v02] rcon start_ai "${EXECUTOR_AI_NAME}"`);
	client.rcon(`start_ai "${EXECUTOR_AI_NAME}"`);
	const aiDeadline = Date.now() + 20_000;
	let bootSeen = false;
	while (Date.now() < aiDeadline && !stopRequested) {
		if (companiesByName.has(`EX boot j-1`)) {
			bootSeen = true;
			break;
		}
		// Company-info Automatic push only fires on changes; poll to observe
		// the executor's boot name (SetPhase encodes it in the company name).
		client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		await sleep(500);
	}
	console.log(`[v02] executor boot phase: ${bootSeen ? executorPhase || "EX boot j-1" : "(not seen — still waiting)"}`);

	// --- 5. send a demo command (GS places a real sign; executor reacts) ---
	console.log(`[v02] sending demo job command…`);
	// BridgeV1 picks a town tile, places a NUTZ:bp:7:S sign in company 0's
	// (executor's) company mode; ExecutorV1 reads it, funds via loan, reports
	// phase "work". Executor company id comes from company_new (fresh map = 0).
	client.gameScript(stringifyJson({ cmd: "demo", company: 0 }));
	console.log(`[v02] waiting for executor to react…`);

	// Poll company info to observe the executor's phase transition to work.
	let sawWork = false;
	const workDeadline = Date.now() + 15_000;
	while (Date.now() < workDeadline && !stopRequested) {
		if (executorPhase.startsWith("EX work")) {
			sawWork = true;
			break;
		}
		client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		await sleep(500);
	}
	console.log(`[v02] executor reacted to blueprint: ${sawWork ? "✅ phase=work" : "(no phase change)"}`);

	// --- 6. run until stop (or demoSeconds auto-stop) ---
	console.log(`[v02] observing… (Ctrl-C to stop)`);
	const stopPromise = new Promise<void>((resolve) => {
		resolveStopped = resolve;
		const check = () => (stopRequested ? resolve() : setTimeout(check, 300));
		check();
	});
	if (opts.demoSeconds && opts.demoSeconds > 0) {
		await Promise.race([stopPromise, sleep(opts.demoSeconds * 1000)]);
	} else {
		await stopPromise;
	}

	// report
	console.log(`[v02] RESULT: gsStates=${gsStates} executorPhase="${executorPhase}"`);
	await teardown();
	return executorPhase.length > 0 ? 0 : 1;

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

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export type { Config };
