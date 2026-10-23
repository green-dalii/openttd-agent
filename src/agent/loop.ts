/**
 * Agent decision loop — orchestrate one decision point (SPEC §4.2).
 *
 * 职责: 在「决策点」采集状态 → 组装**现状 + 因果**（自上次决策以来的变化、
 *   上次动作的结果、压缩后的阶段总结）→ 交给 pi-agent-core Agent 决策 →
 *   执行其工具调用（经注入的 CommandSink，异步非阻塞）→ 记录审计。
 * 为什么这样设计: 框架只呈现事实与能力边界，**不做任何策略引导**；智能全部来自
 *   LLM。真机证据：早先 prompt 里写"施工中就报告并结束回合"，等于替模型做了决定。
 *   见 docs/AGENT-LOOP-AND-CONTROL.md §1/§2。
 * 事实来源: SPEC §4.2（决策循环细粒度）、§4.1（hooks）；
 *   docs/AGENT-LOOP-AND-CONTROL.md §2。
 * 禁止:
 *   - **在 prompt 里给建议、优先级或"应该…"**（§2.4）。文案必须是纯事实。
 *   - 阻塞等待施工完成；在此模块直接触网（provider 由 runtime 注入）。
 *   - 因为有触发器就跳过决策（旧实现"施工中就结束回合"即此类错误）。
 */

/* eslint-disable no-console -- intentional runtime logging */
import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentDeps } from "./types.js";
import type { ExecutorFact, RouteContextFact } from "./decision-context.js";
import type { ScoreFact } from "./score.js";
import { formatRouteStats } from "./route-stats.js";
import { formatScoreFact } from "./score.js";
import { worldFacts } from "./world-facts.js";
import {
	buildDecisionContext,
	type ActionRecord,
	type DecisionTracker,
	type DecisionTrigger,
} from "./decision-context.js";

export interface DecisionLoopOptions {
	agent: Agent;
	deps: AgentDeps;
	/** Max decisions to run before returning (safety bound). */
	maxTurns?: number;
	/** Called after each decision turn for logging/audit. */
	onTurn?: (info: { turn: number; state: Record<string, unknown> }) => void;
}

export interface DecisionLoopResult {
	turns: number;
	/** Final observation the loop saw. */
	lastState: Record<string, unknown>;
}

/** Everything the loop needs to phrase one decision without steering. */
export interface DecisionRequest {
	trigger: DecisionTrigger;
	tracker: DecisionTracker;
	/** Total game days since run start (for interval scheduling). */
	gameDay?: number;
	/** Compressed stage summaries, oldest first. */
	history?: string[];
	/** Latest executor phase name, if known. */
	phase?: string;
	/** Wall-clock seconds left in the session (episode-boundary fact). */
	secondsRemaining?: number;
	/** Simulated days elapsed in this episode (G1, SPEC §10.68). */
	simulatedDays?: number;
	/** Simulated days left before the episode horizon. */
	gameDaysRemaining?: number;
	/** Economics of lines already ordered (N2-2b); joined hub stats + ledger pairs. */
	routes?: RouteContextFact[];
	/** Construction facts (G2): the process that decides the episode. */
	executor?: ExecutorFact;
	/**
	 * The agent's own score facts (S1): what this run has delivered so far.
	 * Built by the decision loop from the world state at decision time.
	 */
	score?: ScoreFact;
}

/**
 * Run one decision: build the context and prompt the agent.
 * The agent calls tools (observe/build_bus_route/...) as it sees fit.
 */
