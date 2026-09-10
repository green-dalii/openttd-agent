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

import net from "node:net";
import { access } from "node:fs/promises";
import { loadConfig, ConfigError, type Config } from "../config.js";
import { OpenTTDProcessManager } from "../game/process-manager.js";
import {
	AdminPacketType,
	AdminUpdateFrequency,
	AdminUpdateType,
	ALL_COMPANIES,
	FrameWriter,
	FrameStreamParser,
} from "../game/admin-protocol.js";
import { handleServerPacket } from "../game/observer.js";
import { runWatch } from "../game/runner.js";
import { runV02 } from "../game/v02-runner.js";
import { runAgent } from "../agent/runner.js";
import { applyLlmSettingsFile } from "../agent/llm-settings.js";

interface CliArgs {
	mode: "probe" | "dry-run" | "watch" | "v02" | "agent" | "help";
	year?: number;
	seed?: number;
	timeoutMs: number;
	aiName?: string;
	webPort?: number;
	demoSeconds?: number;
	llmBaseUrl?: string;
	llmApiKey?: string;
	llmModel?: string;
	llmApi?: string;
}

function parseArgs(argv: string[]): CliArgs {
	let mode: CliArgs["mode"] = "help";
	let year: number | undefined;
	let seed: number | undefined;
	let timeoutMs = 15_000;
	let aiName: string | undefined;
	let webPort: number | undefined;
	let demoSeconds: number | undefined;
	let llmBaseUrl: string | undefined;
	let llmApiKey: string | undefined;
	let llmModel: string | undefined;
	let llmApi: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		switch (a) {
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
			case "-h":
			case "--help":
				mode = "help";
				break;
			default:
				throw new ConfigError(`unknown option: ${a}`);
		}
	}
	return { mode, year, seed, timeoutMs, aiName, webPort, demoSeconds, llmBaseUrl, llmApiKey, llmModel, llmApi };
}

function parseIntNum(v: string | undefined, label: string): number {
	const n = Number(v);
	if (!Number.isInteger(n)) throw new ConfigError(`${label} requires integer, got "${v}"`);
	return n;
}

