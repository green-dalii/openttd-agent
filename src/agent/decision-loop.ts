/**
 * Decision loop — the "framework owns WHEN, LLM owns WHAT" cadence
 * (REFACTOR Phase B-4b; 1:1 move from runner.ts's while body).
 *
 * 职责: 决策触发的消费（scheduler.take）、每次决策的因果窗口
 *   （preState 快照 → runDecision → wait 解析 → pendingActions 记账 →
 *   tracker 重建 → checkpoint）、以及 wait_until/wait_condition 的状态机。
 * 禁止: 进程生命周期（runner）、信号消费（signal-hub）、局终结算
 *   （reflect-run）。publishStage 等展示回调由 runner 注入。
 *
 * 行为不变守则与 B-1..B-3 相同：1:1 搬迁 + gate 全绿 + 真机跑。
 */
import type { Agent } from "@earendil-works/pi-agent-core";
import { runDecision, type DecisionPlan } from "./loop.js";
import type { DecisionScheduler } from "./scheduler.js";
import type { Telemetry } from "./telemetry.js";
import type { AuditLog } from "./audit.js";
import type { SessionStore } from "./session-store.js";
import type { WebServer } from "../web/server.js";
import type { SignalHub } from "./signal-hub.js";
import type { AgentDeps } from "./types.js";
import {
	emptyTracker,
	recordAction,
	recordEvent,
	recordPhase,
	type DecisionTracker,
} from "./decision-context.js";
import { buildStageSummary } from "./session-store.js";
import { totalsFromTelemetry, formatGameDate, baselineOf, sleep } from "./runner-helpers.js";
import {
	shouldBreakOnDeadline,
	shouldBreakOnCap,
	waitUntilExpired,
	waitConditionMatches,
	emptyTrackerAfter,
} from "./loop-control.js";
import { summarizeState } from "./tools/index.js";
import type { RouteContextFact } from "./decision-context.js";
import type { FreezeController } from "./freeze.js";
import type { Episode } from "./episode.js";

/* eslint-disable no-console -- intentional runtime logging */

export interface DecisionLoopCtx {
	deps: AgentDeps;
	agent: Agent;
	scheduler: DecisionScheduler;
	hub: SignalHub;
	telemetry: Telemetry;
	audit: AuditLog;
	session: SessionStore;
	getWeb(): WebServer | null;
	/** Shared with the runner: drained by reflect-run at finalize. */
	pendingActions: { tool: string; ok: boolean; summary: string }[];
	opts: {
		decisionTickMs?: number;
		maxDecisions?: number;
		seconds?: number;
		/**
		 * The episode clock (G1, SPEC §10.68): the run ends on SIMULATED time,
		 * with the wall clock only as a safety cap. When absent, the loop falls
		 * back to the legacy wall-clock deadline.
		 */
		episode?: Episode;
	};
	isStopRequested(): boolean;
	/** Ask the run to stop (used by the horizon watcher, G1). */
	requestStop(): void;
	publishStage(phase?: string): void;
	runDecision: typeof runDecision;
	/** Injectable clock/day for tests. */
	now(): number;
	gameDay(): number;
	/** Route facts (hub economics joined with ledger pairs) for the context. */
	routesForContext(): RouteContextFact[];
	/** Optional verified freeze (SPEC §10.59); absent = never pause. */
	freeze?: FreezeController;
}

export interface DecisionLoop {
	/** Consume one decision tick; returns true when the loop should exit. */
	run(): Promise<void>;
	/** A phase change arrived (from the signal hub's news gate). */
	handlePhase(phase: string): void;
	/** A fleet/station notable event arrived. */
	handleNotable(summary: string): void;
	/** The model asked to wait (SPEC §4.2 step 5) — record the wake-up. */
	handlePlanWait(w: { game_days?: unknown; condition?: unknown }): void;
}

