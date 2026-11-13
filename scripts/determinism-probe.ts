/**
 * Determinism probe (Issue #106) — does the same savegame give the same run?
 *
 * 职责: 回答**反事实 fork 的前提**："同一存档读两次 ⇒ 同一世界吗？"
 *   做法（探针，不是产品路径）：
 *     A. 起一台隔离的服务器（新地图、固定种子）⇒ 跑到第 D 天 ⇒ 存一个存档 ⇒
 *        **发同一条命令** ⇒ 再跑 M 天，记录**每一天的钱**（资金轨迹）。
 *     B. 把存档复制到另一个隔离目录 ⇒ 服务器 `-g <savegame>` **从存档开局** ⇒
 *        发**同一条命令** ⇒ 再跑 M 天，记录资金轨迹。
 *     C. 逐日比较两条轨迹 ⇒ 相同就写"同存档 ⇒ 同轨迹"，不同就写出**第一次分叉**
 *        的日子与两个数。
 * 禁止: 碰用户实例（独立 data dir + 独立端口）；不假装成功（读不到就报错退出）。
 *
 * 用法:
 *   pnpm exec tsx scripts/determinism-probe.ts [--data-dir /tmp/pDet] \
 *     [--checkpoint-day 60] [--window-days 30] [--command build_bus_route] [--seed 4242]
 *
 * 事实来源: Issue #106；SPEC §10.113（机制已核实：`-g savegame` + 控制台 `save`
 *   ⇒ **引擎侧**同存档可复现；但**脚本自身的状态不随存档存取**（GS 与 ExecutorV1
 *   都没有 `Save()`/`Load()`）⇒ 读档后 GS 从零重启 ⇒ 正式 fork 的两臂都必须
 *   从存档起步，不能一臂续跑、一臂读档）。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { AdminClient } from "../src/game/admin-client.js";
import { AdminUpdateType, ALL_COMPANIES } from "../src/game/admin-protocol.js";
import { OpenTTDProcessManager } from "../src/game/process-manager.js";
import { deploySquirrelPacks, selectBridgeGsInConfig } from "../src/game/squirrel-deploy.js";
import { dayOfYear as calendarDayOfYear } from "../src/game/calendar.js";
import { compareMoneyLevels, moneyLevels } from "../src/util/money-levels.js";

interface Args {
	dataDir: string;
	checkpointDay: number;
	windowDays: number;
	command: string | null;
	seed: number;
	adminPort: number;
	gamePort: number;
	/** 先发命令再存档（测 GS 自己的状态是否随存档恢复）。 */
	commandBeforeSave: boolean;
}

function parseArgs(argv: string[]): Args {
	const get = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const num = (name: string, fallback: number): number => {
		const v = get(name);
		return v === undefined ? fallback : Number(v);
	};
	const cmd = get("command");
	return {
		commandBeforeSave: argv.includes("--command-before-save"),
		dataDir: get("data-dir") ?? "/tmp/pDet",
		checkpointDay: num("checkpoint-day", 60),
		windowDays: num("window-days", 30),
		command: cmd === undefined || cmd === "none" ? null : cmd,
		seed: num("seed", 4242),
		adminPort: num("admin-port", 4431),
		gamePort: num("game-port", 4031),
	};
}

const args = parseArgs(process.argv.slice(2));

/** 游戏日：引擎日历里的年内第几天（1950-01-01 = 1）—— 换算只有一处出处。 */
function dayOfYear(raw: number): number {
	return calendarDayOfYear(raw);
}

