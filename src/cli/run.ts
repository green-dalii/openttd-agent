/* eslint-disable no-console */
/**
 * openttd-agent CLI — v0.0.1 entry point.
 *
 * 职责: 解析 CLI flags/env -> config; `--probe` 起 dedicated server 并完成一次
 *   admin 连接+订阅+轮询+rcon 的最小闭环 (集成 seam); `--dry-run` 只打印配置。
 * 事实来源: SPEC §2 协议 (AdminJoin 明文 = type 0; update freq type 2;
 *   poll type 3; rcon type 5)。已验证 OpenTTD 15 行为。
 * 禁止: 在本文件之外做协议假设; 崩溃不清理子进程。
 */

import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadConfig, ConfigError, type Config } from "../config.js";
import { OpenTTDProcessManager } from "../game/process-manager.js";
import { AdminUpdateFrequency, AdminUpdateType } from "../game/admin-protocol.js";
import { AdminClient } from "../game/admin-client.js";
import { runWatch } from "../game/runner.js";
import { formatPreflight, runPreflight } from "../agent/preflight.js";
import { runServe } from "../agent/serve.js";
import { APP_VERSION } from "../version.js";
import { runV02 } from "../game/v02-runner.js";
import { runAgent } from "../agent/runner.js";
import { applyLlmSettingsFile } from "../agent/llm-settings.js";

