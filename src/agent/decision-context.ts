/**
 * Decision context — what the framework hands the LLM at each decision point.
 *
 * 职责: 组装**事实 + 因果**：现状、自上次决策以来的变化、上次动作的结果、
 *   压缩后的阶段总结（长程记忆）。让模型能判断"我上次改的东西有没有用"。
 * 为什么存在: 没有 `sinceLastDecision`，模型每次只看到孤立快照，无法复盘自己的
 *   动作效果 → 表现为"无脑"（v0.5.0 前真机 Session 已证实）。见
 *   docs/AGENT-LOOP-AND-CONTROL.md §2.2。
 * 事实来源: docs/AGENT-LOOP-AND-CONTROL.md §1/§2。
 * 禁止:
 *   - **给出任何策略、建议、优先级或"应该做什么"**（§2.4）。框架只是框架；
 *     智能必须来自 LLM。文案里出现 "you should"/"recommend" 即违规。
 *   - 依赖 IO、时间或全局状态（纯函数，便于单测）。
 */

import { decodePhaseWindow } from "../game/executor-status.js";

/**
 * One route as the model sees it. `townA/townB` are present only when the
 * ledger knows which towns the job was ordered for (the GS reports economics by
 * job, the ledger knows the pair) - absent fields are absent, never zeroed.
 */
export interface RouteContextFact {
	job: number;
	townA?: number;
	townB?: number;
	vehicles: number;
	waiting: number;
	profit: number;
	gameDate: number;
}

/** One company's comparable numbers in the payload. */
/** Model-visible town fact: identity, demand signal, position. */
export interface TownSummary {
	id: number;
	pop: number;
	x: number;
	y: number;
}

export interface CompanyNumbers {
	id: number;
	money: number | null;
	income: number | null;
	vehicles: number | null;
	stations: number | null;
}

/** Snapshot used as the baseline for the next delta. */
export interface NumbersBaseline {
	money: number;
	income: number;
	vehicles: number;
	stations: number;
	gameDay: number;
}

/** What the LLM did since the previous decision. */
export interface ActionRecord {
	tool: string;
	ok: boolean;
	summary: string;
}

/** Accumulates the window between two decisions. */
export interface DecisionTracker {
	baseline: NumbersBaseline | null;
	phases: string[];
	actions: ActionRecord[];
	notableEvents: string[];
}

export interface DecisionContextInput {
	trigger: DecisionTrigger;
	now: { date: string | null; companies: CompanyNumbers[] };
	/**
	 * Candidate towns, largest first. Present in EVERY decision context, not
	 * only inside observe(): the siting choice is the game's central decision
	 * (SPEC §10.34) and a candidate list the model must fetch with a tool call
	 * is a candidate list it often works without. Facts only - ids, population,
	 * position - never a ranking beyond population order.
	 */
	towns?: TownSummary[];
	/**
	 * How much wall-clock session remains, in seconds. A FACT about the episode
	 * boundary (like a human knowing how long the session lasts), not advice:
	 * the model uses it to budget its own decisions. Measured failure without it
	 * (2026-09-12, /tmp/cal1): the model spent its first decision exploring,
	 * then asked to sleep until 1950-04-01 - the run ended before it woke, and
	 * its plan ("start with a cheap pair") was never executed.
	 */
	session?: {
		/** Wall-clock seconds left; absent when no wall cap is set. */
		secondsRemaining?: number;
		/**
		 * The clock in SIMULATED units (G1, SPEC §10.68). Construction is bounded
		 * by simulated time, so "will this finish in time?" cannot be answered
		 * with wall seconds - the model needs the unit the work is measured in.
		 */
		simulatedDays?: number;
		gameDaysRemaining?: number;
	};
	since: DecisionTracker;
	/**
	 * Economics of the lines already ordered (NEXT-2 N2-2b): vehicles on the
	 * route, passengers waiting, year-to-date profit, game-day for rate math.
	 * Present in EVERY decision context for the same measured reason `towns` is
	 * (SPEC §10.34): a fact that requires a tool call is a fact the model works
	 * without. Facts only - no target, no advice.
	 */
	routes?: RouteContextFact[];
	/**
	 * Construction facts from the executor (G2, SPEC §10.67 layer 3): tiles still
	 * to go, measured tiles/game day, ETA in game days, and how long the road has
	 * NOT advanced. The episode is decided by this process, so leaving it out left
	 * the agent to fill the blind spot with polling (193 tool calls in one run).
	 */
	executor?: ExecutorFact;
	/** Total game days elapsed since run start (for the interval baseline). */
	gameDay?: number;
	/** Compressed stage summaries ("阶段性总结"), oldest first. */
	history?: string[];
	/** Most recent executor phase, for continuity. */
	phase?: string;
}

/**
 * Why the model is being asked. `wait_until` is the model's OWN requested wake-up
 * (SPEC §4.2 step 5: "到达下一决策点或等待条件满足"), so the model controls its
 * own cadence while `interval` remains the framework's fallback beat.
 */
export type DecisionTrigger = "start" | "phase_change" | "wait_until" | "interval" | "event" | "manual";

/** Independent caps so no single list can blow up the context. */
const MAX_PHASES = 12;
const MAX_ACTIONS = 12;
const MAX_EVENTS = 12;
const MAX_HISTORY = 12;

function cap<T>(list: T[], max: number): T[] {
	return list.length > max ? list.slice(list.length - max) : list;
}

/** A fresh window. Pass a baseline to start comparing from that point. */
export function emptyTracker(baseline: NumbersBaseline | null = null): DecisionTracker {
	return { baseline, phases: [], actions: [], notableEvents: [] };
}

