/* eslint-disable no-console -- intentional runtime logging */
/**
 * Run-finalize-and-reflect tail (REFACTOR Phase B-2).
 *
 * 职责: 在主决策循环退出后落定 session、跑 reflection、返回退出码。
 *   这部分从 runner.ts 原样搬出，零行为变更；测试零改动绿是
 *   "行为不变"的机械证明。
 * 禁止: 决策逻辑、信号处理、调度——这些在 decision-loop / signal-hub。
 */
import { buildReflectionEvidence } from "../evolution/reflect.js";
import { routeFactsFromLedger, saveRouteFacts } from "../evolution/route-facts.js";
import type { RouteStats } from "./route-stats.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { runReflection } from "../evolution/reflection-run.js";
import { buildStageSummary } from "./session-store.js";
import { totalsFromTelemetry, formatGameDate } from "./runner-helpers.js";
import type { WorldState } from "../game/world-state.js";
import type { SessionStore } from "./session-store.js";
import type { Telemetry } from "./telemetry.js";
import type { RouteLedger } from "./route-ledger.js";
import type { Config } from "../config.js";

export interface FinalizeAndReflectArgs {
	cfg: Config;
	world: WorldState;
	session: SessionStore;
	telemetry: Telemetry;
	executorPhase: string;
	reachedDone: boolean;
	scheduler: { count(): number };
	pendingActions: Array<{ tool: string; ok: boolean; summary: string }>;
	routeLedger: RouteLedger;
	/**
	 * Latest per-route economics from the GS (N2-3). Injected as a function so the
	 * finalize step reads whatever the hub last saw, without owning the hub.
	 */
	getRouteStats: () => RouteStats[];
	/** Assigned arm, recorded in the metric so it is never inferred (N2-5 fix). */
	arm: "treatment" | "control";
	/**
	 * GS error replies during the run (channel health, SPEC §10.66). Recorded so
	 * a partially broken channel cannot hide inside a comparison.
	 */
	gsErrors: number;
	/** R1: per-decision tool budget refusals (reported so a capped run is visible). */
	toolBudgetBlocks?: number;
	/**
	 * EPISODE CLOCK (G1, SPEC §10.68). Recorded so a run that never reached its
	 * simulated horizon cannot be averaged with one that did: the wall-clock cap
	 * makes it a stopper, never a result.
	 */
	/**
	 * S1/G4 scenario. "prebuilt" means the route already existed when the
	 * measurement window opened, so the outcome reflects management decisions.
	 * Runs whose scenario never became ready must not be compared (G4).
	 */
	scenario: "freeform" | "prebuilt";
	/** Why the prebuilt setup ended as it did ("ready" | "timeout" | "order_refused"). */
	scenarioReason?: string | null;
	/** Cargo delivered before the measurement window opened (prebuilt only). */
	deliveredAtReady?: number | null;
	episode: {
		simulatedDays: number;
		/** The horizon this episode was measured against (null = none set). */
		horizonDays: number | null;
		reachedHorizon: boolean;
		stopReason: "horizon" | "wall_cap" | null;
	};
	/** Verified-freeze stats (SPEC §10.60); null when the run never froze. */
	freezeStats?: { confirmed: number; unconfirmed: number; failures: number; watchdogTrips: number; maxHoldMs: number } | null;
	/**
	 * Reflection LLM access (R2b). The reflection pass runs through the same
	 * pi-agent-core Agent with `record_lesson`/`record_strategy` tools, so it needs
	 * the provider stream function and model rather than a plain text completion.
	 */
	reflectLlm: { streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"]; model: Model<string> };
}

/**
 * Persist the run, then run reflection (if any decisions were made), then
 * return the exit code. Mirrors the original in-line runner tail 1:1.
 */
export async function runFinalizeAndReflect(args: FinalizeAndReflectArgs): Promise<number> {
	const {
		cfg,
		world,
		session,
		telemetry,
		executorPhase,
		reachedDone,
		scheduler,
		pendingActions,
		routeLedger,
		getRouteStats,
		arm,
		freezeStats,
		reflectLlm,
	} = args;
	const snap = world.snapshot();
	const c0 = snap.companies.get(0);
	console.log(
		`[agent] RESULT: constructionDone=${reachedDone} phase="${executorPhase}" vehicles=${c0?.stats?.vehicles ?? "?"} stations=${c0?.stats?.stations ?? "?"} money=${c0?.economy ? c0.economy.money.toString() : "?"}`,
	);

	const finalTelemetry = telemetry.snapshot();
	session.saveTelemetry(finalTelemetry);
	session.update({ totals: totalsFromTelemetry(session.current().totals, finalTelemetry, snap.totalEvents) });
	session.addCheckpoint(
		buildStageSummary(session.current(), formatGameDate(snap.date), Math.max(1, scheduler.count())),
	);
	console.log(
		`[agent] tokens: in=${finalTelemetry.usage.total.input} out=${finalTelemetry.usage.total.output} ` +
			`reasoning=${finalTelemetry.usage.total.reasoning} total=${finalTelemetry.usage.total.totalTokens} ` +
			`cost=$${finalTelemetry.usage.total.costTotal.toFixed(4)}`,
	);
	console.log(
		`[agent] tools: ${finalTelemetry.totals.toolCalls} calls, ${finalTelemetry.totals.toolFailures} failed`,
	);
	session.finalize({
		status: reachedDone ? "completed" : "aborted",
		arm,
		freeze: freezeStats ?? null,
		outcome: {
			constructionDone: reachedDone,
			phase: executorPhase || undefined,
			vehicles: c0?.stats?.vehicles ?? undefined,
			stations: c0?.stats?.stations ?? undefined,
			money: c0?.economy ? c0.economy.money.toString() : undefined,
			// N2-4: the flow metric. Money is spending-dominated (building costs),
			// so "did the lines earn" needs income, and a missing reading stays
			// missing rather than becoming 0.
			income: c0?.economy && Number.isFinite(Number(c0.economy.income)) ? Number(c0.economy.income) : undefined,
			// N2-4b: the least confounded outcome - cargo actually moved. `income`
			// is net of expenses, so every construction run is negative by
			// construction; delivered cargo is not.
			delivered:
				c0?.economy && c0.economy.deliveredCargo !== undefined
					? Number(c0.economy.deliveredCargo)
					: undefined,
			// SPEC §10.65: the raw counter resets every quarter, so the number
			// above measures a random partial quarter. This is the integrated
			// "delivered during the run" figure, and it is what comparisons use.
			deliveredRun: c0?.deliveredRun && c0.deliveredRun.total !== null ? c0.deliveredRun.total : undefined,
			deliveredRunComplete: c0?.deliveredRun ? c0.deliveredRun.complete : undefined,
			gsErrors: args.gsErrors,
			toolBudgetBlocks: args.toolBudgetBlocks,
			scenario: args.scenario,
			scenarioReason: args.scenarioReason ?? null,
			deliveredAtReady: args.deliveredAtReady ?? null,
			simulatedDays: args.episode.simulatedDays,
			horizonDays: args.episode.horizonDays,
			reachedHorizon: args.episode.reachedHorizon,
			totalEvents: snap.totalEvents,
		},
	});

	// C-2 (SPEC 10.43): a run that never ordered a route has no learnable
	// strategy - its "lessons" are noise injected as experience. Reflection and
	// fact-persisting both require at least one order (C-1 saves facts only for
	// real orders; lie-flat runs leave no route-facts.jsonl).
	const orderedRoutes = routeLedger.all().length;
	if (finalTelemetry.totals.decisions > 0 && orderedRoutes > 0) {
		// C-1: persist route facts deterministically - the ledger already holds
		// the precise data; an LLM summarization pass would prose-ify it away.
		// N2-3: attach the route's RESULT (vehicles/waiting/profit) to the fact.
		// The ledger knows which job was ordered; the hub knows what that job's
		// line ended up doing. Joining them is what turns "I ordered 9->12" into
		// "9->12 ended with 6 vehicles, 146 waiting, -308 profit".
		const statsByJob = new Map(getRouteStats().map((r) => [r.job, r]));
		saveRouteFacts(cfg.dataDir, routeFactsFromLedger(routeLedger.all(), statsByJob));
		try {
			const report = await runReflection({
				streamFn: reflectLlm.streamFn,
				model: reflectLlm.model,
				dataDir: cfg.dataDir,
				facts: {
					sessionId: session.id,
					seed: cfg.seed,
					summary: {
						money: c0?.economy ? Number(c0.economy.money) : 0,
						// The outcome the run is actually judged by (SPEC §10.65) plus
						// the simulated length; without them reflection reasons about
						// spending, not about throughput.
						delivered: c0?.deliveredRun?.total ?? null,
						simulatedDays: args.episode.simulatedDays,
						episodeStop: args.episode.stopReason,
						vehicleCount: c0?.stats?.vehicles ?? 0,
						stationCount: c0?.stats?.stations ?? 0,
						decisions: finalTelemetry.totals.decisions,
						toolCalls: finalTelemetry.totals.toolCalls,
						toolFailures: finalTelemetry.totals.toolFailures,
						constructionDone: reachedDone,
						durationMs: Math.max(0, Date.now() - Number(session.current().startedAt || Date.now())),
					},
					evidence: [
						...buildReflectionEvidence({
							stages: session.current().checkpoints,
							actions: pendingActions,
						}),
						// The decision->outcome ledger: facts reflection needs to
						// say something about CHOICES, not just about the outcome.
						...routeLedger.lines(),
					],
				},
			});
			console.log(
				report.ok
					? `[evolution] reflection: ${report.lessonsSaved} lesson(s) kept, ` +
							`${report.strategiesPromoted} strategy card(s) promoted`
					: `[evolution] reflection failed: ${report.error}`,
			);
		} catch (err) {
			console.log(`[evolution] reflection error: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return reachedDone ? 0 : 1;
}