interface CliArgs {
	mode: "probe" | "dry-run" | "watch" | "v02" | "agent" | "serve" | "version" | "help";
	/** v02 baseline probe: after construction, request this many vehicles on the demo route. */
	addVehicles?: number;
	/** M3-1 oracle probe: request a LOWER fleet size and observe the fleet shrink (v02 only). */
	shrinkTo?: number;
	/** M3-2a probe: retire this job after the fleet probe (0 = off). */
	retireJob?: number;
	/** M3-2c probe: queue a second route so the first becomes non-current. */
	secondRoute?: boolean;
	/** NEXT-4 事实探针：GS 能否买车（决定动作总线的车道数）。 */
	probeGsBuy?: boolean;
	/** AB-4a：GS 单机建线 + 运营（NEXT-4 验收）。 */
	probeGsRoute?: boolean;
	/** Agent: pause the world while the model thinks + acts (verified freeze). */
	freeze?: boolean;
	year?: number;
	seed?: number;
	timeoutMs: number;
	aiName?: string;
	webPort?: number;
	demoSeconds?: number;
	/**
	 * Episode horizon in SIMULATED game days (G1, SPEC §10.68). Preferred over
	 * `--demo-seconds`, which becomes the wall-clock safety cap.
	 */
	gameDays?: number;
	/** S1/G4: "prebuilt" builds a route before the measurement window opens. */
	scenario?: "freeform" | "prebuilt";
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
	llmApi?: string;
	/** D4/S6: provider id (catalog) - was env-only before. */
	llmProvider?: string;
	/** D4/S6: thinking level (off|minimal|low|medium|high|xhigh|max). */
	thinking?: string;
	/** D4/S6: per-decision tool-call budget. */
	toolBudget?: number;
	/** P4: stop the run after this many tokens (env LLM_TOKEN_LIMIT). */
	llmTokenLimit?: number;
	/** P4: stop the run after this much spend (env LLM_COST_LIMIT). */
	llmCostLimit?: string;
	/** Explicitly allow the scripted (non-LLM) demo brain in agent mode. */
	offlineDemo?: boolean;
	/** Seed the agent with cross-game memory. Default: on (self-evolution). */
	injectMemory?: boolean;
	/** Skip non-safety preflight checks (ports/gsFiles) for debugging. */
	skipPreflight?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
	let mode: CliArgs["mode"] = "help";
	let year: number | undefined;
	let seed: number | undefined;
	/** D4/S6: scaffold knobs, applied as env overrides (validated at config load). */
	let llmProvider: string | undefined;
	let thinking: string | undefined;
	let toolBudget: number | undefined;
	let llmTokenLimit: number | undefined;
	let llmCostLimit: string | undefined;
	let timeoutMs = 15_000;
	let aiName: string | undefined;
	let webPort: number | undefined;
	let demoSeconds: number | undefined;
	let gameDays: number | undefined;
	let scenario: "freeform" | "prebuilt" | undefined;
	let addVehicles: number | undefined;
	// M3-1: the oracle probe verifies fleet size in BOTH directions (environment fact:
	// `V:<count>` below the current fleet sells the newest clones).
	let shrinkTo: number | undefined;
	let retireJob: number | undefined;
	let secondRoute = false;
	let probeGsBuy = false;
	let probeGsRoute = false;
	let freeze = false;
	let llmBaseUrl: string | undefined;
	let llmApiKey: string | undefined;
	let llmModel: string | undefined;
	let llmApi: string | undefined;
	let offlineDemo = false;
	let injectMemory = true;
	let skipPreflight = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		switch (a) {
			case "--serve":
				mode = "serve";
				break;
			case "--probe":
				mode = "probe";
				break;
			case "--watch":
				mode = "watch";
				break;
			case "--v02":
				mode = "v02";
				break;
			case "--agent":
				mode = "agent";
				break;
			case "--freeze":
				freeze = true;
				break;
			case "--add-vehicles":
				addVehicles = parseIntNum(argv[++i], "--add-vehicles");
				break;
			case "--second-route":
				secondRoute = true;
				break;
			case "--probe-gs-buy":
				probeGsBuy = true;
				break;
			case "--probe-gs-route":
				probeGsRoute = true;
				break;
			case "--retire-job":
				retireJob = parseIntNum(argv[++i], "--retire-job");
				break;
			case "--shrink-to":
				shrinkTo = parseIntNum(argv[++i], "--shrink-to");
				break;
			case "--scenario": {
				const v = argv[++i];
				if (v !== "freeform" && v !== "prebuilt") throw new Error(`--scenario must be freeform|prebuilt, got ${String(v)}`);
				scenario = v;
				break;
			}
			case "--game-days":
				gameDays = parseIntNum(argv[++i], "--game-days");
				break;
			case "--demo-seconds":
				demoSeconds = parseIntNum(argv[++i], "--demo-seconds");
				break;
			case "--llm-base-url":
				llmBaseUrl = argv[++i];
				break;
			case "--llm-key":
				llmApiKey = argv[++i];
				break;
			case "--llm-model":
				llmModel = argv[++i];
				break;
			case "--llm-api":
				llmApi = argv[++i];
				break;
			case "--llm-provider":
				llmProvider = argv[++i];
				break;
			case "--thinking":
				thinking = argv[++i];
				break;
			case "--tool-budget":
				toolBudget = parseIntNum(argv[++i], "--tool-budget");
				break;
			case "--llm-token-limit":
				llmTokenLimit = parseIntNum(argv[++i], "--llm-token-limit");
				break;
			case "--llm-cost-limit":
				// Kept as text: resolveRunLimits validates (and rejects 0 / junk)
				// so the rule lives in one place.
				llmCostLimit = argv[++i];
				break;
			case "--offline-demo":
				offlineDemo = true;
				break;
			case "--no-memory":
				// Control arm of the M3 experiment: same seed, no cross-game memory.
				injectMemory = false;
				break;
			case "--skip-preflight":
				skipPreflight = true;
				break;
			case "--dry-run":
				mode = "dry-run";
				break;
			case "--year":
				year = parseIntNum(argv[++i], "--year");
				break;
			case "--seed":
				seed = parseIntNum(argv[++i], "--seed");
				break;
			case "--timeout-ms":
				timeoutMs = parseIntNum(argv[++i], "--timeout-ms");
				break;
			case "--ai":
				aiName = argv[++i];
				break;
			case "--web-port":
				webPort = parseIntNum(argv[++i], "--web-port");
				break;
			case "--version":
			case "-V":
				mode = "version";
				break;
			case "-h":
			case "--help":
				mode = "help";
				break;
			default:
				throw new ConfigError(`unknown option: ${a}`);
		}
	}
	return {
		// Every parsed flag MUST appear here. Forgetting one does not fail to
		// compile: `args.foo` is simply undefined, so the flag silently does
		// nothing while the help text still advertises it. Fifth instance of
		// "parsed but dropped": 2026-09-12 (MEMORY.md A5) x4, then 2026-09-19
		// (`--probe-gs-buy`) - and that one happened WITH the guard test already
		// written, because the change was checked with `tsc` instead of the guard.
		// Run test/unit/cli-v02.test.ts after touching any flag, not tsc.
		mode, year, seed, timeoutMs, aiName, webPort, demoSeconds, gameDays, scenario, addVehicles, shrinkTo, retireJob, secondRoute, freeze, probeGsBuy, probeGsRoute,
		llmBaseUrl, llmApiKey, llmModel, llmApi, llmProvider, thinking, toolBudget, llmTokenLimit, llmCostLimit,
		offlineDemo, skipPreflight,
		injectMemory,
	};
}

