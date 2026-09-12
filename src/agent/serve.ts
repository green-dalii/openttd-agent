/* eslint-disable no-console */
/**
 * Serve mode — a long-lived dashboard that can start/stop/pause game runs.
 *
 * 职责: 常驻 WebServer + RunSupervisor。页面上的「开始/停止/暂停/恢复」经由
 *   `/api/run/*` 到这里，再转发给正在跑的 run。
 * 为什么单独一个模式: 之前 run 与页面同生命周期——想换模式只能重启进程，
 *   页面也无法控制任何东西。见 docs/AGENT-LOOP-AND-CONTROL.md §3.1。
 * 事实来源: docs/AGENT-LOOP-AND-CONTROL.md §3。
 * 禁止:
 *   - 在这里做先决检查（preflight 的职责）：启动失败要**原样**把错误报给页面，
 *     让用户看到"为什么不能启动"，而不是被本层吞掉。
 *   - 让被监督的 run 自建 WebServer（一端口一扇出）。
 */

import type { Config } from "../config.js";
import { WebServer } from "../web/server.js";
import { createLlmApi } from "./llm-api.js";
import { listSessions, readSession } from "./session-store.js";
import { evolutionView, setStrategyEnabled } from "../evolution/web-view.js";
import { RunSupervisor, type RunMode } from "./supervisor.js";
import { runAgent } from "./runner.js";
import { runWatch } from "../game/runner.js";
import { runPreflight, formatPreflight } from "./preflight.js";
import { APP_VERSION } from "../version.js";

export interface ServeOptions {
	webPort?: number;
	/** Allow the scripted demo brain (no real LLM). */
	offlineDemo?: boolean;
	/** Skip non-safety preflight checks. */
	skipPreflight?: boolean;
	/**
	 * Options forwarded verbatim to the run the Start button launches.
	 *
	 * Why this exists as one bag rather than individual fields: the previous
	 * hand-built `runOpts` dropped every option that was not `web`/`control`,
	 * including `offlineDemo`. The failure was invisible from the CLI because
	 * preflight reads `opts.offlineDemo` directly - so `--serve --offline-demo`
	 * printed "running the explicit offline demo" and then the runner threw
	 * "no LLM configured". A gate that accepts an option the runner never
	 * receives is worse than a missing flag: it lies about what will happen.
	 */
	runOptions?: {
		offlineDemo?: boolean;
		injectMemory?: boolean;
		seconds?: number;
		planTowns?: { from?: number; to?: number };
		maxTurns?: number;
		decisionMinGapMs?: number;
		decisionIntervalDays?: number;
		decisionTickMs?: number;
		maxDecisions?: number;
	};
	/** Hook for tests: run something else instead of the real runners. */
	launcher?: (mode: RunMode, cfg: Config, opts: Record<string, unknown>) => Promise<number>;
}

/**
 * The options the Start button hands to the runner.
 *
 * Extracted and exported because it must be resolved EXACTLY ONCE and shared by
 * two consumers that previously disagreed: the preflight gate and the runner.
 * When the gate reads one value and the runner reads another, a run can be
 * approved on the basis of a setting the runner never receives - or refused on
 * the basis of one the runner would have honoured. Either way the user is told
 * something untrue about what is about to happen.
 */
export function resolveRunOptions(
	opts: Pick<ServeOptions, "offlineDemo" | "runOptions">,
	web: unknown,
	control: unknown,
): Record<string, unknown> {
	return {
		...opts.runOptions,
		// Explicit top-level flag wins over the bag only when the bag is silent.
		offlineDemo: opts.runOptions?.offlineDemo ?? opts.offlineDemo ?? false,
		web,
		control,
	};
}

export interface ServeHandle {
	port: number;
	supervisor: RunSupervisor;
	/** Wait until the process is asked to stop. */
	done: Promise<void>;
	stop(): Promise<void>;
}

/**
 * Start the dashboard and return a handle. The server stays up regardless of
 * whether a run is active, so the user can configure an LLM, start a run, watch
 * it, stop it, change settings and start again without restarting the process.
 */
