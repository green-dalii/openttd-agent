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
import { sessionHooks } from "./session-store.js";
import { evolutionView, setStrategyEnabled } from "../evolution/web-view.js";
import { RunSupervisor, type RunMode } from "./supervisor.js";
import { runAgent } from "./runner.js";
import { runWatch } from "../game/runner.js";
import { runPreflight, formatPreflight } from "./preflight.js";
import { applyLlmSettingsFile } from "./llm-settings.js";
import { APP_VERSION } from "../version.js";
import { actionCatalog } from "./tools/catalog.js";
import { metricExclusion } from "../evolution/metrics.js";
import {
	knobInputFrom,
	previewRunKnobs,
	resolveRunKnobs,
	type RunBackend,
	type RunKnobDefaults,
	type RunKnobInput,
	type RunKnobs,
} from "./run-knobs.js";
import { buildNextRunPreview, type NextRunPreview } from "./run-preview.js";
import { harnessEnabled } from "./harness-runtime.js";
import { assertCostCapEnforceable, costCapProblem } from "./run-budget.js";
import type { Problem } from "./problems.js";

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
		/** Episode horizon in simulated game days (the default for the page's knob). */
		gameDays?: number;
		/** "freeform" (default) or "prebuilt". */
		scenario?: "freeform" | "prebuilt";
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

/** The knobs the page may set for the next run (all optional). */
export type { RunKnobInput };

/**
 * The backends this process may run.
 *
 * The harness backend is **off unless `AGENT_HARNESS=1`** (the D6c
 * invariant: the default must stay the plain agent until the owner decides
 * otherwise). A page that asks for "harness" without that env gets a
 * refusal with the fix, not a silent downgrade to "agent".
 */
export function allowedBackends(env: Record<string, string | undefined> = process.env): RunBackend[] {
	return harnessEnabled(env) ? ["agent", "harness"] : ["agent"];
}

/**
 * The knob values a run starts from when the page does not name one.
 *
 * They come from the **process** (env/CLI), so "the page did not touch it"
 * means "keep what the operator configured on the command line".
 */
export function runKnobDefaults(cfg: Config, opts: ServeOptions): RunKnobDefaults {
	return {
		seed: cfg.seed,
		gameDays: opts.runOptions?.gameDays ?? null,
		scenario: opts.runOptions?.scenario ?? "freeform",
		memoryArm: opts.runOptions?.injectMemory === false ? "control" : "treatment",
		thinkingLevel: cfg.llm.scaffold?.thinkingLevel ?? "off",
		toolBudget: cfg.llm.scaffold?.toolBudget ?? 12,
		tokenLimit: cfg.llm.limits?.tokens ?? null,
		costLimit: cfg.llm.limits?.cost ?? null,
		backend: harnessEnabled(process.env) ? "harness" : "agent",
	};
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
		// Memory is ON by default (it is how the agent self-evolves); an explicit
		// false from any caller turns it off for the M3 control arm.
		injectMemory: opts.runOptions?.injectMemory ?? true,
		web,
		control,
	};
}

export interface ServeHandle {
	port: number;
	supervisor: RunSupervisor;
	/**
	 * The next-run preview, resolved server-side.
	 *
	 * Exposed on the handle (not only through HTTP) so the preview and the
	 * start path can be compared **in one test**: the preview must refuse
	 * exactly what the start refuses, and the fields it promises must be the
	 * fields the run records.
	 */
	preview(knobs?: RunKnobInput): Promise<{ preview: NextRunPreview | null; problems: Problem[] }>;
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

	/** The knobs a run starts from (the process's own settings). */
	const knobDefaults = (): RunKnobDefaults => runKnobDefaults(cfg, opts);
	/** The backends this process may run (the harness one is opt-in). */
	const backends = (): RunBackend[] => allowedBackends();

