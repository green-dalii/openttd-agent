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
			"Read the current normalized game state (date, companies with money/loan/income, vehicles, stations). Call before deciding an action.",
		parameters: ObserveSchema,
		execute: async () => {
			const state = summarizeState(deps.state.snapshot());
			const r: ActionResult = {
				ok: true,
				summary: `date=${state.date ?? "?"} companies=${JSON.stringify(state.companies)}`,
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
			"Plan and construct a bus route between two towns. Omit from_town/to_town to let the planner pick the best pair. Returns immediately (construction is asynchronous in-game).",
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

/** `add_vehicles` — ask the Executor to clone vehicles onto the active route. */
export function addVehiclesTool(deps: AgentDeps): AgentTool<typeof AddVehiclesSchema, ActionResult> {
	return {
		name: "add_vehicles",
		label: "Add Vehicles",
		description:
			"Add road vehicles to the active bus route (clones share the route's orders). Use when station queues grow and one bus cannot clear them.",
		parameters: AddVehiclesSchema,
		execute: async (_id, params) => {
			const company = params.company ?? DEFAULT_COMPANY;
			const cmd: Record<string, unknown> = { cmd: "add_vehicles", company, count: params.count };
			if (params.job !== undefined) cmd.job = params.job;
			deps.sink.gameScript(JSON.stringify(cmd));
			const r: ActionResult = {
				ok: true,
				summary: `sent add_vehicles count=${params.count} (company=${company})`,
				data: cmd,
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
export function createTools(deps: AgentDeps): AgentTool<TSchema, ActionResult>[] {
	return [observeTool(deps), buildBusRouteTool(deps), addVehiclesTool(deps), setPauseTool(deps)];
}