function parseIntNum(v: string | undefined, label: string): number {
	const n = Number(v);
	if (!Number.isInteger(n)) throw new ConfigError(`${label} requires integer, got "${v}"`);
	return n;
}

const USAGE = `openttd-agent — OpenTTD Admin Port probe / runner

Usage:
  pnpm run cli --dry-run                Print resolved config, exit (no spawn)
  pnpm run cli --serve [opts]           Long-lived dashboard with run controls:
                                         start/stop/pause/resume from the page.
  pnpm run cli --probe [opts]           Start dedicated server, admin-join,
                                         poll date + company economy, rcon pause,
                                         print normalized events, exit.
  pnpm run cli --watch [opts]           Start server + AI, long-lived observer
                                         with live Web dashboard, Ctrl-C to stop.
  pnpm run cli --v02 [opts]             v0.2 decision-loop demo: deploy BridgeV1 GS
                                         + ExecutorV1 AI, drive a demo blueprint,
                                         Ctrl-C or --demo-seconds N to stop.
  pnpm run cli --agent [opts]           Agent brain: boot game + BridgeV1 GS
                                         + ExecutorV1, then let the pi-agent-core
                                         brain decide (requires a configured LLM;
                                         see Startup gate below) and observe
                                         construction (--demo-seconds N).
                                         --no-memory      Start from zero: do NOT seed the
                                                          agent with cross-game memory.
                                                          (Memory is ON by default - it is
                                                          how the agent self-evolves.)
  --year N           start year (default 1950)
  --seed N           map seed (default random)
  --timeout-ms N     probe: max wait for first economy (default 15000)
  --ai NAME          watch: AI to start as observed company (default CPU)
  --web-port N       watch/agent: dashboard port (default ephemeral)
  --llm-base-url U   agent: OpenAI-compatible base URL (e.g. https://api.openai.com/v1)
  --llm-key K        agent: API key (also LLM_API_KEY / OPENAI_API_KEY)
  --llm-model M      agent: model id (e.g. gpt-4o-mini, deepseek-chat)
  --llm-api A        agent: streaming API (openai-completions|anthropic-messages)
  --llm-provider P   agent: provider id (pi-ai catalog, e.g. openai)
  --thinking L       agent: thinking level off|minimal|low|medium|high|xhigh|max (default off)
  --tool-budget N    agent: tool calls allowed per decision (default 12)
  --llm-token-limit N  agent: stop the run once total tokens reach N (default none)
  --llm-cost-limit C   agent: stop the run once spend reaches C (default none;
                       requires a model with a price table)
  --version, -V      print the version and exit
  --help             this help

  --offline-demo     agent: allow the scripted demo brain (no real LLM)
  --skip-preflight   skip non-safety preflight checks (ports/gsFiles)
  OPENTTD_AI_LIST.

Env: OPENTTD_BINARY, OPENTTD_DATA_DIR, OPENTTD_ADMIN_PORT/PASSWORD,
     OPENTTD_GAME_PORT, OPENTTD_START_YEAR, OPENTTD_SEED, OPENTTD_MAP_SIZE,
     OPENTTD_AI_LIST.

Startup gate (docs/STARTUP-AND-LIFECYCLE.md):
  Every mode runs a preflight first. Agent mode REQUIRES a configured AND
  reachable LLM; without one it refuses to start instead of silently running
  a scripted simulation.
`;

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	// Self-describing logs: a bug report must say which version produced it.
	if (args.mode === "help") {
		console.log(USAGE);
		return 0;
	}
	if (args.mode === "version") {
		console.log(`openttd-agent ${APP_VERSION}`);
		return 0;
	}
	const overrides: Record<string, string> = {};
	if (args.year !== undefined) overrides.OPENTTD_START_YEAR = String(args.year);
	if (args.seed !== undefined) overrides.OPENTTD_SEED = String(args.seed);
	if (args.llmBaseUrl !== undefined) overrides.LLM_BASE_URL = args.llmBaseUrl;
	if (args.llmApiKey !== undefined) overrides.LLM_API_KEY = args.llmApiKey;
	if (args.llmModel !== undefined) overrides.LLM_MODEL = args.llmModel;
	if (args.llmApi !== undefined) overrides.LLM_API = args.llmApi;
	// D4/S6: scaffold knobs (resolveScaffoldKnobs validates; bad values throw).
	if (args.llmProvider !== undefined) overrides.LLM_PROVIDER = args.llmProvider;
	if (args.thinking !== undefined) overrides.LLM_THINKING = args.thinking;
	if (args.toolBudget !== undefined) overrides.LLM_TOOL_BUDGET = String(args.toolBudget);
	// P4: spend caps (resolveRunLimits validates in the runner).
	if (args.llmTokenLimit !== undefined) overrides.LLM_TOKEN_LIMIT = String(args.llmTokenLimit);
	if (args.llmCostLimit !== undefined) overrides.LLM_COST_LIMIT = args.llmCostLimit;
	const cfg = applyLlmSettingsFile(loadConfig({ ...process.env, ...overrides }));

	if (args.mode === "dry-run") {
		console.log(JSON.stringify(redact(cfg), null, 2));
		return 0;
	}

	// Serve mode owns its own gate per run (see runServe): it must stay up even
	// when nothing can start yet, so the user can fix the config in the browser.
	if (args.mode === "serve") {
		const serve = await runServe(cfg, {
			webPort: args.webPort,
			offlineDemo: args.offlineDemo,
			skipPreflight: args.skipPreflight,
			runOptions: {
				// Only what the CLI can actually express today. Decision cadence is
				// not exposed as a flag yet (it is a library option); when it is,
				// it must be added here too or the Start button will silently keep
				// using defaults - exactly the bug this forwarding fixes.
				offlineDemo: args.offlineDemo,
				injectMemory: args.injectMemory,
				seconds: args.demoSeconds,
			},
		});
		console.log("[serve] Ctrl-C to stop");
		await serve.done;
		await serve.stop();
		return 0;
	}

	// --- startup gate (docs/STARTUP-AND-LIFECYCLE.md §2) ---
	// Runs BEFORE any side effect: no game process, no session record, no files
	// beyond a writability probe. A failed check refuses to start rather than
	// falling back to a silent scripted run.
	const pre = await runPreflight(cfg, {
		mode: args.mode,
		offlineDemo: args.offlineDemo,
		skipUnsafe: args.skipPreflight,
	});
	console.log(`[preflight] openttd-agent ${APP_VERSION}`);
	console.log(formatPreflight(pre));
	if (!pre.ok) return 1;
	if (args.mode === "watch") {
		try {
			await runWatch(cfg, {
				aiName: args.aiName,
				webPort: args.webPort,
			});
			return 0;
		} catch (e) {
			console.error("[watch] ERROR:", e instanceof Error ? e.message : e);
			return 1;
		}
	}
	if (args.mode === "v02") {
		try {
			return await runV02(cfg, {
				demoSeconds: args.demoSeconds,
				gameDays: args.gameDays,
				addVehicles: args.addVehicles,
				shrinkTo: args.shrinkTo,
				retireJob: args.retireJob,
				secondRoute: args.secondRoute,
				probeGsBuy: args.probeGsBuy,
				probeGsRoute: args.probeGsRoute,
			});
		} catch (e) {
			console.error("[v02] ERROR:", e instanceof Error ? e.message : e);
			return 1;
		}
	}
	if (args.mode === "agent") {
		try {
			return await runAgent(cfg, {
				seconds: args.demoSeconds ?? 180,
				gameDays: args.gameDays,
				scenario: args.scenario,
				// Agent mode also serves the live dashboard (telemetry). Undefined
				// when not requested => CLI-only run.
				webPort: args.webPort,
				// These two MUST be forwarded. Both are read by the preflight gate
				// directly from `args`, so omitting them here produced a gate that
				// approved a run the runner then refused: `--agent --offline-demo`
				// printed "running the explicit offline demo" and immediately threw
				// "no LLM configured". Third instance of this pattern (see
				// resolveRunOptions in serve.ts) - a flag the gate sees and the
				// runner does not.
				offlineDemo: args.offlineDemo,
				injectMemory: args.injectMemory,
				// Verified freeze (SPEC §10.59). Forwarded for the same reason the
				// two above are - a flag the CLI parses and the runner never hears
				// about is a flag that silently does nothing.
				freeze: args.freeze,
			});
		} catch (e) {
			console.error("[agent] ERROR:", e instanceof Error ? e.message : e);
			return 1;
		}
	}
	return runProbe(cfg, args.timeoutMs);
}

