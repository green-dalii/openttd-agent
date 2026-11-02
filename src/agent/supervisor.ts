/**
 * Run supervisor — start/stop/pause/resume a game run from the dashboard.
 *
 * 职责: 运行状态机。dashboard 是**监督者**，不直接碰游戏；它把控制请求转给
 *   正在跑的 run，并对外暴露一个可读状态（REST + WS）。
 * 为什么存在: v0.5.0 起 dashboard 无法控制任何东西——run 与页面同生命周期，
 *   想换模式只能重启进程。见 docs/AGENT-LOOP-AND-CONTROL.md §3。
 * 事实来源: docs/AGENT-LOOP-AND-CONTROL.md §3.1/§3.2。
 * 禁止:
 *   - 同时跑两个 run（端口/session 会互相踩）。
 *   - 在这里做启动前的检查（那是 preflight 的职责）；本类只转发 start。
 */

import type { RunKnobInput } from "./run-knobs.js";

export type RunState = "idle" | "starting" | "running" | "paused" | "stopping";
export type RunMode = "agent" | "watch";

/** What the dashboard renders. */
export interface RunStatus {
	state: RunState;
	mode: RunMode | null;
	sessionId: string | null;
	startedAt: number | null;
	error: string | null;
	/**
	 * 暂停的**来源**：`"dashboard"`（页面按钮）或 `"agent"`（agent 自己调用了 `set_pause`）。
	 *
	 * 为什么必须区分（2026-09-23 真实事故）：一个长跑在 **turn 90 被 agent 自己暂停**，
	 * 之后 5 小时没有任何进展。页面上只显示 `paused`，owner 点 Pause 时状态早已是 paused，
	 * 于是"为什么还在跑/停了"无从判断。**"谁让它停的"是一个独立事实**，必须显式呈现。
	 */
	pausedBy?: "dashboard" | "agent" | null;
	/** 暂停发生的时刻（ms epoch）。 */
	pausedAt?: number | null;
}

/** Controls a running run must expose to the supervisor. */
export interface RunHooks {
	/** Ask the run to shut down gracefully (finalizes as `aborted`). */
	stop?: () => void;
	/** Pause the game (rcon pause) and stop the decision cadence. */
	pause?: () => void;
	/** Resume the game and the decision cadence. */
	resume?: () => void;
	/** Called by the run when it has fully finished. */
	onStopped?: () => void;
}

export interface SupervisorOptions {
	/**
	 * Launch a run. Must populate `hooks` and resolve once it is up.
	 *
	 * `knobs` are the run's settings, as the page sent them: the supervisor
	 * forwards them untouched so the launcher (which owns the rules) decides
	 * whether they are usable.
	 */
	start: (mode: RunMode, hooks: RunHooks, knobs?: RunKnobInput) => Promise<void>;
	/** Notified on every state transition (drives the WS push). */
	onStateChange?: (s: RunStatus) => void;
}

export class RunSupervisor {
	private readonly opts: SupervisorOptions;
	private cur: RunStatus = {
		state: "idle",
		mode: null,
		sessionId: null,
		startedAt: null,
		error: null,
	};
	private hooks: RunHooks = {};
	/** Waiters for "the run has finished" (the plan queue's cells). */
	private idleWaiters: Array<() => void> = [];

	constructor(opts: SupervisorOptions) {
		this.opts = opts;
	}

	/** Current status (copy: callers must not mutate our state). */
	state(): RunStatus {
		return { ...this.cur };
	}

	/** True when a run is active enough to accept pause/resume/stop. */
	canControl(): boolean {
		return this.cur.state === "running" || this.cur.state === "paused" || this.cur.state === "stopping";
	}

	/**
	 * Start a run. Rejects when one is already active so the dashboard can show a
	 * clear conflict instead of silently replacing the running game.
	 *
	 * `knobs` are the run's settings from the page; they are forwarded to the
	 * launcher untouched (the launcher validates them — a second copy of the
	 * rules here would drift).
	 */
	async start(mode: RunMode, knobs?: RunKnobInput): Promise<void> {
		if (this.canControl() || this.cur.state === "starting") {
			throw new Error(`a run is already running (mode=${this.cur.mode})`);
		}
		this.set({ state: "starting", mode, sessionId: null, startedAt: null, error: null });
		const hooks: RunHooks = {
			onStopped: () => this.markFinished(),
		};
		try {
			await this.opts.start(mode, hooks, knobs);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.hooks = {};
			this.set({ state: "idle", mode: null, sessionId: null, startedAt: null, error: msg });
			throw e;
		}
		this.hooks = hooks;
		this.set({ state: "running", startedAt: Date.now(), error: null });
	}

	/** Ask the run to stop. Completion is signalled via onStopped/markFinished. */
	async stop(): Promise<void> {
		if (!this.canControl()) throw new Error("no run to stop");
		if (this.cur.state === "stopping") return;
		this.set({ state: "stopping" });
		this.hooks.stop?.();
	}

	/** Pause the game + the decision cadence. Idempotent. */
	async pause(by: "dashboard" | "agent" = "dashboard"): Promise<void> {
		if (!this.canControl()) throw new Error("no run to pause");
		if (this.cur.state === "paused") {
			// 已经停了：**不要**改写来源——第一个让它停的人才是原因。
			return;
		}
		this.hooks.pause?.();
		this.set({ state: "paused", pausedBy: by, pausedAt: Date.now() });
	}

	/** Resume. Idempotent. */
	async resume(): Promise<void> {
		if (!this.canControl()) throw new Error("no run to resume");
		if (this.cur.state === "running") return;
		this.hooks.resume?.();
		this.set({ state: "running", pausedBy: null, pausedAt: null });
	}

	/**
	 * Wait until no run is active (the current run has finished).
	 *
	 * Why: a comparison runs several cells **in one process** (Issue #48), and
	 * only one run can be alive at a time — so the plan queue must be able to
	 * wait for the current cell to finish before starting the next one.
	 */
	waitForIdle(): Promise<void> {
		if (this.cur.state === "idle") return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	/** The run reports its session id once known (for the dashboard link). */
	setSessionId(id: string | null): void {
		this.set({ sessionId: id });
	}

	/** The run has fully finished (also used by tests). */
	markFinished(): void {
		this.hooks = {};
		this.set({ state: "idle", mode: null, sessionId: null, startedAt: null, error: null });
	}

	private set(patch: Partial<RunStatus>): void {
		this.cur = { ...this.cur, ...patch };
		this.opts.onStateChange?.(this.state());
		// A run that ended releases everyone waiting for the next cell.
		if (this.cur.state === "idle" && this.idleWaiters.length > 0) {
			const waiters = this.idleWaiters;
			this.idleWaiters = [];
			for (const w of waiters) w();
		}
	}
}