export async function runServe(cfg: Config, opts: ServeOptions = {}): Promise<ServeHandle> {
	const llmApi = createLlmApi({ dataDir: cfg.dataDir, cfg, envLlm: cfg.llm });
	let web: WebServer | null = null;

	// The supervisor owns the run lifecycle; the launcher decides HOW to run.
	const supervisor = new RunSupervisor({
		onStateChange: (s) => web?.publishRun(s),
		start: async (mode, hooks) => {
			if (!web) throw new Error("dashboard not ready");
			// Same gate as the CLI: refuse to start when prerequisites are missing,
			// and surface the reason verbatim to the page.
			const pre = await runPreflight(cfg, {
				mode,
				// Same resolved value the runner will get. Reading opts.offlineDemo
				// here directly was a second source of truth - see resolveRunOptions.
				offlineDemo: opts.runOptions?.offlineDemo ?? opts.offlineDemo ?? false,
				skipUnsafe: opts.skipPreflight,
			});
			if (!pre.ok) {
				const failed = pre.checks.find((c) => c.status === "fail");
				throw new Error(
					failed ? `${failed.id}: ${failed.detail}${failed.hint ? ` — ${failed.hint}` : ""}`
						: "preflight refused to start",
				);
			}
			const runOpts = resolveRunOptions(opts, web, {
				onReady: (h: { stop: () => void; pause: () => void; resume: () => void }) => {
					hooks.stop = h.stop;
					hooks.pause = h.pause;
					hooks.resume = h.resume;
				},
			});
			const launch = opts.launcher ?? defaultLauncher;
			// Run in the background: the supervisor tracks completion via onStopped.
			void launch(mode, cfg, runOpts)
				.catch((e) => console.error(`[serve] run failed: ${e instanceof Error ? e.message : e}`))
				.finally(() => hooks.onStopped?.());
		},
	});

	web = new WebServer({
		host: "127.0.0.1",
		port: opts.webPort ?? 0,
		version: APP_VERSION,
		getSnapshot: () => ({ mode: "serve", run: supervisor.state(), appVersion: APP_VERSION }),
		llm: llmApi.llm,
		catalog: llmApi.catalog,
		sessions: {
			list: () => listSessions(cfg.dataDir),
			read: (id, limit) => readSession(cfg.dataDir, id, limit ? { limit } : {}),
		},
		// Cross-game memory (SPEC §6.1 view 4). Read-only except the human
		// confirmation toggle, which is the one write a human performs here
		// (SPEC §5.3: the engine advises, the human decides).
		evolution: {
			// Read fresh on each request: the page must reflect games that finished
			// after it was loaded.
			metrics: () => evolutionView(cfg.dataDir).metrics,
			lessons: () => evolutionView(cfg.dataDir).lessons,
			strategies: () => evolutionView(cfg.dataDir).strategies,
			arms: () => evolutionView(cfg.dataDir).arms,
			setStrategyEnabled: (id, enabled) => setStrategyEnabled(cfg.dataDir, id, enabled),
		},
		run: {
			status: () => supervisor.state(),
			start: (mode) => supervisor.start(mode),
			stop: () => supervisor.stop(),
			pause: () => supervisor.pause(),
			resume: () => supervisor.resume(),
		},
	});
	await web.start();
	console.log(`[serve] openttd-agent ${APP_VERSION}`);
	console.log(`[serve] dashboard: http://127.0.0.1:${web.actualPort}/`);
	console.log("[serve] start/stop/pause from the page (or POST /api/run/start)");

	let stopRequested = false;
	let resolveDone: (() => void) | null = null;
	const done = new Promise<void>((r) => (resolveDone = r));
	const requestStop = () => {
		if (stopRequested) return;
		stopRequested = true;
		resolveDone?.();
	};
	process.once("SIGINT", requestStop);
	process.once("SIGTERM", requestStop);

	return {
		port: web.actualPort,
		supervisor,
		done,
		async stop() {
			try {
				await supervisor.stop();
			} catch {
				/* nothing running */
			}
			if (web) await web.stop();
		},
	};
}

/** Default launcher: dispatch to the real runners. */
async function defaultLauncher(
	mode: RunMode,
	cfg: Config,
	runOpts: Record<string, unknown>,
): Promise<number> {
	if (mode === "watch") {
		const r = await runWatch(cfg, runOpts as never);
		return r.exitCode;
	}
	return runAgent(cfg, runOpts as never);
}

/** Re-export so callers can render the same gate output as the CLI. */
export { formatPreflight };