	/**
	 * Resolve the knobs of a run, or explain why they cannot be used.
	 *
	 * Throws `ProblemError` → the web layer turns it into 400 + `problems[]`,
	 * and **nothing is started** (no game process, no session).
	 */
	async function resolveKnobs(raw: RunKnobInput | undefined): Promise<RunKnobs> {
		const knobs = resolveRunKnobs(raw ?? {}, knobDefaults(), backends());
		// A cost cap on a model without a price table can never fire, so it would
		// be a lie about the budget. Refuse it here — before the game starts —
		// with the same rule the runner uses (run-budget.ts).
		if (knobs.costLimit !== null) {
			const resolved = await llmApi.resolveCurrent();
			if (resolved.valid) {
				assertCostCapEnforceable(
					{ tokens: knobs.tokenLimit, cost: knobs.costLimit },
					resolved.facts.costKnown,
				);
			}
		}
		return knobs;
	}

	/**
	 * The next-run preview: what the next run would actually use.
	 *
	 * Everything here is **resolved server-side** — the page never normalizes
	 * or guesses. Illegal knobs come back as `problems[]` (the page shows them
	 * next to the field) rather than a thrown error, so the form can stay
	 * usable while the user is still typing.
	 */
	async function previewRun(raw: RunKnobInput | undefined): Promise<{
		preview: NextRunPreview | null;
		problems: Problem[];
	}> {
		const parsed = previewRunKnobs(raw ?? {}, knobDefaults(), backends());
		if (!parsed.knobs) return { preview: null, problems: parsed.problems };
		const resolved = await llmApi.resolveCurrent();
		if (!resolved.valid) return { preview: null, problems: resolved.problems };
		// The same refusal Start makes: a preview that promises a cost cap the
		// run cannot enforce is a lie in a nicer dress. The rule is the SAME
		// function the runner uses (run-budget.ts), so the two cannot disagree.
		const capProblem = costCapProblem(
			{ tokens: parsed.knobs.tokenLimit, cost: parsed.knobs.costLimit },
			resolved.facts.costKnown,
		);
		if (capProblem) return { preview: null, problems: [capProblem] };
		return {
			preview: buildNextRunPreview(parsed.knobs, {
				providerId: resolved.facts.providerId,
				model: resolved.facts.model,
				api: resolved.facts.api,
				contextWindow: resolved.facts.contextWindow,
				maxTokens: resolved.facts.maxTokens,
				costKnown: resolved.facts.costKnown,
			}),
			problems: [],
		};
	}

	/**
	 * The knobs of one run, applied to the config and the run options.
	 *
	 * Why the config is **cloned** instead of mutated: `cfg` is the process's
	 * configuration (shared by every run); a run's knobs must not leak into the
	 * next one ("applies to this run", not "to the process").
	 */
	function applyKnobs(base: Config, knobs: RunKnobs): Config {
		return {
			...base,
			// The world seed (the process manager passes it to OpenTTD).
			seed: knobs.seed,
			llm: {
				...base.llm,
				// The scaffold knobs (thinking level, tool budget) and the spend
				// caps travel in the config because that is where the runner
				// reads them from (one source, no second copy).
				scaffold: { thinkingLevel: knobs.thinkingLevel, toolBudget: knobs.toolBudget },
				limits: { tokens: knobs.tokenLimit, cost: knobs.costLimit },
			},
		};
	}

	/**
	 * The knobs of a run, applied to the **run options** the runner receives.
	 *
	 * The arm is the memory variable: "control" means no cross-game memory is
	 * injected (the runner reads `injectMemory === false` as the control arm).
	 */
	function applyKnobOptions(base: Record<string, unknown>, knobs: RunKnobs): Record<string, unknown> {
		return {
			...base,
			gameDays: knobs.gameDays ?? undefined,
			scenario: knobs.scenario,
			injectMemory: knobs.memoryArm === "treatment",
			backend: knobs.backend,
		};
	}

