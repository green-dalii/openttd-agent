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
import { createEpisode } from "../agent/episode.js";
import { gameDayFromRawDate } from "../game/payload-parsers.js";
import { AdminUpdateType, ALL_COMPANIES } from "../game/admin-protocol.js";
import {
	deploySquirrelPacks,
	selectBridgeGsInConfig,
	BRIDGE_GS_NAME,
	EXECUTOR_AI_NAME,
} from "./squirrel-deploy.js";
import { join } from "node:path";
import { stringifyJson } from "../util/json.js";

export interface V02Options {
	/** Seconds to run the demo before auto-exit. 0 = until Ctrl-C. */
	demoSeconds?: number;
	/**
	 * Baseline-probe knob (2026-09-17, SPEC §10.57): after construction finishes,
	 * request this many vehicles on the demo route. Used to verify a known-good
	 * policy can produce `deliveredCargo > 0` without depending on the agent.
	 */
	addVehicles?: number;
	/**
	 * M3-1（2026-09-19）：请求一个**低于当前车队**的数量，并观测车队是否真的下降。
	 * 环境事实（源码确证于 `executor-ai/main.nut:CheckAddVehicles`）：`V:<count>` 在
	 * `cur > want` 时卖车（最新优先、永不卖头车）。源码说会卖 ≠ 真的会卖——
	 * 这条探针存在的意义就是把它从"读源码"变成"量过的行为"（MEMORY D8/D19）。
	 */
	shrinkTo?: number;
	/** M3-2a probe: retire this job and observe whether the fleet goes away. */
	retireJob?: number;
	/** M3-2c probe: queue a SECOND route so the first one becomes "not current". */
	secondRoute?: boolean;
	/**
	 * Episode horizon in SIMULATED game days (G1, SPEC §10.68). The oracle probe
	 * measures "delivered as a function of fleet size", so every rep must observe
	 * the same amount of world - otherwise the gradient mixes in window length.
	 */
	gameDays?: number;
}

