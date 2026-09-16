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
	opts: { decisionTickMs?: number; maxDecisions?: number; seconds?: number };
	isStopRequested(): boolean;
	publishStage(phase?: string): void;
	runDecision: typeof runDecision;
	/** Injectable clock/day for tests. */
	now(): number;
	gameDay(): number;
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
			if (shouldBreakOnDeadline({ deadline, seconds: ctx.opts.seconds ?? 0 }, ctx.now(), ctx.isStopRequested())) {
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
			const due = ctx.scheduler.take(ctx.now(), nowDay);
			if (!due) {
				await sleep(decisionTickMs);
				continue;
			}
			if (shouldBreakOnCap(ctx.scheduler.count(), maxDecisions)) {
				console.log(`[agent] decision cap reached (${maxDecisions})`);
				break;
			}

			// Snapshot the window BEFORE acting, so the next decision can compare.
			const preState = summarizeState(ctx.deps.state.snapshot());
			const preSnap = ctx.deps.state.snapshot();
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
			// SPEC §1.1 step 2 (REVISED 2026-09-12): the framework NO LONGER pauses the
			// game around a decision. The freeze was ONE-WAY (rcon pause never
			// unpauseable); what protects decision quality instead is the
			// pre-decision snapshot + `sinceLastDecision` reporting everything that
			// changed while the model thought (SPEC §10.28 follow-ups).
			let plan: DecisionPlan | null = null;
			{
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
				});
				plan = out.plan;
				ctx.telemetry.onActivity?.();
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