/**
 * Decision scheduler — WHEN the framework asks the LLM to decide.
 *
 * 职责: 决定"何时该请求一次决策"。框架负责节奏，**不负责策略**：
 *   它不知道也不关心该做什么，只知道"世界变了/时间到了/用户要求了"。
 * 为什么存在: v0.5.0 前 `maxTurns ?? 1` 使得整局**只决策一次**——模型建完线就再也
 *   没被问过，于是收入一路下滑也无人补救。真机 Session 日志已证实。
 *   见 docs/AGENT-LOOP-AND-CONTROL.md §2.1。
 * 事实来源: docs/AGENT-LOOP-AND-CONTROL.md §2.1。
 * 禁止:
 *   - 在触发条件里编码任何策略（"施工中就跳过"之类）。施工阶段变化恰恰是决策理由。
 *   - 依赖真实时钟（由调用方传入 `now`/`gameDay`，便于测试）。
 */

import type { DecisionTrigger } from "./decision-context.js";

export interface SchedulerOptions {
	/** Minimum wall-clock gap between two decisions (default 5s). */
	minGapMs?: number;
	/** Game days between periodic decisions when nothing else triggers (SPEC: 30 = monthly). */
	intervalGameDays?: number;
}

const DEFAULT_MIN_GAP_MS = 5_000;
/**
 * Framework fallback beat: monthly, per SPEC §4.2 ("默认: 每月初").
 * OpenTTD months are 30 days, so 30 game days = one month.
 */
const DEFAULT_INTERVAL_DAYS = 30;

/** Triggers ordered by how much they deserve to interrupt (higher wins). */
const PRIORITY: Record<DecisionTrigger, number> = {
	start: 6,
	manual: 5,
	event: 4,
	// Between the model's own wake-up and a phase change: both are "the world
	// moved", but the model's request is more deliberate.
	wait_until: 3,
	phase_change: 2,
	interval: 1,
};

export class DecisionScheduler {
	private readonly minGapMs: number;
	private readonly intervalDays: number;
	/** Highest-priority trigger waiting for the throttle window to open. */
	private queued: DecisionTrigger | null = null;
	private lastDecidedAt = 0;
	private lastDecidedDay = 0;
	private hasDecided = false;
	private paused = false;
	private decisions = 0;

	constructor(opts: SchedulerOptions = {}) {
		this.minGapMs = opts.minGapMs ?? DEFAULT_MIN_GAP_MS;
		this.intervalDays = opts.intervalGameDays ?? DEFAULT_INTERVAL_DAYS;
	}

	/**
	 * Signal that the world changed / the user asked. Multiple calls inside the
	 * throttle window coalesce into a single decision (highest priority wins), so
	 * a burst of construction phases cannot spam the model.
	 */
	request(trigger: DecisionTrigger): void {
		if (!this.queued || PRIORITY[trigger] > PRIORITY[this.queued]) {
			this.queued = trigger;
		}
	}

	/** True when something is waiting to be decided. */
	pending(): boolean {
		return this.queued !== null;
	}

	/** Decisions taken so far (surfaced on the dashboard). */
	count(): number {
		return this.decisions;
	}

	/** Stop firing until resume() (the run is paused). */
	pause(): void {
		this.paused = true;
	}

	/**
	 * Resume. The interval baseline is moved forward so a long pause does not
	 * release a burst of back-dated interval decisions.
	 */
	resume(gameDay?: number): void {
		this.paused = false;
		if (gameDay !== undefined) this.lastDecidedDay = gameDay;
	}

	/** Fresh state for a new run. */
	reset(): void {
		this.queued = null;
		this.lastDecidedAt = 0;
		this.lastDecidedDay = 0;
		this.hasDecided = false;
		this.paused = false;
		this.decisions = 0;
	}

	/**
	 * Take the decision that is due, if any. Returns the trigger that caused it.
	 *
	 * An explicit request (start/manual/event/phase_change) takes priority and
	 * fires as soon as the throttle window opens; otherwise the periodic interval
	 * fires once `intervalGameDays` of game time have passed.
	 */
	take(now: number, gameDay: number): { trigger: DecisionTrigger } | null {
		if (this.paused) return null;

		const throttleOpen = !this.hasDecided || now - this.lastDecidedAt >= this.minGapMs;
		if (!throttleOpen) return null;

		let trigger: DecisionTrigger | null = null;
		if (this.queued) {
			trigger = this.queued;
		} else if (this.hasDecided && gameDay - this.lastDecidedDay >= this.intervalDays) {
			trigger = "interval";
		}
		if (!trigger) return null;

		this.queued = null;
		this.lastDecidedAt = now;
		this.lastDecidedDay = gameDay;
		this.hasDecided = true;
		this.decisions++;
		return { trigger };
	}
}