export async function runDecision(
	agent: Agent,
	deps: AgentDeps,
	req: DecisionRequest,
): Promise<{ state: Record<string, unknown>; plan: DecisionPlan | null }> {
	// D2/S2: the world is projected ONCE, canonically (same fields, same order as
	// observe()) - the model used to see the towns twice in two shapes.
	const facts = worldFacts(deps.state.snapshot());
	const context = buildDecisionContext({
		trigger: req.trigger,
		now: { date: facts.date, companies: facts.companies },
		// The agent's own score (S1). Without it the model is told how runs are
		// scored and never sees what it scored - no self-assessment, no credit
		// assignment. Facts only; the block carries nulls for unknowns.
		...(req.score ? { score: req.score } : {}),
		// Candidate towns ride along in EVERY decision context. §10.34 measured the
		// alternative: towns reachable only via observe() meant the model sat through
		// whole games without ever seeing its siting options.
		towns: facts.towns,
		// Same lesson, new signal (N2-2b): the economics of the lines already
		// ordered ride along too, so "is my route actually working" is visible
		// without a tool call. A route with no reading yet is simply absent.
		...(req.routes && req.routes.length > 0 ? { routes: req.routes } : {}),
		...(req.executor ? { executor: req.executor } : {}),
		// The episode boundary in BOTH units: wall seconds (how long we will wait)
		// and simulated days (how much world is left). Construction is bounded by
		// simulated time, so the second one is the unit the model must plan in;
		// forwarding only the wall clock was a silent interface gap (G1/D18).
		...((req.secondsRemaining !== undefined ||
			req.simulatedDays !== undefined ||
			req.gameDaysRemaining !== undefined)
			? {
					session: {
						...(req.secondsRemaining !== undefined ? { secondsRemaining: req.secondsRemaining } : {}),
						...(req.simulatedDays !== undefined ? { simulatedDays: req.simulatedDays } : {}),
						...(req.gameDaysRemaining !== undefined ? { gameDaysRemaining: req.gameDaysRemaining } : {}),
					},
				}
			: {}),
		since: req.tracker,
		...(req.gameDay !== undefined ? { gameDay: req.gameDay } : {}),
		...(req.history ? { history: req.history } : {}),
		...(req.phase ? { phase: req.phase } : {}),
	});

	// Make the injected route facts visible in the run log: without this line the
	// only way to know whether the model was ever shown "6 vehicles, 146 waiting,
	// -308 profit" is to trust the code (MEMORY A7: facts left in `details` are
	// invisible; the same trap applies to facts that are built but never logged).
	if (context.routes && context.routes.length > 0) {
		console.log(`[agent] route facts: ${context.routes.map((r) => formatRouteStats(r)).join("; ")}`);
	}

	// Same reason for construction facts (G2): they must be checkable from the run
	// log, not merely believed. "ETC" here is a measured projection at the current
	// rate - the fact that lets the model judge whether a plan fits the episode.
	if (context.executor) {
		const e = context.executor;
		const parts = [
			`job ${e.job}`,
			e.remainingTiles !== null ? `${e.remainingTiles} tiles to go` : "distance unknown",
			e.tilesPerDay !== null ? `${e.tilesPerDay.toFixed(2)} tiles/game-day` : "no advance yet",
			e.etaDays !== null ? `ETA ~${Math.round(e.etaDays)} game days` : "no ETA",
			// Precisely what we measured: a reported stage without a distance does
			// not update this, so it can read stale rather than stalled.
			e.stalledDays !== null ? `tiles-to-go unchanged for ${e.stalledDays} game days` : "not started",
			`${e.jobsSeen} job(s) seen`,
		];
		console.log(`[agent] executor facts: ${parts.join(", ")}`);
	}

	// Same reason for the score facts (S1): the model must be able to check
	// from the run log what it was shown, not merely believe it (MEMORY A7).
	if (context.score) {
		console.log(`[agent] score: ${formatScoreFact(context.score)}`);
	}

	// Deltas too (D1b/S3): the whole point of the change is that "not measured"
	// is distinguishable from "no change" - and that is only checkable if the
	// run log shows it.
	{
		const s = context.sinceLastDecision;
		const show = (v: number | null): string => (v === null ? "unknown" : String(v));
		console.log(
			`[agent] deltas: baseline=${s.baselineEstablished ? "established" : "none"}` +
				` money=${show(s.moneyDelta)} income=${show(s.incomeDelta)}` +
				` vehicles=${show(s.vehiclesDelta)} stations=${show(s.stationsDelta)}` +
				` elapsedGameDays=${show(s.elapsedGameDays)}`,
		);
	}

	// D2/S2: the world snapshot is NOT appended as a second message any more.
	// It never reached the model (`convertToLlm` filters `game_observation` out),
	// and the audit trail already records the same snapshot per decision - so
	// every decision used to keep a third copy of the same facts.
	//
	// What the model reads is the prompt below: one canonical projection of the
	// world (same fields and order as observe()).

	// SPEC §4.2 step 2: the model returns a STRUCTURED decision.
	// The framework specifies the *interface* (it must know when to wake the model
	// again) but never the *content* - filling in goal/plan/wait_until is entirely
	// the model's job (docs/AGENT-LOOP-AND-CONTROL.md §2.4).
	const prompt =
		`Decision point (trigger: ${req.trigger}).\n` +
		`Facts, nothing else is implied by their order:\n` +
		`${JSON.stringify(context, null, 1)}\n\n` +
		`After using any tools you need, state your decision as JSON with these keys:\n` +
		`{"goal": string, "plan": string[], "immediate_action": string, ` +
		`"wait_until": {"game_days": number} | {"condition": string} | null, "rationale": string}\n` +
		`wait_until tells the framework when to ask you again; use null to accept the default beat.`;

	await agent.prompt(prompt);
	return { state: facts as unknown as Record<string, unknown>, plan: extractPlan(agent) };
}