/** Config minus secret, for printing. */
function redact(cfg: Config): Record<string, unknown> {
	const o: Record<string, unknown> = { ...cfg };
	o.adminPassword = "***";
	return o;
}

/* ------------------------------------------------------------------ *
 * Probe: spawn server -> join admin -> poll -> rcon pause -> report
 * ------------------------------------------------------------------ */

interface ProbeOutcome {
	ok: boolean;
	reason: string;
	events: unknown[];
	sawEconomy: boolean;
}

async function runProbe(cfg: Config, timeoutMs: number): Promise<number> {
	console.log(`[probe] admin=${cfg.adminHost}:${cfg.adminPort} game=:${cfg.gamePort}`);
	console.log(`[probe] dataDir=${cfg.dataDir} seed=${cfg.seed} year=${cfg.startYear}`);

	try {
		await access(cfg.openttdBinary);
	} catch {
		console.error(`[probe] ERROR: binary not found at ${cfg.openttdBinary}`);
		console.error("[probe] Set OPENTTD_BINARY to the real binary path.");
		return 1;
	}

	const mgr = new OpenTTDProcessManager(cfg);
	mgr.onExit = (code) => {
		// Unexpected exit while we're still working => fail fast (but don't
		// throw from an event handler).
		console.log(`[probe] server exited code=${code}`);
	};

	const outcome: ProbeOutcome = { ok: false, reason: "", events: [], sawEconomy: false };
	let client: AdminClient | null = null;

	try {
		await mgr.ensureSandboxConfig();
		console.log("[probe] sandbox config ready");
		await mgr.start();
		console.log("[probe] dedicated server spawned");

		console.log(`[probe] waiting for admin port ...`);
		await mgr.waitForAdminPort(20_000);
		console.log("[probe] admin port open");

		client = new AdminClient({
			cfg,
			callbacks: {
				onEvent: (ev) => {
					outcome.events.push(ev);
					console.log(`[event] ${JSON.stringify(ev)}`);
					if (ev.kind === "company_economy") outcome.sawEconomy = true;
				},
			},
		});

		// 用**真客户端**握手（带界重试），不要用一次性 connect：D73 的教训——
		// 地图生成期间 admin 端口已经开着，一次性 connect 会被踢，"超时"只是表象。
		await client.connectAuthed(Math.min(timeoutMs, 20_000));
		// 探针要的是**月度**经济（默认订阅是季度）。
		client.subscribe(AdminUpdateType.CompanyEconomy, AdminUpdateFrequency.Monthly);
		console.log("[probe] joined + subscribed, waiting for data ...");

		// 等到第一份经济数据或超时（数据由客户端读走，经 onEvent 送达）。
		const deadline = Date.now() + timeoutMs;
		while (!outcome.sawEconomy && Date.now() < deadline) {
			await sleep(100);
		}
		if (!outcome.sawEconomy) {
			// No company on a fresh map — still a pass for the probe (env is up).
			console.log(
				`[probe] note: no company economy within ${timeoutMs}ms (fresh map has no company) — env OK`,
			);
			outcome.reason = "no-company-on-fresh-map";
		} else {
			outcome.reason = "economy-observed";
		}

		console.log("[probe] rcon pause sent");
		await client.rconAwait("pause", 3000);

		outcome.ok = true;
	} catch (e) {
		console.error("[probe] ERROR:", e instanceof Error ? e.message : e);
		outcome.reason = `error: ${e instanceof Error ? e.message : String(e)}`;
		outcome.ok = false;
	} finally {
		client?.close();
		await mgr.stop();
	}

	console.log(`[probe] result ok=${outcome.ok} reason=${outcome.reason} events=${outcome.events.length}`);
	return outcome.ok ? 0 : 1;
}


function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * Only run when this module IS the process entry point.
 *
 * Importing a module must not start a game: `test/unit/cli-v02.test.ts` imports
 * this file for `parseArgs`, and an unguarded `main()` made the import itself
 * call `process.exit` - which vitest reports as an unhandled rejection (a red
 * gate whose cause was eight files away from the failure).
 */
function isEntryPoint(): boolean {
	const arg = process.argv[1];
	if (!arg) return false;
	try {
		return import.meta.url === pathToFileURL(arg).href;
	} catch {
		return false;
	}
}

if (isEntryPoint()) {
	main()
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error("FATAL:", e instanceof Error ? e.message : e);
			process.exit(1);
		});
}
