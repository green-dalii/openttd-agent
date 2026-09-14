/**
 * Agent tools — the LLM's action surface (SPEC §4.3 first batch).
 *
 * 职责: 把「高层动作」暴露成 pi-agent-core AgentTool：observe / build_bus_route /
 *   add_vehicles / set_pause。每个工具只做参数校验 + 通过注入的 CommandSink
 *   发命令（异步、立即 ack），不等待施工完成（施工是分钟级异步过程）。
 * 事实来源: SPEC §4.3；命令通道 = gameScript(JSON)→BridgeV1 GS→标牌→Executor。
 * 禁止: 在此层等待施工结果；禁止绕过 AgentDeps 直接 new AdminClient。
 */

import { Type, type TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ActionResult, AgentDeps } from "../types.js";
import type { WorldSnapshot } from "../../game/world-state.js";
import { estimateRoute } from "../estimate.js";

/** Executor AI's company id on a fresh map (first company = 0). */
export const DEFAULT_COMPANY = 0;

/** Build a pi-agent-core tool result from a structured ActionResult. */
function toResult(r: ActionResult): {
	content: { type: "text"; text: string }[];
	details: ActionResult;
} {
	return { content: [{ type: "text", text: r.summary }], details: r };
}

/**
 * Compact, model-visible view of the towns: id, population and position.
 *
 * Population is the demand signal; x/y let the agent judge distance (a big town
 * across the map may be worse than a small one next door). Deliberately no
 * ranking beyond population - the ORDER is a fact about the world, the CHOICE is
 * the agent's.
 */
function townSummary(snap: WorldSnapshot): { id: number; pop: number; x: number; y: number }[] {
	// Sorted here rather than trusting the caller: the order the model sees must
	// be deterministic, and a plain snapshot (tests, replays) may not have gone
	// through WorldState.setTowns. Population descending is a fact about the
	// world; which of them to connect is the agent's call.
	return (snap.towns ?? [])
		.map((t) => ({ id: t.id, pop: t.population, x: t.x, y: t.y }))
		.sort((a, b) => b.pop - a.pop);
}

/**
 * Summarize a WorldSnapshot into a compact, JSON-safe, LLM-facing object.
 * Pure function — unit-testable without a game.
 */
export function summarizeState(snap: WorldSnapshot): Record<string, unknown> {
	const companies = [...snap.companies.values()].map((c) => ({
		id: c.info?.id ?? null,
		name: c.info?.name ?? null,
		isAi: c.info?.isAi ?? null,
		money: c.economy ? c.economy.money.toString() : null,
		loan: c.economy ? c.economy.loan.toString() : null,
		income: c.economy ? BigInt.asIntN(64, c.economy.income).toString() : null,
		vehicles: c.stats?.vehicles ?? null,
		stations: c.stats?.stations ?? null,
	}));
	return {
		date: snap.date ? `${snap.date.year}-${String(snap.date.month).padStart(2, "0")}-${String(snap.date.day).padStart(2, "0")}` : null,
		companies,
		// Candidate towns, largest first. This is what makes the route choice a
		// real decision instead of a single button press (SPEC §10.32): the agent
		// can weigh population against distance and live with the result.
		towns: (snap.towns ?? []).map((t) => ({ id: t.id, population: t.population, x: t.x, y: t.y })),
		recentEventCount: snap.recent.length,
		totalEvents: snap.totalEvents,
	};
}

const ObserveSchema = Type.Object({});

/** `observe` — return the current normalized state slice. */
export function observeTool(deps: AgentDeps): AgentTool<typeof ObserveSchema, ActionResult> {
	return {
		name: "observe",
		label: "Observe Game State",
		description:
			"Read the current normalized game state: date, companies (money/loan/income/vehicles/stations), and the candidate towns (id, population, x, y) that build_bus_route can connect.",
		parameters: ObserveSchema,
		execute: async () => {
			const snap = deps.state.snapshot();
			const state = summarizeState(snap);
			const r: ActionResult = {
				ok: true,
				// The towns MUST be in the summary, not only in `details`:
				// toResult() sends just `summary` as the model-visible text, so
				// anything left in `details` is effectively invisible. Putting the
				// candidates here is what turns "build a route" from a single
				// button press into a choice (SPEC §10.32).
				summary:
					`date=${state.date ?? "?"} companies=${JSON.stringify(state.companies)} ` +
					`towns=${JSON.stringify(townSummary(snap))}`,
				data: state,
			};
			return toResult(r);
		},
	};
}

