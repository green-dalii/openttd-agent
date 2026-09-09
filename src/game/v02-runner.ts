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
	let routeAck: Record<string, unknown> | null = null;
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
						if (p.kind === "ack" && p.cmd === "build_bus_route") routeAck = p;
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

	// --- 5. send build_bus_route (S1: GS plans a 2-town bus route + places
	// S/E station signs in the executor's company mode; executor reads them) ---
	console.log(`[v02] sending build_bus_route…`);
	client.gameScript(stringifyJson({ cmd: "build_bus_route", company: 0, job: 101 }));
	console.log(`[v02] waiting for GS route ack…`);

	// Wait for the ack: company_signs >= 2 (S + E placed in executor mode).
	const ackDeadline = Date.now() + 15_000;
	while (routeAck === null && Date.now() < ackDeadline && !stopRequested) {
		client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		await sleep(300);
	}
	// TS control-flow can't see the closure assignment; re-widen explicitly.
	const ackView: Record<string, unknown> | null = routeAck as Record<string, unknown> | null;
	const signsPlaced = ackView !== null && Number(ackView.company_signs) >= 2;
	console.log(
		`[v02] GS route ack: ${
			ackView ? `company_signs=${ackView.company_signs} job=${ackView.job}` : "(no ack)"
		}`,
	);
	console.log(`[v02] S1 accept: ${signsPlaced ? "✅ S+E signs in executor mode" : "❌ missing signs"}`);

	// The executor should pick up job 101 and report phase work.
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

	// --- 5b. S2-S4: wait for the executor to finish construction (done phase),
	// then confirm the world changed: >=1 road vehicle in stats, cash spent. ---
	const buildDeadline = Date.now() + 120_000;
	while (!executorPhase.startsWith("EX done") && Date.now() < buildDeadline && !stopRequested) {
		client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		await sleep(500);
	}
	if (executorPhase.startsWith("EX done")) {
		console.log(`[v02] S4 construction done: phase="${executorPhase}"`);
		// Stats: company 0 should now own >=1 road vehicle + 2 stations.
		let vehicles = -1;
		let stations = -1;
		const statsDeadline = Date.now() + 10_000;
		while (Date.now() < statsDeadline && vehicles < 0) {
			client?.poll(AdminUpdateType.CompanyStats, 0);
			await sleep(600); // let the poll response arrive before reading
			const st = world.snapshot().companies.get(0);
			vehicles = st?.stats?.vehicles ?? -1;
			stations = st?.stats?.stations ?? -1;
		}
		console.log(`[v02] S4 live route: vehicles=${vehicles} stations=${stations}`);
		// Economy snapshot for the report.
		let money = -1n;
		const econDeadline = Date.now() + 8_000;
		while (Date.now() < econDeadline && money < 0n) {
			client?.poll(AdminUpdateType.CompanyEconomy, 0);
			await sleep(600);
			const st = world.snapshot().companies.get(0);
			money = st?.economy?.money ?? -1n;
		}
		console.log(`[v02] company money=${money}`);
	} else {
		console.log(`[v02] S2-S4 WARN: construction not done (last phase "${executorPhase}")`);
	}

	// --- 6. observe until stop (or demoSeconds auto-stop) ---
	// Poll company info during observation so executor SetPhase renames are
	// seen (Automatic company_info push only fires on change, and even then
	// only while we have a live subscription — poll to be safe).
	console.log(`[v02] observing… (Ctrl-C to stop)`);
	const obsPoll = setInterval(() => {
		if (stopRequested) return;
		try {
			client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		} catch {
			/* client may be closed at teardown */
		}
	}, 500);
	// S5: track the cash curve over in-game time. Every ~3s take a
	// (date, money, income) snapshot so we can tell whether the bus route
	// is earning (cash rising / quarterly income positive).
	const econSeries: Array<{ date: string; money: bigint; income: bigint }> = [];
	const econPoll = setInterval(async () => {
		if (stopRequested) return;
		try {
			client?.poll(AdminUpdateType.Date, 0);
			client?.poll(AdminUpdateType.CompanyEconomy, 0);
			await sleep(1200); // let poll responses land
			const snap = world.snapshot();
			const st = snap.companies.get(0);
			const d = snap.date;
			if (!st?.economy) return;
			econSeries.push({
				date: d ? `${d.year}-${String(d.month).padStart(2, "0")}` : "????-??",
				money: st.economy.money,
				// income is a signed 64-bit value stored as u64 by the codec.
				income: BigInt.asIntN(64, st.economy.income),
			});
		} catch {
			/* ignore */
		}
	}, 3000);
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

	clearInterval(obsPoll);
	clearInterval(econPoll);

	// S5 report: show the tail of the cash curve and a profitability guess
	// (last income positive OR money at end > money at series start).
	if (econSeries.length >= 2) {
		const first = econSeries[0]!;
		const last = econSeries[econSeries.length - 1]!;
		const earned = last.money - first.money;
		console.log(`[v02] S5 economy: ${econSeries.length} snapshots, ${first.date}->${last.date}`);
		for (const e of econSeries.slice(-6)) {
			console.log(`[v02]   ${e.date} money=${e.money} income=${e.income}`);
		}
		console.log(
			`[v02] S5 profit: cash delta=${earned} last income=${last.income} => ${
				earned > 0n ? "✅ earning" : last.income > 0n ? "✅ income positive" : "❌ not yet profitable"
			}`,
		);
	} else {
		console.log(`[v02] S5 WARN: too few economy snapshots to judge profitability`);
	}

	// report
	const ackFinal: Record<string, unknown> | null = routeAck as Record<string, unknown> | null;
	console.log(`[v02] RESULT: gsStates=${gsStates} routeAck=${ackFinal !== null ? "yes" : "no"} executorPhase="${executorPhase}"`);
	await teardown();
	return ackFinal !== null && executorPhase.length > 0 ? 0 : 1;

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