interface Trajectory {
	/** 游戏日 → 当天最后一次读到的钱（**按墙钟采样** ⇒ 只作参考，见 levels）。 */
	moneyByDay: Map<number, number>;
	/**
	 * 有序去重的**资金档位**（第一次见到的顺序）。
	 *
	 * 为什么另有一份：钱只在"施工事件"那一刻变。轮询按墙钟走 ⇒
	 * "某一天的钱"= 那天最后一次轮询读到的值 ⇒ **落在哪一天取决于采样相位**
	 * （同一局两次读档可以在同一天差出一个施工事件的金额）。
	 * 而"钱经过的档位集合"与采样相位无关 ⇒ 这才是可比的东西。
	 */
	moneyLevels: number[];
	/** 原始采样序列（诊断用：看两局的采样节奏差多少）。 */
	samples: Array<{ day: number; money: number }>;
	/** 发命令那一刻的钱。 */
	moneyAtCommand: number | null;
	/** 发命令那一刻的游戏日。 */
	dayAtCommand: number | null;
	/** GS 的状态包有没有继续到（证明脚本状态随存档恢复）。 */
	gsSeen: boolean;
	/** 存档文件（跑 A 时写下的）。 */
	savePath: string | null;
	/** GS 的回执（ack）——证明命令真的到了 GS。 */
	acks: string[];
	/** GS 的施工阶段序列（exec 事件）——读档后施工走没走的证据。 */
	execStages: string[];
	/** 第一个 GS 状态包里的 admin_seen（读档后是否从 0 重新计数）。 */
	firstAdminSeen: number | undefined;
	/** 第一个 GS 状态包里的 last_cmd（读档后还记得上一条命令吗？）。 */
	firstLastCmd: string | null | undefined;
	/** 第一个 GS 状态包里的标牌数（读档后还在吗？）。 */
	firstSignCount: number | null | undefined;
	/** 最近一个 GS 状态包的指纹（admin_seen / last_cmd / 标牌数）。 */
	lastState: { adminSeen: number; lastCmd: string | null; signCount: number | null } | undefined;
	/** 存档那一刻的 GS 指纹（读档后与它对比 ⇒ GS 状态有没有被存进去）。 */
	gsStateAtSave: { adminSeen: number; lastCmd: string | null; signCount: number | null } | null;
	notes: string[];
}