/** A structured decision as defined by SPEC §4.2 step 2. */
export interface DecisionPlan {
	goal?: string;
	plan?: string[];
	immediate_action?: string;
	wait_until?: { game_days?: number; condition?: string } | null;
	rationale?: string;
}

/**
 * Pull the plan JSON out of the model's reply.
 *
 * Never throws and never fabricates: a model that only calls tools (or answers in
 * prose) yields `null`, and the scheduler falls back to its monthly beat. Parsing
 * failure must not stop the run (docs/AGENT-LOOP-AND-CONTROL.md §2.1.1).
 */
export function extractPlan(agent: Agent): DecisionPlan | null {
	const msgs = agent.state.messages as { role?: string; content?: unknown }[];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (!m || m.role !== "assistant") continue;
		const text = textOf(m.content);
		if (!text) continue;
		const parsed = parsePlanFrom(text);
		if (parsed) return parsed;
	}
	return null;
}

/** Concatenate the text parts of an assistant message. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text"
			? String((c as { text?: unknown }).text ?? "")
			: ""))
		.join("");
}

/** Find the last JSON object in the text that looks like a plan. */
function parsePlanFrom(text: string): DecisionPlan | null {
	const starts: number[] = [];
	for (let i = 0; i < text.length; i++) if (text[i] === "{") starts.push(i);
	// Scan from the right: the plan is normally the final JSON block.
	for (let s = starts.length - 1; s >= 0; s--) {
		const from = starts[s]!;
		const end = matchingBrace(text, from);
		if (end < 0) continue;
		try {
			const obj = JSON.parse(text.slice(from, end + 1)) as DecisionPlan;
			// Only accept objects that actually carry decision fields, so an
			// unrelated JSON blob (e.g. an echoed observation) is ignored.
			if (obj && typeof obj === "object" &&
				("goal" in obj || "wait_until" in obj || "plan" in obj || "rationale" in obj)) {
				return obj;
			}
		} catch {
			/* try an earlier brace */
		}
	}
	return null;
}

/** Index of the brace matching the one at `from`, or -1. */
function matchingBrace(text: string, from: number): number {
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = from; i < text.length; i++) {
		const ch = text[i]!;
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Drive up to `maxTurns` decisions. Callers normally drive one decision per
 * scheduler tick (see scheduler.ts) rather than looping tightly, because
 * construction is asynchronous.
 */
export async function runDecisionLoop(opts: DecisionLoopOptions): Promise<DecisionLoopResult> {
	const maxTurns = opts.maxTurns ?? 1;
	let turns = 0;
	let lastState: Record<string, unknown> = {};
	for (let i = 0; i < maxTurns; i++) {
		const r = await runDecision(opts.agent, opts.deps, {
			trigger: "interval",
			tracker: { baseline: null, phases: [], actions: [], notableEvents: [] },
		});
		lastState = r.state;
		turns++;
		opts.onTurn?.({ turn: turns, state: lastState });
	}
	return { turns, lastState };
}

/** Re-export for callers that only need the action shape. */
export type { ActionRecord };