const BuildRouteSchema = Type.Object({
	from_town: Type.Optional(Type.Number({ description: "Optional source town id" })),
	to_town: Type.Optional(Type.Number({ description: "Optional destination town id" })),
	company: Type.Optional(Type.Number({ description: "Executor company id (default 0)" })),
	job: Type.Optional(Type.Number({ description: "Optional job id for tracking" })),
});

/** `build_bus_route` — ask the Bridge GS to plan+place a bus route blueprint. */
export function buildBusRouteTool(deps: AgentDeps): AgentTool<typeof BuildRouteSchema, ActionResult> {
	return {
		name: "build_bus_route",
		label: "Build Bus Route",
		description:
			// States the contract only. The previous text said "Omit from_town/to_town
			// to let the planner pick the best pair", which told the agent that the
			// framework would decide for it - one of the two reasons the M3
			// experiment was saturated (SPEC §10.32).
			"Construct a bus route between two towns. from_town and to_town are town ids from observe(); when either is omitted the GS picks a pair itself. Returns as soon as the command is delivered - construction is asynchronous in-game, so observe() afterwards to see what actually happened.",
		parameters: BuildRouteSchema,
		execute: async (_id, params) => {
			const company = params.company ?? DEFAULT_COMPANY;
			const cmd: Record<string, unknown> = { cmd: "build_bus_route", company };
			if (params.from_town !== undefined) cmd.townA = params.from_town;
			if (params.to_town !== undefined) cmd.townB = params.to_town;
			if (params.job !== undefined) cmd.job = params.job;
			deps.sink.gameScript(JSON.stringify(cmd));
			const r: ActionResult = {
				ok: true,
				summary: `sent build_bus_route (company=${company}${params.from_town !== undefined ? `, from=${params.from_town}` : ""}${params.to_town !== undefined ? `, to=${params.to_town}` : ""}); construction runs asynchronously — poll observe() for progress`,
				data: cmd,
			};
			return toResult(r);
		},
	};
}

const AddVehiclesSchema = Type.Object({
	count: Type.Number({ description: "Total vehicles desired on the route (>=1)", minimum: 1, maximum: 20 }),
	company: Type.Optional(Type.Number({ description: "Executor company id (default 0)" })),
	job: Type.Optional(Type.Number({ description: "Route job id (default: current)" })),
});

/** `add_vehicles` — scale the active route's fleet (clones the lead vehicle). */
export function addVehiclesTool(deps: AgentDeps): AgentTool<typeof AddVehiclesSchema, ActionResult> {
	return {
		name: "add_vehicles",
		label: "Add Vehicles",
		description:
			"Add road vehicles to an ALREADY RUNNING bus route (clones share its orders). " +
			"It clones the route's lead vehicle, so it cannot create the first one — if the " +
			"route has no vehicles yet, wait for construction to finish instead.",
		parameters: AddVehiclesSchema,
		execute: async (_id, params) => {
			const company = params.company ?? DEFAULT_COMPANY;

			// Refuse when the request cannot possibly work, instead of claiming success.
			//
			// 真实事故（2026-09-12，用户 e2e）:决策 24~27 连续 `add_vehicles ok=true`，
			// 而 `vehicles` 始终为 0。工具以前无条件返回 `ok=true`——它只说明
			// "我把命令写进了 socket"，既不等于标牌被读到，也不等于车队变了。
			//
			// 而这条命令在 0 车时**永远不可能生效**:
			//   1. GS 的 ack `placed:1` 是"标牌放好了"，不是"放了 1 台车"；
			//   2. 执行器只在 `_stage=="done" && _vehicle>=0` 时才去读那个标牌；
			//   3. `CheckAddVehicles` 靠**克隆头车**扩容，没有头车就静默 return。
			// 于是模型得到的是"成功"，只能无限重试同一个动作——**一个永远说谎的工具
			// 让 agent 丧失了学习能力**。工具能看见 vehicles（observe 用的就是它），
			// 所以没有理由不说真话。
			const snap = deps.state.snapshot();
			const c0 = snap.companies.get(company);
			const vehicles = c0?.stats?.vehicles ?? null;
			if (vehicles === null) {
				return toResult({
					ok: false,
					// Contract only. No "call observe() first" - that is strategy, and
					// strategy in the harness deletes the lesson the agent would learn.
					summary:
						`not sent: company ${company} has no reported stats, so the fleet size is ` +
						"unknown and cannot be scaled.",
					data: { company, vehicles: null },
				});
			}
			if (vehicles === 0) {
				return toResult({
					ok: false,
					summary:
						`not sent: company ${company} has 0 vehicles. add_vehicles scales an ` +
						"existing fleet by cloning the route's lead vehicle; with no vehicles " +
						"there is nothing to clone.",
					data: { company, vehicles },
				});
			}

			const cmd: Record<string, unknown> = { cmd: "add_vehicles", company, count: params.count };
			if (params.job !== undefined) cmd.job = params.job;
			deps.sink.gameScript(JSON.stringify(cmd));
			const r: ActionResult = {
				ok: true,
				summary:
					`requested fleet size ${params.count} (company=${company}, vehicles before this ` +
					`request: ${vehicles}). This reports the REQUEST, not the resulting fleet; ` +
					"observe() reports the fleet.",
				data: { ...cmd, vehiclesBefore: vehicles },
			};
			return toResult(r);
		},
	};
}