	// The supervisor owns the run lifecycle; the launcher decides HOW to run.
	const supervisor = new RunSupervisor({
		onStateChange: (s) => web?.publishRun(s),
		start: async (mode, hooks, knobs) => {
			if (!web) throw new Error("dashboard not ready");
			// **每次 Start 都重新合并 `<dataDir>/llm.json`**（2026-09-22 的回归）。
			//
			// `--serve` 是长驻进程，而 Providers 页会在它运行期间写这份文件
			// （llm-api 的 get/save 每次都 `applyLlmSettingsFile`）。启动时捕获的 `cfg`
			// 因此可能比用户上次保存**旧**——于是出现“页面说已配置、门禁说没配置”：
			// 同一个问题两个事实源，页面与门禁各答一半。
			//
			// 为什么安全（且本来就是设计意图）：`applyLlmSettingsFile` 是 env > 文件的合并，
			// 幂等；且 `providerId` 故意**不带默认值回填**，所以重复合并不会把默认值烘进去
			// 而遮住之后的文件更新（llm-settings.ts 里那段注释预见的正是“再次合并”）。
			const runCfg = applyLlmSettingsFile(cfg);
			// The knobs of THIS run (the page may set them; the CLI may not).
			// Resolved before the gate so an illegal knob is refused with a
			// reason and **no game process is started**.
			const runKnobs = await resolveKnobs(knobs);
			const scopedCfg = applyKnobs(runCfg, runKnobs);
			// Same gate as the CLI: refuse to start when prerequisites are missing,
			// and surface the reason verbatim to the page.
			const pre = await runPreflight(scopedCfg, {
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
			const runOpts = applyKnobOptions(
				resolveRunOptions(opts, web, {
					onReady: (h: { stop: () => void; pause: () => void; resume: () => void }) => {
						hooks.stop = h.stop;
						hooks.pause = h.pause;
						hooks.resume = h.resume;
					},
					// agent 自己按暂停 → **supervisor 是 run 状态的唯一写者**。
					// pause("agent") 会调 hooks.pause（= scheduler.pause + rcon，与页面同路径）
					// 并把 pausedBy 记成 "agent"；resume 同理。幂等：已 paused 时不改写来源
					// （"第一个让它停的才是原因"），因此 agent 在页面已暂停后再按不会夺走归因。
					onAgentPause: (paused: boolean) => {
						const p = paused ? supervisor.pause("agent") : supervisor.resume();
						void p.catch((e) => console.error(`[serve] agent pause/resume failed: ${e instanceof Error ? e.message : e}`));
					},
				}),
				runKnobs,
			);
			const launch = opts.launcher ?? defaultLauncher;
			// Run in the background: the supervisor tracks completion via onStopped.
			// `scopedCfg`（已合并当前 llm.json + 本局旋钮）而不是启动时那份：
			// 否则门禁放行、运行却用旧配置。
			void launch(mode, scopedCfg, runOpts)
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
		// Static action surface (AB-1, SPEC §10.91). The list is computed once at
		// construction — the underlying catalog is a memoized view of the tool
		// registry, so this hook is cheap and safe to call on every request.
		capabilities: () => actionCatalog(),
		sessions: sessionHooks(cfg.dataDir),
		// Cross-game memory (SPEC §6.1 view 4). Read-only except the human
		// confirmation toggle, which is the one write a human performs here
		// (SPEC §5.3: the engine advises, the human decides).
		evolution: {
			// Read fresh on each request: the page must reflect games that finished
			// after it was loaded.
			// `excluded` 是加法字段（P0-3）：排除原因由 metricExclusion 单一写者算出，
			// 页面只负责渲染——不让页面抄一份规则（D64/C1：规则抄一遍就会漂移）。
			metrics: () => evolutionView(cfg.dataDir).metrics.map((m) => ({ ...m, excluded: metricExclusion(m) })),
			lessons: () => evolutionView(cfg.dataDir).lessons,
			strategies: () => evolutionView(cfg.dataDir).strategies,
			arms: () => evolutionView(cfg.dataDir).arms,
			setStrategyEnabled: (id, enabled) => setStrategyEnabled(cfg.dataDir, id, enabled),
		},
		run: {
			status: () => supervisor.state(),
			// The raw request record is converted to the typed input **once**, at
			// this boundary: the web layer does not know the rules, the agent
			// layer does. Both paths (start, preview) convert the same way, so
			// the preview can never describe a different run than the one started.
			start: (mode, knobs) => supervisor.start(mode, knobInputFrom(knobs)),
			preview: (knobs) => previewRun(knobInputFrom(knobs)),
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
		preview: (knobs?: RunKnobInput) => previewRun(knobs),
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