const USAGE = `openttd-agent — OpenTTD Admin Port probe / runner

Usage:
  pnpm run cli --dry-run                Print resolved config, exit (no spawn)
  pnpm run cli --probe [opts]           Start dedicated server, admin-join,
                                         poll date + company economy, rcon pause,
                                         print normalized events, exit.
  pnpm run cli --watch [opts]           Start server + AI, long-lived observer
                                         with live Web dashboard, Ctrl-C to stop.
  pnpm run cli --v02 [opts]             v0.2 decision-loop demo: deploy BridgeV1 GS
                                         + ExecutorV1 AI, drive a demo blueprint,
                                         Ctrl-C or --demo-seconds N to stop.
  pnpm run cli --agent [opts]           v0.2.1 agent brain: boot game + BridgeV1 GS
                                         + ExecutorV1, then let the pi-agent-core
                                         brain decide (faux provider by default) and
                                         observe construction (--demo-seconds N).
  --year N           start year (default 1950)
  --seed N           map seed (default random)
  --timeout-ms N     probe: max wait for first economy (default 15000)
  --ai NAME          watch: AI to start as observed company (default CPU)
  --web-port N       watch/agent: dashboard port (default ephemeral)
  --llm-base-url U   agent: OpenAI-compatible base URL (e.g. https://api.openai.com/v1)
  --llm-key K        agent: API key (also LLM_API_KEY / OPENAI_API_KEY)
  --llm-model M      agent: model id (e.g. gpt-4o-mini, deepseek-chat)
  --llm-api A        agent: streaming API (openai-completions|anthropic-messages)
  --help             this help

Env: OPENTTD_BINARY, OPENTTD_DATA_DIR, OPENTTD_ADMIN_PORT/PASSWORD,
     OPENTTD_GAME_PORT, OPENTTD_START_YEAR, OPENTTD_SEED, OPENTTD_MAP_SIZE,
     OPENTTD_AI_LIST.
`;

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	if (args.mode === "help") {
		console.log(USAGE);
		return 0;
	}
	const overrides: Record<string, string> = {};
	if (args.year !== undefined) overrides.OPENTTD_START_YEAR = String(args.year);
	if (args.seed !== undefined) overrides.OPENTTD_SEED = String(args.seed);
	if (args.llmBaseUrl !== undefined) overrides.LLM_BASE_URL = args.llmBaseUrl;
	if (args.llmApiKey !== undefined) overrides.LLM_API_KEY = args.llmApiKey;
	if (args.llmModel !== undefined) overrides.LLM_MODEL = args.llmModel;
	if (args.llmApi !== undefined) overrides.LLM_API = args.llmApi;
	const cfg = applyLlmSettingsFile(loadConfig({ ...process.env, ...overrides }));

	if (args.mode === "dry-run") {
		console.log(JSON.stringify(redact(cfg), null, 2));
		return 0;
	}
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
			return await runV02(cfg, { demoSeconds: args.demoSeconds });
		} catch (e) {
			console.error("[v02] ERROR:", e instanceof Error ? e.message : e);
			return 1;
		}
	}
	if (args.mode === "agent") {
		try {
			return await runAgent(cfg, {
				seconds: args.demoSeconds ?? 180,
				// Agent mode also serves the live dashboard (telemetry). Undefined
				// when not requested => CLI-only run.
				webPort: args.webPort,
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
	let client: AdminProbeClient | null = null;

	try {
		await mgr.ensureSandboxConfig();
		console.log("[probe] sandbox config ready");
		await mgr.start();
		console.log("[probe] dedicated server spawned");

		console.log(`[probe] waiting for admin port ...`);
		await mgr.waitForAdminPort(20_000);
		console.log("[probe] admin port open");

		client = new AdminProbeClient(cfg);
		client.onEvent = (ev) => {
			outcome.events.push(ev);
			console.log(`[event] ${JSON.stringify(ev)}`);
		};
		client.onEconomy = () => {
			outcome.sawEconomy = true;
		};

		await client.connect();
		client.join();
		client.subscribeDateMonthly();
		client.subscribeEconomyMonthly();
		console.log("[probe] joined + subscribed, waiting for data ...");

		// Stream until we see >=1 economy OR deadline.
		const done = await client.drainUntil(
			() => outcome.sawEconomy,
			timeoutMs,
		);
		if (!done && !outcome.sawEconomy) {
			// No company on a fresh map — still a pass for the probe (env is up).
			console.log(
				`[probe] note: no company economy within ${timeoutMs}ms (fresh map has no company) — env OK`,
			);
			outcome.reason = "no-company-on-fresh-map";
		} else {
			outcome.reason = outcome.sawEconomy ? "economy-observed" : "no-economy";
		}

		client.rcon("pause");
		console.log("[probe] rcon pause sent");
		await client.waitForRconEnd(3000);

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

/**
 * Minimal inline admin client (join / subscribe / poll / rcon / read loop).
 * Kept deliberately small for the probe; a fuller client lands in v0.1.
 */
class AdminProbeClient {
	onEvent?: (ev: unknown) => void;
	onEconomy?: () => void;

	private sock: net.Socket | null = null;
	private parser = new FrameStreamParser();
	private seq = 0;
	private rconEndWaiters: (() => void)[] = [];

	async connect(): Promise<void> {
		const { adminHost, adminPort } = this.cfg;
		await new Promise<void>((resolve, reject) => {
			const sock = net.connect({ host: adminHost, port: adminPort });
			sock.setNoDelay(true);
			this.sock = sock;
			const timer = setTimeout(() => reject(new Error("admin connect timeout")), 5000);
			sock.once("connect", () => {
				clearTimeout(timer);
				resolve();
			});
			sock.once("error", (e) => {
				clearTimeout(timer);
				reject(e);
			});
		});
		this.sock!.on("data", (chunk) => this.onData(new Uint8Array(chunk)));
		this.sock!.on("error", () => this.sock?.destroy());
		this.sock!.on("close", () => this.notifyRconEnd());
	}

	join(): void {
		this.send(AdminPacketType.AdminJoin, (w) =>
			w.str(this.cfg.adminPassword).str("openttd-agent-probe").str("0.0.1"),
		);
	}

	subscribeDateMonthly(): void {
		this.send(AdminPacketType.AdminUpdateFrequency, (w) =>
			w.uint16(AdminUpdateType.Date).uint16(AdminUpdateFrequency.Monthly),
		);
	}

	subscribeEconomyMonthly(): void {
		this.send(AdminPacketType.AdminUpdateFrequency, (w) =>
			w.uint16(AdminUpdateType.CompanyEconomy).uint16(AdminUpdateFrequency.Monthly),
		);
	}

	pollDate(): void {
		this.send(AdminPacketType.AdminPoll, (w) => w.uint8(AdminUpdateType.Date).uint32(0));
	}

	pollEconomyAll(): void {
		this.send(AdminPacketType.AdminPoll, (w) =>
			w.uint8(AdminUpdateType.CompanyEconomy).uint32(ALL_COMPANIES),
		);
	}

	rcon(cmd: string): void {
		this.send(AdminPacketType.AdminRemoteConsoleCommand, (w) => w.str(cmd));
	}

	/**
	 * Read until predicate true or timeout.
	 * @returns true if predicate became true before timeout.
	 */
	async drainUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (!pred()) {
			if (Date.now() > deadline) return false;
			await sleep(150);
		}
		return true;
	}

	waitForRconEnd(timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.rconEndWaiters = this.rconEndWaiters.filter((w) => w !== done);
				resolve(false);
			}, timeoutMs);
			const done = () => {
				clearTimeout(timer);
				this.rconEndWaiters = this.rconEndWaiters.filter((w) => w !== done);
				resolve(true);
			};
			this.rconEndWaiters.push(done);
		});
	}

	close(): void {
		// No AdminQuit: OpenTTD 15.0 aborts in the server's admin-socket close
		// path if we send Quit then destroy (SPEC §10.7). EOF from destroy is safe.
		this.sock?.destroy();
		this.sock = null;
	}

	// -- internals -------------------------------------------------------

	private send(type: number, fill: (w: FrameWriter) => void): void {
		const w = new FrameWriter();
		fill(w);
		this.sock?.write(Buffer.from(w.build(type)));
	}

	private onData(chunk: Uint8Array): void {
		for (const pkt of this.parser.push(chunk)) {
			this.dispatch(pkt);
		}
	}

	private dispatch(pkt: { type: number; payload: Uint8Array; frame: Uint8Array }): void {
		switch (pkt.type) {
			case AdminPacketType.ServerProtocol:
				return; // ignore
			case AdminPacketType.ServerWelcome:
				// Authenticated. Ask for current date + all-company economy.
				this.pollDate();
				this.pollEconomyAll();
				return;
			case AdminPacketType.ServerRconEnd:
				this.notifyRconEnd();
				return;
			default: {
				const ev = handleServerPacket(pkt, this.seq++, Date.now());
				if (!ev) return;
				this.onEvent?.(ev);
				if (ev.kind === "company_economy") this.onEconomy?.();
			}
		}
	}

	private notifyRconEnd(): void {
		const waiters = [...this.rconEndWaiters];
		this.rconEndWaiters = [];
		for (const w of waiters) w();
	}

	private readonly cfg: Config;

	constructor(cfg: Config) {
		this.cfg = cfg;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

main()
	.then((code) => process.exit(code))
	.catch((e) => {
		console.error("FATAL:", e instanceof Error ? e.message : e);
		process.exit(1);
	});