const SetPauseSchema = Type.Object({
	paused: Type.Boolean({ description: "true to pause, false to resume" }),
});

/** `set_pause` — pause/resume the dedicated server. */
export function setPauseTool(deps: AgentDeps): AgentTool<typeof SetPauseSchema, ActionResult> {
	return {
		name: "set_pause",
		label: "Pause/Resume Game",
		description: "Pause or unpause the running OpenTTD server (server-level RCON).",
		parameters: SetPauseSchema,
		execute: async (_id, params) => {
			deps.sink.rcon(params.paused ? "pause" : "unpause");
			const r: ActionResult = {
				ok: true,
				summary: `rcon ${params.paused ? "pause" : "unpause"} sent`,
				data: { paused: params.paused },
			};
			return toResult(r);
		},
	};
}

/** Assemble the first tool batch (SPEC §4.3). */

const EstimateRouteSchema = Type.Object({
	from: Type.Integer({ description: "from town id" }),
	to: Type.Integer({ description: "to town id" }),
});

/** `estimate_route` — facts about a candidate line BEFORE spending anything.
 *
 * This is the click-to-inspect channel for siting decisions (SIGNAL-ARCHITECTURE
 * L2). It exists because §10.34 measured what happens without it: the agent saw
 * only population, so "take the two biggest" was the only strategy it could form,
 * and it picked a pair 104 straight-tiles apart that construction could not finish.
 * Distance and cost are world facts; which pair to build is still the agent's call.
 */
function estimateRouteTool(deps: AgentDeps): AgentTool<typeof EstimateRouteSchema, ActionResult> {
	return {
		name: "estimate_route",
		label: "Estimate Route",
		description:
			"Estimate a candidate bus line between two towns WITHOUT building: straight-line " +
			"tile distance and a road-only cost lower bound vs the company balance. " +
			"Call before build_bus_route to compare candidate pairs.",
		parameters: EstimateRouteSchema,
		execute: async (_id, params) => {
			const snap = deps.state.snapshot();
			const towns = snap.towns ?? [];
			const from = towns.find((t) => t.id === params.from);
			const to = towns.find((t) => t.id === params.to);
			if (!from || !to) {
				return toResult({
					ok: false,
					summary: `unknown town id(s): ${!from ? params.from : ""}${!from && !to ? ", " : ""}${!to ? params.to : ""}. Call observe() for valid ids.`,
					data: { from: params.from, to: params.to, known: towns.map((t) => t.id) },
				});
			}
			const c0 = snap.companies.get(DEFAULT_COMPANY);
			const balance = c0?.economy ? Number(c0.economy.money) : null;
			const est = estimateRoute(from, to, balance);
			return toResult({
				ok: true,
				// Facts in the summary (toResult sends ONLY the summary - MEMORY A7).
				// No preference is stated: the agent weighs these numbers itself.
				summary:
					`towns ${est.fromTown}->${est.toTown}: ${est.straightTiles} straight tiles ` +
					`(real road is longer); road-only cost >= £${est.roadCostLowerBound} ` +
					"(stations/depot/vehicles extra); balance £" +
					(balance === null ? "?" : String(balance)) +
					(est.roadCostShareOfBalance === null
						? ""
						: `; road alone = ${(est.roadCostShareOfBalance * 100).toFixed(0)}% of balance`),
				data: est,
			});
		},
	};
}

export function createTools(deps: AgentDeps): AgentTool<TSchema, ActionResult>[] {
	return [
		observeTool(deps),
		estimateRouteTool(deps),
		buildBusRouteTool(deps),
		addVehiclesTool(deps),
		setPauseTool(deps),
	];
}