export function createDecisionLoop(ctx: DecisionLoopCtx): DecisionLoop {
	let tracker: DecisionTracker = emptyTracker();
	let waitUntil: { gameDays: number; from: number } | null = null;
	let waitCondition: string | null = null;
	const deadline =
		ctx.opts.seconds && ctx.opts.seconds > 0 ? ctx.now() + ctx.opts.seconds * 1000 : null;
	const episode = ctx.opts.episode ?? null;
	/**
	 * Simulated days the LAST decision consumed (G1). A decision is tens of
	 * seconds of wall clock = many game days, so the horizon can only be honoured
	 * if we stop ASKING before the end: a question started 5 days before the
	 * horizon finished 20 days past it (measured: horizon 40 -> 60).
	 */
	let lastDecisionDays = 0;
	const decisionMarginDays = () => Math.max(lastDecisionDays, 1);
	const decisionTickMs = ctx.opts.decisionTickMs ?? 1_000;
	const maxDecisions = ctx.opts.maxDecisions ?? 0; // 0 = bounded only by run length

	function handlePhase(phase: string): void {
		recordPhase(tracker, phase);
		// One snapshot per construction phase: the "阶段性游戏画面"
		// (a data-rendered diagram, not a screenshot - see stage-view.ts).
		ctx.publishStage(phase);
		// A model-supplied wait condition matching this phase is its wake-up call.
		if (waitConditionMatches(phase, waitCondition)) {
			waitCondition = null;
			ctx.scheduler.request("wait_until");
			return;
		}
		ctx.scheduler.request("phase_change");
	}

	function handleNotable(summary: string): void {
		recordEvent(tracker, summary);
		ctx.scheduler.request("event");
	}

	function handlePlanWait(w: { game_days?: unknown; condition?: unknown }): void {
		const days = Number(w.game_days);
		if (Number.isFinite(days) && days > 0) {
			waitUntil = { gameDays: days, from: ctx.gameDay() };
		} else if (typeof w.condition === "string" && w.condition.trim()) {
			// A textual condition is matched against the next phase change.
			waitCondition = w.condition.trim().toLowerCase();
		}
	}

	async function run(): Promise<void> {
		while (!ctx.isStopRequested()) {
			// G1: the episode clock decides. The wall-clock cap is an engineering
			// bound, so when it fires we say plainly that the simulated horizon was
			// NOT reached - a stalled world must not read as a finished episode.
			const epState = episode ? episode.check({ gameDay: ctx.gameDay(), nowMs: ctx.now() }) : null;
			if (epState?.stopReason === "horizon") {
				console.log(`[agent] episode horizon reached (${epState.simulatedDays} game days) - stopping`);
				break;
			}
			if (epState?.stopReason === "wall_cap") {
				console.log(
					`[agent] wall-clock cap reached after ${epState.simulatedDays} game days ` +
						`(horizon ${episode?.plan.horizonDays ?? "n/a"} NOT reached) - stopping`,
				);
				break;
			}
			if (
				!episode &&
				shouldBreakOnDeadline({ deadline, seconds: ctx.opts.seconds ?? 0 }, ctx.now(), ctx.isStopRequested())
			) {
				if (ctx.opts.seconds && ctx.opts.seconds > 0) {
					console.log(`[agent] run length reached (${ctx.opts.seconds}s) - stopping`);
				}
				break;
			}
			const nowDay = ctx.gameDay();
			if (waitUntilExpired({ waitUntil }, nowDay)) {
				waitUntil = null;
				ctx.scheduler.request("wait_until");
			}
			// G1: do not start a question we cannot finish inside the horizon. The
			// margin is the measured cost of the previous decision, so it adapts to
			// the model's latency instead of a guessed constant.
			if (epState && epState.daysRemaining !== null && epState.daysRemaining <= decisionMarginDays()) {
				await sleep(decisionTickMs);
				continue;
			}
			const due = ctx.scheduler.take(ctx.now(), nowDay);
			if (!due) {
				await sleep(decisionTickMs);
				continue;
			}
			if (shouldBreakOnCap(ctx.scheduler.count(), maxDecisions)) {
				console.log(`[agent] decision cap reached (${maxDecisions})`);
				break;
			}

			// A decision takes tens of seconds of wall clock, which is many simulated
			// days - so the horizon must also be watched WHILE the decision runs,
			// not only between decisions. Without this the episode overshot its
			// horizon by a whole decision (measured: horizon 25 -> 30 simulated
			// days), reintroducing exactly the variable opportunity G1 removes.
			const horizonWatch = episode
				? setInterval(() => {
						const st = episode.check({ gameDay: ctx.gameDay(), nowMs: ctx.now() });
						if (st.stopReason === "horizon") {
							console.log(`[agent] episode horizon reached (${st.simulatedDays} game days) - stopping`);
							ctx.requestStop();
						}
					}, decisionTickMs)
				: null;

			// Snapshot the window BEFORE acting, so the next decision can compare.
			const preState = summarizeState(ctx.deps.state.snapshot());
			const preSnap = ctx.deps.state.snapshot();
			const dayBeforeDecision = ctx.gameDay();
			ctx.telemetry.decisionPoint();
			ctx.audit.write({
				type: "decision",
				ts: ctx.now(),
				turn: ctx.scheduler.count(),
				trigger: due.trigger,
				date: String(preState.date ?? "?"),
				state: preState,
			});
			ctx.session.appendAudit({ type: "decision", ts: ctx.now(), turn: ctx.scheduler.count(), trigger: due.trigger, state: preState });

			const history = ctx.session.current().checkpoints.map((c) => c.note);
			// Since 2026-09-12 the framework does NOT pause by default: decision
			// quality is protected by the pre-decision snapshot + `sinceLastDecision`,
			// which reports everything that changed while the model thought.
			//
			// Note (2026-09-17): the reason originally given for abandoning the pause
			// - "rcon pause is one-way" - was measured FALSE (§10.59: pause freezes
			// `getdate`, unpause resumes it; the real culprit was `pause_on_join=true`
			// with no client). Optional freezing is therefore back on the table, but
			// only as the VERIFIED kind implemented in freeze.ts, and only when asked
			// for (it trades wall-clock for a snapshot the model can trust).
			let plan: DecisionPlan | null = null;
			// 已验证的冻结（可选，SPEC §10.59）：把"模型思考 + 工具执行"整段包在
			// pause/unpause 里，使动作落在模型真正见过的世界上。release 在 finally
			// 里（§10.26 的永久冻结就是漏了 finally）；控制器本身还有看门狗。
			const lease = ctx.freeze ? await ctx.freeze.acquire(`decision ${ctx.scheduler.count()}`) : null;
			try {
				const out = await ctx.runDecision(ctx.agent, ctx.deps, {
					trigger: due.trigger,
					tracker,
					gameDay: ctx.gameDay(),
					history,
					...(ctx.hub.getPhase() ? { phase: ctx.hub.getPhase() } : {}),
					// Episode-boundary fact: without it the model cannot budget its own
					// decisions and may sleep past the end of the run (see /tmp/cal1).
					...(deadline !== null
						? { secondsRemaining: Math.max(0, Math.round((deadline - ctx.now()) / 1000)) }
						: {}),
					// The clock in the units the WORK is measured in. Construction is
					// bounded by simulated time (script ticks), so "will this finish in
					// time?" cannot be answered with wall seconds (D18).
					...(epState
						? {
								simulatedDays: epState.simulatedDays,
								...(epState.daysRemaining !== null ? { gameDaysRemaining: epState.daysRemaining } : {}),
							}
						: {}),
					routes: ctx.routesForContext(),
				});
				plan = out.plan;
				ctx.telemetry.onActivity?.();
			} finally {
				if (horizonWatch) clearInterval(horizonWatch);
				await lease?.release();
			}

			// SPEC §4.2 step 5: honour the model's own wake-up ("或等待条件满足").
			// The framework only parses it; the content is the model's call.
			if (plan && plan.wait_until) {
				handlePlanWait(plan.wait_until as { game_days?: unknown; condition?: unknown });
			}
			ctx.publishStage(plan && plan.goal ? plan.goal : undefined);
			if (plan && plan.goal) {
				ctx.audit.write({ type: "note", ts: ctx.now(), message: `plan: ${plan.goal}`, data: { plan } });
				ctx.session.appendAudit({ type: "plan", ts: ctx.now(), plan });
			}

			// Record the outcome of whatever the model asked for, then open a new
			// window so the next decision sees the effect of this one.
			for (const a of ctx.pendingActions) {
				recordAction(tracker, a);
			}
			ctx.pendingActions.length = 0;
			lastDecisionDays = Math.max(0, ctx.gameDay() - dayBeforeDecision);
			tracker = emptyTrackerAfter(baselineOf(preSnap, ctx.gameDay()));

			const snap = ctx.deps.state.snapshot();
			ctx.session.update({ totals: totalsFromTelemetry(ctx.session.current().totals, ctx.telemetry.snapshot(), snap.totalEvents) });
			const cp = buildStageSummary(ctx.session.current(), formatGameDate(snap.date), ctx.scheduler.count());
			ctx.session.addCheckpoint(cp);
			ctx.getWeb()?.publishCheckpoint(cp);
			console.log(`[agent] decision ${ctx.scheduler.count()} (${due.trigger}) at ${snap.date ? formatGameDate(snap.date) : "?"}`);
		}
	}

	return { run, handlePhase, handleNotable, handlePlanWait };
}