export async function runV02(cfg: Config, opts: V02Options = {}): Promise<number> {
	const mgr = new OpenTTDProcessManager(cfg);
	const world = new WorldState();
	let client: AdminClient | null = null;
	let stopRequested = false;
	/** Raw OpenTTD date from the GS channel (fine episode clock, ~3 game days). */
	let gsRawDate: number | null = null;
	/**
	 * `EX done …` is TRANSIENT: the executor switches to vehicle telemetry almost
	 * immediately, so testing the CURRENT phase misses it - which is how the first
	 * S0 batch silently never sent a single fleet request, and would have reported
	 * "no gradient" as if that were a fact about the game.
	 */
	let seenDone = false;
	/** Fleet size measured AFTER the request (the probe's own effect). */
	let fleetAfterRequest: number | null = null;
	/** Did the probe actually send its request? Runs where it did not are void. */
	let fleetProbeFired = false;
	/** Post-shrink observation (M3-1); null when the probe could not run. */
	let fleetAfterShrink: number | null = null;
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
						if (typeof p.date === "number") gsRawDate = p.date;
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
							// Latch "done" cumulatively: the phase is transient (telemetry
							// follows immediately), and the fleet probe must not depend on
							// catching it at a poll instant.
							if (p.name.startsWith("EX done")) seenDone = true;
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
	// Generous on purpose. This used to be 120s, which a ~130-tile road does not
	// finish in - so the wait timed out, the fleet probe below was skipped, and the
	// first S0 batch would have reported "no gradient" while never having changed
	// the fleet at all. The episode clock bounds the wait now.
	const buildDeadline = Date.now() + 60 * 60_000;
	while (!seenDone && !executorPhase.startsWith("EX done") && Date.now() < buildDeadline && !stopRequested) {
		client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
		await sleep(500);
	}
	if (!seenDone && !executorPhase.startsWith("EX done")) {
		console.log(
			"[v02] WARNING: construction never reported done before the episode ended - " +
				"the fleet probe did NOT run, so this run cannot say anything about fleet size",
		);
	}
	if (seenDone || executorPhase.startsWith("EX done")) {
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

		if (opts.addVehicles !== undefined && opts.addVehicles > 0) {
			fleetProbeFired = true;
			console.log(`[v02] baseline probe: requesting ${opts.addVehicles} vehicles on job=101`);
			client.gameScript(JSON.stringify({ cmd: "add_vehicles", company: 0, job: 101, count: opts.addVehicles }));
			// Wait for the ack so the executor's mailbox saw the request.
			const vehAckDeadline = Date.now() + 8_000;
			// Wait long enough for the executor's mailbox to pick up the request;
			// it does not report back, so we just let a short window pass.
			while (Date.now() < vehAckDeadline && !stopRequested) {
				client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
				await sleep(250);
			}
			// Observe the EFFECT, not just the send (the project's own rule). The
			// first batch asked and never checked, so a request that was ignored
			// would have looked identical to one that worked.
			const appliedDeadline = Date.now() + 60_000;
			while (Date.now() < appliedDeadline && !stopRequested) {
				client?.poll(AdminUpdateType.CompanyStats, 0);
				await sleep(600);
				const v = world.snapshot().companies.get(0)?.stats?.vehicles ?? -1;
				if (v > vehicles) {
					fleetAfterRequest = v;
					break;
				}
			}
			console.log(
				fleetAfterRequest === null
					? `[v02] baseline probe: requested ${opts.addVehicles} vehicles, observed fleet did NOT grow (was ${vehicles})`
					: `[v02] baseline probe: requested ${opts.addVehicles}, observed fleet ${vehicles} -> ${fleetAfterRequest}`,
			);
		}

		// --- M3-1: the SAME lever, the other direction ---------------------------
		// 环境事实（源码确证于 `executor-ai/main.nut:CheckAddVehicles`）：`V:<count>`
		// 低于当前车队时会**卖车**（最新优先、永不卖头车）。源码说会卖 ≠ 真的会卖——
		// 这条探针把它从"读源码"变成"量过的行为"（MEMORY D8/D19）。
		if (opts.shrinkTo !== undefined && opts.shrinkTo > 0) {
			const from = fleetAfterRequest ?? vehicles;
			if (from <= opts.shrinkTo) {
				console.log(
					`[v02] shrink probe NOT run: fleet is ${from}, not above ${opts.shrinkTo} - ` +
						"nothing to sell, so this run says nothing about shrinking",
				);
			} else {
				// **故意在"执行器正忙"的时候发**（M3-1b，SPEC §10.84）。
				//
				// 2026-09-19 的第一版探针是"等 `done` 再发"，因为当时 `CheckAddVehicles()`
				// 只挂在 `} else if (this._stage == "done" && this._vehicle >= 0) {`。
				// 那是**被测对象的缺陷**，不是环境事实：施工期占一局的大部分时间，
				// 实测中执行器发完请求后再没回到过 `done` → 请求永不生效（§10.81）。
				// 修好后（任意阶段尝试 + 推迟具名），探针必须验证**更难的那条路**：
				// 忙时发，车队仍应下降。若只测"done 时发"，就等于只验证了本来的行为。
				const phaseNow = () =>
					[...world.snapshot().companies.values()]
						.map((c) => String(c.info?.name ?? ""))
						.find((n) => n.startsWith("EX ")) ?? "(unknown)";
				const busyDeadline = Date.now() + 120_000;
				let sentWhile = phaseNow();
				while (Date.now() < busyDeadline && !stopRequested && /^EX done/.test(sentWhile)) {
					// 等一个"正在施工"的时刻（不施工时也有意义，但那是弱情形）
					client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
					await sleep(500);
					sentWhile = phaseNow();
				}
				console.log(
					`[v02] shrink probe: executing stage "${sentWhile}"; requesting ${opts.shrinkTo} (fleet is ${from})`,
				);
				client.gameScript(
					JSON.stringify({ cmd: "add_vehicles", company: 0, job: 101, count: opts.shrinkTo }),
				);
				// Let the executor's mailbox see the request (it does not report back).
				const mailboxDeadline = Date.now() + 8_000;
				while (Date.now() < mailboxDeadline && !stopRequested) {
					client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
					await sleep(250);
				}
				// Observe the EFFECT, not the send (same rule as the growth probe):
				// the executor applies on its own tick, so poll until the fleet drops.
				// 谁在施工 → 请求被推迟到能应用的时候，所以窗口要够长（≥5 分钟）。
				const shrinkDeadline = Date.now() + 420_000;
				while (Date.now() < shrinkDeadline && !stopRequested) {
					client?.poll(AdminUpdateType.CompanyStats, 0);
					await sleep(600);
					const v = world.snapshot().companies.get(0)?.stats?.vehicles ?? -1;
					if (v >= 0 && v < from) {
						fleetAfterShrink = v;
						break;
					}
				}
				console.log(
					fleetAfterShrink === null
						? `[v02] shrink probe: requested ${opts.shrinkTo}, observed fleet DID NOT shrink (still ${from})`
						: `[v02] shrink probe: requested ${opts.shrinkTo}, observed fleet ${from} -> ${fleetAfterShrink}`,
				);
			}
		}
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

	// --- M3-2c: 给"非当前"线路调车队 ------------------------------------------
	// 这一条验证的是 D20 的根因：agent 在建 job 102 时给 job 101 调车队，
	// 旧行为是 `fleet_otherjob` 拒绝（实测同一请求重发 8 次、车队不变）。
	// 现在登记表 `_routes` 能提供旧线路的车队，所以**必须真的生效**。
	if (opts.secondRoute) {
		const phaseNow = () =>
			[...world.snapshot().companies.values()]
				.map((c) => String(c.info?.name ?? ""))
				.find((n) => n.startsWith("EX ")) ?? "";
		// 1) 等第一条线路完工
		const doneDeadline = Date.now() + 420_000;
		while (Date.now() < doneDeadline && !stopRequested && !/^EX done/.test(phaseNow())) {
			client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
			await sleep(500);
		}
		console.log(`[v02] 2nd-route probe: first route phase "${phaseNow()}"`);
		// 2) 排第二条线路，让 101 变成"非当前"
		console.log("[v02] 2nd-route probe: sending build_bus_route job=102");
		client.gameScript(stringifyJson({ cmd: "build_bus_route", company: 0, job: 102 }));
		const switchedDeadline = Date.now() + 300_000;
		while (Date.now() < switchedDeadline && !stopRequested && !/j102$/.test(phaseNow())) {
			client?.poll(AdminUpdateType.CompanyInfo, ALL_COMPANIES);
			await sleep(500);
		}
		console.log(`[v02] 2nd-route probe: executor now on "${phaseNow()}"`);
		// 3) 给**旧**线路 101 调车队，看它是否真的生效
		const before = world.snapshot().companies.get(0)?.stats?.vehicles ?? -1;
		console.log(`[v02] 2nd-route probe: requesting +3 on OLD job 101 (fleet is ${before})`);
		client.gameScript(JSON.stringify({ cmd: "add_vehicles", company: 0, job: 101, count: 3 }));
		const growDeadline = Date.now() + 300_000;
		let after = before;
		while (Date.now() < growDeadline && !stopRequested) {
			client?.poll(AdminUpdateType.CompanyStats, 0);
			await sleep(600);
			after = world.snapshot().companies.get(0)?.stats?.vehicles ?? -1;
			if (before >= 0 && after > before) break;
		}
		console.log(
			after > before
				? `[v02] 2nd-route probe: OLD route fleet applied ✅ (${before} -> ${after})`
				: `[v02] 2nd-route probe: OLD route request NOT applied (${before} -> ${after})`,
		);
	}

	// --- M3-2a: 退役探针 ------------------------------------------------------
	// 唯一能回答"能不能关掉一条线路"的地方：请求退役，然后观测**车队是否消失**。
	// 与其它探针同规则：报请求、观测效果（公司车辆数由 admin 通道 + 引擎相位双重印证）。
	if (opts.retireJob !== undefined && opts.retireJob > 0) {
		const before = world.snapshot().companies.get(0)?.stats?.vehicles ?? -1;
		console.log(`[v02] retire probe: requesting retirement of job ${opts.retireJob} (fleet is ${before})`);
		client.gameScript(JSON.stringify({ cmd: "retire_route", company: 0, job: opts.retireJob }));
		const retireDeadline = Date.now() + 420_000;
		let after = before;
		while (Date.now() < retireDeadline && !stopRequested) {
			client?.poll(AdminUpdateType.CompanyStats, 0);
			await sleep(600);
			after = world.snapshot().companies.get(0)?.stats?.vehicles ?? -1;
			if (after === 0) break;
		}
		console.log(
			after === 0
				? `[v02] retire probe: fleet ${before} -> 0 (route retired)`
				: `[v02] retire probe: requested, fleet ${before} -> ${after} (NOT zero)`,
		);
		console.log(`[v02] retire probe: final executor phase "${executorPhase ?? "(none)"}"`);
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
	// G1: same episode clock as the agent path - simulated days are the
	// measurement, wall clock is only the safety cap.
	const gameDayNow = (): number => {
		// GS raw date first: the admin Date subscription is MONTHLY, so the world
		// date alone can only cut the episode to the nearest 30 game days.
		if (gsRawDate !== null) return gameDayFromRawDate(gsRawDate);
		const d = world.snapshot().date;
		if (!d) return 0;
		return (d.year - 1950) * 360 + (d.month - 1) * 30 + (d.day - 1);
	};
	const episode = createEpisode({
		horizonDays: opts.gameDays ?? null,
		capMs: opts.demoSeconds && opts.demoSeconds > 0 ? opts.demoSeconds * 1000 : null,
		startedAtMs: Date.now(),
		startGameDay: gameDayNow(),
	});
	const horizonWatch = setInterval(() => {
		const st = episode.check({ gameDay: gameDayNow(), nowMs: Date.now() });
		if (st.stopReason === "horizon") {
			console.log(`[v02] episode horizon reached (${st.simulatedDays} game days) - stopping`);
			stopRequested = true;
			resolveStopped?.();
		} else if (st.stopReason === "wall_cap") {
			console.log(
				`[v02] wall-clock cap reached after ${st.simulatedDays} game days ` +
					`(horizon ${episode.plan.horizonDays ?? "n/a"} NOT reached) - stopping`,
			);
			stopRequested = true;
			resolveStopped?.();
		}
	}, 1000);
	await stopPromise;
	clearInterval(horizonWatch);
	const episodeEnd = episode.check({ gameDay: gameDayNow(), nowMs: Date.now() });
	// `deliveredRun` needs a final economy packet to be current; the integrate
	// happens on every poll, so the last one is already in world state.

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

	// N2-4b oracle probe：v02 也读 deliveredCargo 并写 metrics.jsonl 一行
	// （arm=control 的"已知好的程序策略"对照，与 agent 路径可比）。
	let deliveredCargo = -1;
	const delDeadline = Date.now() + 6_000;
	while (Date.now() < delDeadline && deliveredCargo < 0) {
		client?.poll(AdminUpdateType.CompanyEconomy, 0);
		await sleep(400);
		const st2 = world.snapshot().companies.get(0);
		deliveredCargo = st2?.economy?.deliveredCargo ?? -1;
	}
	console.log(`[v02] deliveredCargo=${deliveredCargo}`);
	const stEcon = world.snapshot().companies.get(0);
	const armMeta = {
		id: `v02-${Date.now()}-seed${cfg.seed ?? 0}`,
		seed: cfg.seed ?? 0,
		mode: "v02",
		status: ackFinal !== null ? "completed" : "aborted",
		startedAt: Date.now() - 500_000,
		durationMs: 500_000,
		appVersion: (cfg as unknown as { appVersion?: string }).appVersion ?? "",
		llmKind: "faux",
		llmModel: "",
		constructionDone: executorPhase.startsWith("EX done"),
		money: stEcon?.economy ? Number(stEcon.economy.money) : 0,
		income: stEcon?.economy ? Number(stEcon.economy.income) : 0,
		// RAW quarterly counter (kept: it is the wire truth) and the integrated
		// figure that comparisons use (SPEC §10.65). The oracle gradient test is a
		// comparison, so it must read deliveredRun.
		delivered: deliveredCargo >= 0 ? deliveredCargo : null,
		deliveredRun: stEcon?.deliveredRun?.total ?? null,
		deliveredRunComplete: stEcon?.deliveredRun?.complete ?? null,
		vehicles: stEcon?.stats?.vehicles ?? 0,
		stations: stEcon?.stats?.stations ?? 0,
		decisions: 0,
		toolCalls: 0,
		toolFailures: 0,
		totalTokens: 0,
		costTotal: 0,
		arm: "control",
		memory: { lessonsInjected: 0, strategiesInjected: 0, routeFactsInjected: 0 },
		// The probe's own effect: what fleet the request actually produced.
		fleetRequested: opts.addVehicles ?? null,
		fleetObservedAfterRequest: fleetAfterRequest,
		fleetProbeFired,
		// M3-1: the OTHER direction of the same lever. Durable evidence (a console line
		// in /tmp disappears; the metric row is what a later session can check).
		shrinkRequested: opts.shrinkTo ?? null,
		fleetObservedAfterShrink: fleetAfterShrink,
		// G1: the oracle probe is a measurement too, so it records its horizon.
		simulatedDays: episodeEnd.simulatedDays,
		horizonDays: episode.plan.horizonDays,
		reachedHorizon: episodeEnd.reachedHorizon,
		gsErrors: 0,
	};
	try {
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const evoDir = cfg.dataDir ?? process.env.OPENTTD_DATA_DIR;
		if (evoDir) {
			mkdirSync(join(evoDir, "evolution"), { recursive: true });
			writeFileSync(join(evoDir, "evolution", "metrics.jsonl"), JSON.stringify(armMeta) + "\n", { flag: "a" });
		}
	} catch (e) {
		console.warn(`[v02] metrics.jsonl write failed: ${String(e)}`);
	}

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
