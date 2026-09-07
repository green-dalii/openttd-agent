/* eslint-disable no-console */
/**
 * Runner — v0.1.0 long-lived observation loop.
 *
 * 职责: 编排完整观测闭环:
 *   spawn dedicated server -> start_ai -> AdminClient (subscribe/poll)
 *     -> WorldState (accumulate) -> WebServer (snapshot + live events)
 *   + 周期 poll company economy 保持曲线新鲜。
 * 事实来源: SPEC v0.1.0; spike 实测 start_ai -> company_economy 轮询即时返回。
 * 禁止: LLM 决策 (v0.2); 修改用户全局配置; 泄漏句柄 (stop 时全关)。
 */

import { loadConfig, ConfigError, type Config } from "../config.js";
import { OpenTTDProcessManager } from "../game/process-manager.js";
import { AdminClient } from "../game/admin-client.js";
import { WorldState } from "../game/world-state.js";
import { WebServer } from "../web/server.js";
import { AdminUpdateType } from "../game/admin-protocol.js";
import { aiInstalledNames, isAiInstalled } from "./ai-registry.js";

export interface WatchOptions {
	/** Bundled/user AI name to start as the observed company. Default "CPU". */
	aiName?: string;
	/** Company economy poll interval ms. Default 5000. */
	pollIntervalMs?: number;
	/** Web host. */
	webHost?: string;
	/** Web port; 0 = ephemeral. Default 0. */
	webPort?: number;
}

export interface WatchResult {
	exitCode: number;
	reason: string;
	companiesSeen: number;
	totalEvents: number;
	webPort: number;
	durationMs: number;
}

const DEFAULT_AI = "CPU";
const DEFAULT_POLL_MS = 5_000;

export async function runWatch(
	cfg: Config,
	opts: WatchOptions = {},
): Promise<WatchResult> {
	const started = Date.now();
	const aiName = opts.aiName ?? DEFAULT_AI;
	const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

	// Validate AI availability before spawning (fast fail).
	if (!isAiInstalled(cfg, aiName)) {
		const avail = aiInstalledNames(cfg).join(", ") || "(none found)";
		throw new ConfigError(
			`AI "${aiName}" not found in OpenTTD ai search path. Available: ${avail}`,
		);
	}

	const mgr = new OpenTTDProcessManager(cfg);
	const world = new WorldState();
	let client: AdminClient | null = null;
	let web: WebServer | null = null;
	let companiesSeen = 0;
	let stopRequested = false;

	// Control-C / SIGTERM handling: pause, save, clean shutdown.
	const shutdown = async (code: number) => {
		if (stopRequested) return;
		stopRequested = true;
		console.log("[watch] shutting down…");
		try {
			client?.rcon("pause");
			client?.rcon("save");
		} catch {
			/* best-effort */
		}
		await sleep(300);
		client?.close();
		if (web) await web.stop();
		await mgr.stop();
		process.exit(code);
	};
	process.once("SIGINT", () => void shutdown(0));
	process.once("SIGTERM", () => void shutdown(0));
	mgr.onExit = (code) => {
		if (!stopRequested && code !== 0) {
			console.error(`[watch] server exited unexpectedly code=${code}`);
		}
	};

	// --- start server ---
	console.log(`[watch] sandbox config…`);
	await mgr.ensureSandboxConfig();
	console.log(`[watch] spawning dedicated server (${cfg.dataDir})`);
	await mgr.start();
	console.log(`[watch] waiting for admin port ${cfg.adminHost}:${cfg.adminPort}…`);
	await mgr.waitForAdminPort(20_000);
	console.log(`[watch] admin port open.`);

	// --- admin client ---
	client = new AdminClient({
		cfg,
		callbacks: {
			onEvent: (ev) => {
				world.ingest(ev);
				web?.publishEvent(ev);
				if (ev.kind === "company_new") {
					companiesSeen++;
					console.log(`[watch] company created: id=${(ev.payload as { id: number }).id}`);
				}
			},
			onStatusChange: (s, d) => {
				if (s === "error") console.error(`[watch] admin client error: ${d ?? s}`);
			},
			onWelcome: () => {
				console.log(`[watch] admin authed.`);
				// Start the observed AI right after auth.
				client?.rcon(`start_ai "${aiName}"`);
				console.log(`[watch] rcon start_ai "${aiName}"`);
			},
		},
	});
	await client.connect(10_000);

	// --- web server (dashboard) ---
	web = new WebServer({
		host: opts.webHost ?? "127.0.0.1",
		port: opts.webPort ?? 0,
		getSnapshot: () => toWireSnapshot(world),
		onFirstClient: () => {
			web?.publishSnapshot(toWireSnapshot(world));
		},
	});
	await web.start();
	console.log(`[watch] dashboard: http://127.0.0.1:${web.actualPort}/`);

	// --- periodic economy poll (keeps curve fresh between quarters) ---
	const pollTimer = setInterval(() => {
		const snap = world.snapshot();
		for (const [id] of snap.companies) {
			client?.pollCompanyEconomy(id);
		}
		// Also poll date to keep "today" current.
		client?.poll(AdminUpdateType.Date, 0);
	}, pollIntervalMs);
	pollTimer.unref();

	console.log(`[watch] observing… (Ctrl-C to stop)`);

	// Wait forever until shutdown.
	await new Promise<void>((resolve) => {
		const check = () => {
			if (stopRequested) resolve();
			else setTimeout(check, 300);
		};
		check();
	});

	clearInterval(pollTimer);
	const durationMs = Date.now() - started;
	return {
		exitCode: 0,
		reason: "user-stop",
		companiesSeen,
		totalEvents: world.getTotalEvents(),
		webPort: web?.actualPort ?? 0,
		durationMs,
	};
}

/** Wire-friendly snapshot: Map -> plain object; BigInt already string via caller? No — keep raw, serialize at send. */
function toWireSnapshot(world: WorldState): unknown {
	const snap = world.snapshot();
	const companies: Record<string, unknown> = {};
	for (const [id, cs] of snap.companies) {
		companies[String(id)] = {
			info: cs.info,
			economy: cs.economy,
			stats: cs.stats,
		};
	}
	return {
		date: snap.date,
		companies,
		totalEvents: snap.totalEvents,
		recent: snap.recent.slice(-100),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export { loadConfig };
export type { Config };