async function runPhase(opts: {
	dir: string;
	adminPort: number;
	gamePort: number;
	seed: number;
	/** 从这个存档开局（run B）。 */
	loadSavegame: string | null;
	/** 在第几天存一次（run A）。 */
	saveAtDay: number | null;
	/** 在第几天发命令。 */
	commandAtDay: number | null;
	command: string | null;
	/** 这一轮是否发命令（读档的两轮在"先发命令再存档"模式下不发）。 */
	sendCommand: boolean;
	/** 先发命令再存档（测 GS 自己的状态是否随存档恢复）。 */
	commandBeforeSave: boolean;
	/** 跑到第几天就收。 */
	untilDay: number;
}): Promise<Trajectory> {
	const dir = opts.dir;
	mkdirSync(dir, { recursive: true });
	const cfg = {
		...loadConfig(),
		dataDir: dir,
		adminPort: opts.adminPort,
		gamePort: opts.gamePort,
		seed: opts.seed,
	};
	const pm = new OpenTTDProcessManager(cfg);
	await deploySquirrelPacks(cfg);
	await pm.ensureSandboxConfig();
	await selectBridgeGsInConfig(cfg);

	const extraArgs: string[] = [];
	if (opts.loadSavegame) extraArgs.push("-g", opts.loadSavegame);
	await pm.start({ newGame: !opts.loadSavegame, extraArgs });

	const notes: string[] = [];
	let currentRaw = 0;
	const client = new AdminClient({
		cfg,
		callbacks: {
			onEvent: (ev) => {
				if (ev.kind === "gamescript") traj.gsSeen = true;
				const p = ev.payload as Record<string, unknown> | undefined;
				if (!p) return;
				// 日期读数带 raw（引擎日历）⇒ 折成"年内第几天"。
				if (ev.kind === "date") {
					const raw = Number(p.raw);
					if (Number.isFinite(raw) && raw > 0) currentRaw = raw;
					return;
				}
				if (ev.kind === "company_economy") {
					// 经济读数**不带日期** ⇒ 用同一时刻的日期读数归档（admin 的
					// date 更新与经济更新是同一个通道 ⇒ 足够对齐）。
					const money = Number(p.money);
					const day = currentRaw > 0 ? dayOfYear(currentRaw) : 0;
					if (Number.isFinite(money) && day > 0) {
						traj.moneyByDay.set(day, money);
						traj.samples.push({ day, money });
					}
				}
				if (ev.kind === "gamescript") {
					// GS 的 `admin_seen` 计数：读档后如果从 0 重新开始 ⇒
					// **GS 自己的 Squirrel 状态没被存进存档**（没有 Save() 方法）。
					if (p.cmd === "state") {
						if (traj.firstAdminSeen === undefined) {
							traj.firstAdminSeen = Number(p.admin_seen);
							traj.firstLastCmd = typeof p.last_cmd === "string" ? p.last_cmd : null;
							traj.firstSignCount = Array.isArray(p.signs) ? p.signs.length : null;
						}
						// 最近一个状态包的指纹（读档前 A 的 vs 读档后 B/C 的）。
						traj.lastState = {
							adminSeen: Number(p.admin_seen),
							lastCmd: typeof p.last_cmd === "string" ? p.last_cmd : null,
							signCount: Array.isArray(p.signs) ? p.signs.length : null,
						};
					}
					// 施工阶段序列（exec 事件）：读档后施工到底走没走。
					if (p.kind === "exec" || p.stage !== undefined) {
						const stage = typeof p.stage === "string" ? p.stage : String(p.stage ?? "?");
						traj.execStages.push(`${stage}${p.error ? ":" + String(p.error) : ""}`);
					}
					if (p.kind === "ack" || p.kind === "err") {
						traj.acks.push(JSON.stringify(p).slice(0, 300));
					}
					if (process.env.VERBOSE && traj.acks.length < 8 && p.kind !== "state") {
						console.log(`[probe] GS event: ${JSON.stringify(p).slice(0, 200)}`);
					}
				}
			},
		},
	});

	const traj: Trajectory = {
		moneyByDay: new Map(),
		moneyLevels: [],
		samples: [],
		moneyAtCommand: null,
		dayAtCommand: null,
		gsSeen: false,
		savePath: null,
		acks: [],
		execStages: [],
		firstAdminSeen: undefined,
		firstLastCmd: undefined,
		firstSignCount: undefined,
		lastState: undefined,
		gsStateAtSave: null,
		notes,
	};

	// 连接（握手完成才算数：MEMORY D119）。
	let connected = false;
	for (let i = 0; i < 40 && !connected; i++) {
		try {
			await client.connectAuthed(6_000);
			connected = true;
		} catch {
			await new Promise((r) => setTimeout(r, 1_500));
		}
	}
	if (!connected) {
		await pm.stop();
		throw new Error(`admin port ${opts.adminPort} never came up`);
	}

	// 轮询：日期 + 经济（钱）。
	const poll = setInterval(() => {
		try {
			client.poll(AdminUpdateType.Date);
			client.poll(AdminUpdateType.CompanyEconomy, ALL_COMPANIES);
		} catch {
			/* closed */
		}
	}, 500);

	// 游戏日怎么知道？用 admin 的日期读数（raw，见上面的 date 事件）。
	const datePoll = setInterval(() => {
		try {
			client.poll(AdminUpdateType.Date);
		} catch {
			/* closed */
		}
	}, 500);

	const day = (): number => (currentRaw > 0 ? dayOfYear(currentRaw) : 0);
	let lastLogged = -1;
	const logProgress = (): void => {
		const d = day();
		if (d > 0 && d !== lastLogged) {
			lastLogged = d;
			console.log(`[probe] day ${d} money=${money() ?? "?"} gs=${traj.gsSeen ? "yes" : "no"}`);
		}
	};
	const money = (): number | null => {
		const d = day();
		if (d <= 0) return null;
		const v = traj.moneyByDay.get(d);
		return v === undefined ? null : v;
	};

	// 等到某一天。
	const waitForDay = async (target: number, timeoutMs: number): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			logProgress();
			if (day() >= target) return true;
			await new Promise((r) => setTimeout(r, 500));
		}
		return false;
	};

	// **必须有公司**才有"资金轨迹" ⇒ 起 executor AI（它建公司 0）。
	// 与 harness 的做法一致（`client.rcon('start_ai "ExecutorV1"')`，runner.ts）。
	//
	// 从存档开局的那一轮（run B）**已经有公司**（AI 玩家随存档存盘）⇒
	// 再起一个会多出一个公司 ⇒ 先看有没有读数，没有才起。
	for (let i = 0; i < 10 && traj.moneyByDay.size === 0; i++) {
		await new Promise((r) => setTimeout(r, 500));
	}
	if (traj.moneyByDay.size === 0) {
		await client.rconAwait('start_ai "ExecutorV1"').catch(() => null);
		for (let i = 0; i < 60; i++) {
			if (traj.moneyByDay.size > 0) break;
			await new Promise((r) => setTimeout(r, 500));
		}
	}
	if (traj.moneyByDay.size === 0) notes.push("no company economy readings (no company?)");

	if (opts.commandBeforeSave && opts.sendCommand && opts.commandAtDay !== null && opts.command) {
		const ok = await waitForDay(opts.commandAtDay, 600_000);
		if (!ok) notes.push(`never reached day ${opts.commandAtDay}`);
		client.gameScript(JSON.stringify({ cmd: opts.command, company: 0 }));
		for (let i = 0; i < 40 && traj.acks.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 250));
		}
		notes.push(`command ${opts.command} (before save); acks=${traj.acks.length}`);
	}

	if (opts.saveAtDay !== null) {
		const ok = await waitForDay(opts.saveAtDay, 600_000);
		if (!ok) notes.push(`never reached day ${opts.saveAtDay}`);
		// 存档**之前**的 GS 指纹（与读档后的对比 ⇒ GS 自己的状态有没有被存进去）。
		// 若这一轮发过命令 ⇒ 先等 GS **自己公布**它处理完了（状态包的 last_cmd
		// 变了）⇒ 否则"存档时命令还没被处理"会让实验没有结论。
		if (opts.command) {
			for (let i = 0; i < 120; i++) {
				if (traj.lastState?.lastCmd === opts.command) break;
				await new Promise((r) => setTimeout(r, 250));
			}
			notes.push(`gs acknowledged ${opts.command} in state: ${traj.lastState?.lastCmd ?? "none"}`);
		}
		traj.gsStateAtSave = traj.lastState ? { ...traj.lastState } : null;
		const reply = await client.rconAwait("save probe").catch(() => null);
		notes.push(`save reply: ${JSON.stringify(reply)}`);
		// 等文件落盘。
		const saveDir = path.join(dir, "save");
		let file = "";
		for (let i = 0; i < 60; i++) {
			const files = existsSync(saveDir)
				? readdirSync(saveDir).filter((f) => f.endsWith(".sav"))
				: [];
			if (files.length > 0) {
				file = path.join(saveDir, files[0]!);
				break;
			}
			await new Promise((r) => setTimeout(r, 500));
		}
		traj.savePath = file || null;
		if (!file) notes.push("no savegame file appeared");
	}

	if (opts.commandAtDay !== null && opts.sendCommand && !opts.commandBeforeSave) {
		const ok = await waitForDay(opts.commandAtDay, 600_000);
		if (!ok) notes.push(`never reached day ${opts.commandAtDay}`);
		traj.dayAtCommand = day();
		traj.moneyAtCommand = money();
		if (opts.command) {
			// `build_bus_route` 的回执是 **ack**（不带 id）⇒ 不能等 answer ⇒
			// 发出去就好，回执从 GS 事件里收（acks）。
			// `company` 是 GS 的硬要求（否则它具名拒绝"no company"）⇒ 带上
			// executor 的公司 id（0，与 harness 的默认一致）。
			client.gameScript(JSON.stringify({ cmd: opts.command, company: 0 }));
			for (let i = 0; i < 40 && traj.acks.length === 0; i++) {
				await new Promise((r) => setTimeout(r, 250));
			}
			notes.push(`command ${opts.command}; acks=${traj.acks.length}`);
		}
	}

	await waitForDay(opts.untilDay, 900_000);

	clearInterval(poll);
	clearInterval(datePoll);
	client.close();
	await pm.stop();
	// 档位由判据模块算（唯一实现；单测在 test/unit/money-levels.test.ts）。
	traj.moneyLevels = moneyLevels(traj.samples);
	return traj;
}