/** Record a construction phase transition (world changed on its own). */
export function recordPhase(t: DecisionTracker, phase: string): void {
	if (!phase) return;
	t.phases = cap([...t.phases, phase], MAX_PHASES);
}

/** Record what the LLM did, including failures (never silent, docs §2.4). */
export function recordAction(t: DecisionTracker, action: ActionRecord): void {
	t.actions = cap([...t.actions, action], MAX_ACTIONS);
}

/** Record a notable game event worth the model's attention. */
export function recordEvent(t: DecisionTracker, summary: string): void {
	if (!summary) return;
	t.notableEvents = cap([...t.notableEvents, summary], MAX_EVENTS);
}

/** Signed changes between two sets of numbers. */
export function summarizeDelta(
	from: NumbersBaseline,
	to: NumbersBaseline,
): {
	moneyDelta: number;
	incomeDelta: number;
	vehiclesDelta: number;
	stationsDelta: number;
	elapsedGameDays: number;
} {
	return {
		moneyDelta: to.money - from.money,
		incomeDelta: to.income - from.income,
		vehiclesDelta: to.vehicles - from.vehicles,
		stationsDelta: to.stations - from.stations,
		elapsedGameDays: to.gameDay - from.gameDay,
	};
}

/** First company's numbers, or zeros (a fresh run may have none yet). */
function leadCompany(companies: CompanyNumbers[]): CompanyNumbers | undefined {
	return companies.find((c) => c.id === 0) ?? companies[0];
}

function numbersOf(c: CompanyNumbers | undefined, gameDay: number): NumbersBaseline {
	return {
		// nulls mean "not observed yet" - treat as 0 so deltas stay finite.
		money: Number(c?.money ?? 0) || 0,
		income: Number(c?.income ?? 0) || 0,
		vehicles: Number(c?.vehicles ?? 0) || 0,
		stations: Number(c?.stations ?? 0) || 0,
		gameDay,
	};
}

/**
 * Build the payload for one decision. Pure: no IO, no clock.
 *
 * The result contains only observations; it never advises (docs §2.4).
 */
/** Construction facts (G2): measured, never advised. */
export interface ExecutorFact {
	/** Job the executor is working on. */
	job: number | null;
	/** Tiles still to go to the far station. */
	remainingTiles: number | null;
	/** Measured tiles per game day (null while the road has not advanced). */
	tilesPerDay: number | null;
	/** Game days to finish at the measured rate. */
	etaDays: number | null;
	/**
	 * Game days since the reported tiles-to-go last CHANGED. Searching does not
	 * count as progress, and phases that carry no distance (heartbeats, station
	 * work) do not refresh it - so this can read stale rather than stalled.
	 */
	stalledDays: number | null;
	/** Distinct jobs this executor has worked on (FIFO evidence). */
	jobsSeen: number;
}

export function buildDecisionContext(input: DecisionContextInput): {
	trigger: DecisionTrigger;
	now: { date: string | null; companies: CompanyNumbers[] };
	towns?: TownSummary[];
	session?: {
		/** Wall-clock seconds left; absent when no wall cap is set. */
		secondsRemaining?: number;
		/**
		 * The clock in SIMULATED units (G1, SPEC §10.68). Construction is bounded
		 * by simulated time, so "will this finish in time?" cannot be answered
		 * with wall seconds - the model needs the unit the work is measured in.
		 */
		simulatedDays?: number;
		gameDaysRemaining?: number;
	};
	sinceLastDecision: {
		elapsedGameDays: number;
		moneyDelta: number;
		incomeDelta: number;
		vehiclesDelta: number;
		stationsDelta: number;
		/**
		 * Executor phase changes since the last decision, DECODED.
		 *
		 * Raw phase strings (`EX rd s0 r0 j100`) are internal telemetry: their
		 * grammar lives only in the Squirrel source, so handing them to the model
		 * is handing it noise. Decoding is an interface-vocabulary fix, not
		 * advice - the model still decides what a phase means for its plan.
		 * src/game/executor-status.ts.
		 */
		phases: { phase: string; description: string; error: boolean }[];
		actions: ActionRecord[];
		notableEvents: string[];
	};
	history: string[];
	phase?: string;
	routes?: RouteContextFact[];
	/**
	 * Construction facts from the executor (G2, SPEC §10.67 layer 3): tiles still
	 * to go, measured tiles/game day, ETA in game days, and how long the road has
	 * NOT advanced. The episode is decided by this process, so leaving it out left
	 * the agent to fill the blind spot with polling (193 tool calls in one run).
	 */
	executor?: ExecutorFact;
} {
	const gameDay = input.gameDay ?? 0;
	const current = numbersOf(leadCompany(input.now.companies), gameDay);
	const from = input.since.baseline ?? current; // first decision: no change yet
	const delta = summarizeDelta(from, current);

	return {
		trigger: input.trigger,
		now: input.now,
		...(input.towns ? { towns: input.towns } : {}),
		...(input.routes && input.routes.length > 0 ? { routes: input.routes } : {}),
		...(input.executor ? { executor: input.executor } : {}),
		...(input.session ? { session: input.session } : {}),
		sinceLastDecision: {
			...delta,
			// Heartbeats are collapsed by decodePhaseWindow: 40 identical
			// "still alive" lines would bury the one line that actually changed.
			phases: decodePhaseWindow(input.since.phases).map((d) => ({
				phase: d.phase,
				description: d.description,
				error: d.error,
			})),
			actions: [...input.since.actions],
			notableEvents: [...input.since.notableEvents],
		},
		history: cap([...(input.history ?? [])], MAX_HISTORY),
		...(input.phase ? { phase: input.phase } : {}),
	};
}