/** 逐日比较（**受采样相位影响**，只作参考，不当判据）。 */
function compare(a: Trajectory, b: Trajectory): {
	same: boolean;
	firstDivergence: { day: number; a: number; b: number } | null;
	comparedDays: number;
} {
	const days = [...a.moneyByDay.keys()].filter((d) => b.moneyByDay.has(d)).sort((x, y) => x - y);
	let first: { day: number; a: number; b: number } | null = null;
	for (const d of days) {
		const av = a.moneyByDay.get(d)!;
		const bv = b.moneyByDay.get(d)!;
		if (av !== bv) {
			first = { day: d, a: av, b: bv };
			break;
		}
	}
	return { same: first === null, firstDivergence: first, comparedDays: days.length };
}

async function main(): Promise<void> {
	if (existsSync(args.dataDir)) rmSync(args.dataDir, { recursive: true });
	mkdirSync(args.dataDir, { recursive: true });
	const dirA = path.join(args.dataDir, "a");
	const dirB = path.join(args.dataDir, "b");

	console.log(
		`[probe] checkpoint day ${args.checkpointDay}, window ${args.windowDays} days, ` +
			`command ${args.command ?? "(none)"}, seed ${args.seed}`,
	);

	const a = await runPhase({
		dir: dirA,
		adminPort: args.adminPort,
		gamePort: args.gamePort,
		seed: args.seed,
		loadSavegame: null,
		saveAtDay: args.checkpointDay,
		commandAtDay: args.checkpointDay,
		command: args.command,
		commandBeforeSave: args.commandBeforeSave,
		sendCommand: true,
		untilDay: args.checkpointDay + args.windowDays,
	});
	console.log(`[probe] run A: ${a.moneyByDay.size} day samples, save=${a.savePath ?? "none"}`);

	if (!a.savePath) {
		console.error("[probe] FAILED: no savegame was written; the fork cannot even be attempted");
		process.exit(1);
	}
	const saveB = path.join(dirB, "save", path.basename(a.savePath));
	mkdirSync(path.dirname(saveB), { recursive: true });
	copyFileSync(a.savePath, saveB);

	const b = await runPhase({
		dir: dirB,
		adminPort: args.adminPort + 2,
		gamePort: args.gamePort + 2,
		seed: args.seed,
		loadSavegame: saveB,
		saveAtDay: null,
		commandAtDay: args.checkpointDay,
		command: args.command,
		sendCommand: !args.commandBeforeSave,
		commandBeforeSave: false,
		untilDay: args.checkpointDay + args.windowDays,
	});
	console.log(`[probe] run B: ${b.moneyByDay.size} day samples`);

	// **第三轮**：同一个存档再读一次（另一个目录、另一个端口）⇒
	//   B 与 C 一致 ⇒ 引擎的模拟本身是确定的，分歧来自**存档没存全**；
	//   B 与 C 也不一致 ⇒ 模拟/读档本身不确定（同存档同命令也给不出同轨迹）。
	const dirC = path.join(args.dataDir, "c");
	const saveC = path.join(dirC, "save", path.basename(a.savePath));
	mkdirSync(path.dirname(saveC), { recursive: true });
	copyFileSync(a.savePath, saveC);
	const c = await runPhase({
		dir: dirC,
		adminPort: args.adminPort + 4,
		gamePort: args.gamePort + 4,
		seed: args.seed,
		loadSavegame: saveC,
		saveAtDay: null,
		commandAtDay: args.checkpointDay,
		command: args.command,
		sendCommand: !args.commandBeforeSave,
		commandBeforeSave: false,
		untilDay: args.checkpointDay + args.windowDays,
	});
	console.log(`[probe] run C: ${c.moneyByDay.size} day samples`);

	const cmp = compare(a, b);
	const cmpBC = compare(b, c);
	const cmpAC = compare(a, c);
	// **判据 = 资金档位**（钱经过的取值集合 + 顺序），不是"逐日钱"。
	//
	// 为什么：钱只在施工事件那一刻变；轮询按墙钟走 ⇒ 一笔钱落在"哪一天"
	// 取决于**采样相位**（日期包与经济包各自到达）⇒ 同一局两次读档可以在
	// 同一天差出一个施工事件的金额。档位集合与相位无关 ⇒ 可比。
	const lvBC = compareMoneyLevels(b.moneyLevels, c.moneyLevels);
	const lvAC = compareMoneyLevels(a.moneyLevels, c.moneyLevels);
	const lvAB = compareMoneyLevels(a.moneyLevels, b.moneyLevels);
	// 判词要能区分三种情况：
	//   档位一致 ⇒ 模拟可复现（同存档 ⇒ 同一资金轨迹）；
	//   B ≢ C（同一份存档读两次都不同）⇒ 连"读两次同一存档"都不一致 ⇒
	//     反事实 fork 不成立（前提被证伪）。
	//   B ≡ C 但 A ≢ B ⇒ 差异来自"存/读档"这一侧，不是模拟本身。
	const verdict = !lvBC.measured
		? "NOT MEASURED (no money readings in one or both runs => nothing to compare)"
		: !lvBC.powerful
			? "NOT MEASURED (the money never changed in one or both runs => the comparison has no power; widen the window)"
			: lvBC.same && lvBC.sequenceSame
			? "same savegame => same money trajectory (levels identical, same order)"
			: lvBC.same
				? "same level SET but different order (sampling order differs; the money values themselves match)"
				: "DIVERGED (two loads of the same savegame produced different money levels => not reproducible)";
	const report = {
		verdict,
		levelComparison: {
			bVsC: { measured: lvBC.measured, powerful: lvBC.powerful, same: lvBC.same, onlyInB: lvBC.onlyInA, onlyInC: lvBC.onlyInB, sequenceSame: lvBC.sequenceSame, firstSequenceDiff: lvBC.firstSequenceDiff },
			aVsC: { measured: lvAC.measured, powerful: lvAC.powerful, same: lvAC.same, onlyInA: lvAC.onlyInA, onlyInC: lvAC.onlyInB, sequenceSame: lvAC.sequenceSame },
			aVsB: { measured: lvAB.measured, powerful: lvAB.powerful, same: lvAB.same, onlyInA: lvAB.onlyInA, onlyInB: lvAB.onlyInB, sequenceSame: lvAB.sequenceSame },
		},
		levels: { a: a.moneyLevels, b: b.moneyLevels, c: c.moneyLevels },
		finalMoney: { a: a.moneyLevels[a.moneyLevels.length - 1] ?? null, b: b.moneyLevels[b.moneyLevels.length - 1] ?? null, c: c.moneyLevels[c.moneyLevels.length - 1] ?? null },
		sampleCounts: { a: a.samples.length, b: b.samples.length, c: c.samples.length },
		perDayComparison: {
			note: "phase-sensitive (a payment can be attributed to either side of a day boundary) => diagnostic only, not the verdict",
			aVsB: { comparedDays: cmp.comparedDays, firstDivergence: cmp.firstDivergence },
			bVsC: { comparedDays: cmpBC.comparedDays, firstDivergence: cmpBC.firstDivergence },
			aVsC: { comparedDays: cmpAC.comparedDays, firstDivergence: cmpAC.firstDivergence },
		},
		moneyAtCommand: { a: a.moneyAtCommand, b: b.moneyAtCommand },
		dayAtCommand: { a: a.dayAtCommand, b: b.dayAtCommand },
		gsStateAfterLoad: b.gsSeen,
		firstAdminSeen: { a: a.firstAdminSeen, b: b.firstAdminSeen, c: c.firstAdminSeen },
		firstGsState: {
			a: { lastCmd: a.firstLastCmd, signs: a.firstSignCount },
			b: { lastCmd: b.firstLastCmd, signs: b.firstSignCount },
			c: { lastCmd: c.firstLastCmd, signs: c.firstSignCount },
		},
		gsState: {
			atSave: a.gsStateAtSave,
			aLast: a.lastState ?? null,
			bFirst: b.firstAdminSeen === undefined ? null : { adminSeen: b.firstAdminSeen, lastCmd: b.firstLastCmd ?? null, signCount: b.firstSignCount ?? null },
			bLast: b.lastState ?? null,
			cFirst: c.firstAdminSeen === undefined ? null : { adminSeen: c.firstAdminSeen, lastCmd: c.firstLastCmd ?? null, signCount: c.firstSignCount ?? null },
		},
		acks: { a: a.acks, b: b.acks },
		execStages: { a: a.execStages, b: b.execStages, c: c.execStages },
		notes: { a: a.notes, b: b.notes },
	};
	writeFileSync(
		path.join(args.dataDir, "determinism-report.json"),
		`${JSON.stringify(report, null, "\t")}\n`,
		"utf8",
	);
	console.log(JSON.stringify(report, null, "\t"));
}

await main();
