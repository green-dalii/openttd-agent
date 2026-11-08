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
import { capabilitiesTool, requireRecall, requireRouteStats } from "./catalog.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ActionResult, AgentDeps } from "../types.js";
import { worldFacts } from "../world-facts.js";
import { formatRouteStats } from "../route-stats.js";
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
const ObserveSchema = Type.Object({});

/** `observe` — return the current normalized state slice. */
export function observeTool(deps: AgentDeps): AgentTool<typeof ObserveSchema, ActionResult> {
	return {
		name: "observe",
		label: "Observe Game State",
		description:
			"Read the current normalized game state: date, companies (money/loan/income/vehicles/stations), the candidate towns (id, name, population, x, y) that build_bus_route can connect, the cargo world (per-cargo produced/transported totals, the industries the engine sampled with their cargo label and id, the cargo catalogue - which cargo is freight, which industry produces it and which accepts it - and where every industry stands), and the road engines a fleet can be built from (id/name/speed and the cargo each engine carries).",
		parameters: ObserveSchema,
		execute: async () => {
			const snap = deps.state.snapshot();
			// D2/S2: the SAME canonical projection the decision context uses -
			// same fields, same order (the model used to see the towns twice in
			// two different shapes).
			const facts = worldFacts(snap);
			const r: ActionResult = {
				ok: true,
				// The towns MUST be in the summary, not only in `details`:
				// toResult() sends just `summary` as the model-visible text, so
				// anything left in `details` is effectively invisible. Putting the
				// candidates here is what turns "build a route" from a single
				// button press into a choice (SPEC §10.32).
				//
				// The cargo facts belong here for the same reason (SPEC §10.124):
				// the score is cargo tonnes, and until the cargo facts were
				// visible the model had no cargo to aim at - it built a passenger
				// line and the delivery reading stayed 0.
				summary:
					`date=${facts.date ?? "?"} companies=${JSON.stringify(facts.companies)} ` +
					`towns=${JSON.stringify(facts.towns)} ` +
					`cargoTotals=${JSON.stringify(facts.cargoTotals)} ` +
					`industries=${JSON.stringify(facts.industries)} ` +
					// 货运目录（货运 F1）：哪个货是货运、谁产、谁收 —— **引擎算出的事实**。
					// 没有它，模型看得见"哪里有煤"却看不见"谁要煤"。
					`cargoCatalog=${JSON.stringify(facts.cargoCatalog)} ` +
					// 全部产业的位置与名字：一条货运线路就是"哪座矿 → 哪座厂"。
					`industrySites=${JSON.stringify(facts.industrySites)} ` +
					// 货运 F3：**能装货的产方**（引擎按集货区算出来的收货能力）。
					// 没有它，模型看得见"哪里有煤"却不知道"哪里能装煤"。
					`freightLinks=${JSON.stringify(facts.freightLinks)} ` +
					`engines=${JSON.stringify(facts.engines)} ` +
					// 融资：还能借多少、贷款的最小单位（**利息率引擎不暴露**，不编）。
					`financing=${JSON.stringify(facts.financing)} ` +
					// 货运 F2：本公司口径的货运交付（单轴累计 + 缺口）——
					// 模型要看自己到底运了多少**货**（分数是"货物 + 客运"的合计）。
					`companyCargo=${JSON.stringify(facts.companyCargo)} ` +
					// 推送事件：车到了 / 车没了 / 产业开关（**引擎推给 GS 的事件**，
					// 以前被整个丢掉 ⇒ 模型看不到"我的车到了"）。
					`events=${JSON.stringify(facts.events)}`,
				data: facts,
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

/** How long an L2 query waits for the game's answer before giving up. */
export const INSPECT_TIMEOUT_MS = 5000;

const InspectVehicleSchema = Type.Object({
	vehicle: Type.Number({ description: "The vehicle id (from observe() / a route's vehicle list)" }),
});

const InspectTownSchema = Type.Object({
	town: Type.Number({ description: "The town id (from observe())" }),
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
			"Construct a bus route between two towns. from_town and to_town are town ids from observe(); when either is omitted the GS picks a pair itself. " +
			"Commands are QUEUED: routes are built in submission order, each to completion (station A, station B, road, depot, vehicle) before the next starts. " +
			"Returns as soon as the command is delivered - construction is asynchronous in-game, so observe() afterwards to see what actually happened.",
				// 游戏按 **FIFO** 应用命令（SPEC §10.39.1），所以这几条**变更型**工具必须串行：
		// pi-agent-core 的默认执行模式是 `parallel`，同一条助手消息里的两条命令会并发
		// 发出，台账（在完成时记录）的顺序就不再等于本局实际应用的顺序。ADR §10.74。
		executionMode: "sequential",
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

const BuildFreightRouteSchema = Type.Object({
	cargo: Type.String({
		description:
			"Cargo label to move, e.g. \"COAL\" (from observe()'s cargoCatalog / freightLinks). " +
			"Only freight cargoes can be moved by truck.",
	}),
	from_industry: Type.Number({
		description:
			"Producer industry id - the mine / farm / well the goods come from. " +
			"Must be one of the producers listed for this cargo.",
	}),
	to_industry: Type.Number({
		description:
			"Consumer industry id - the plant / power station the goods are delivered to. " +
			"Must be one of the consumers listed for this cargo.",
	}),
	company: Type.Optional(Type.Number({ description: "Executor company id (default 0)" })),
	job: Type.Optional(Type.Number({ description: "Optional job id for tracking" })),
});

/**
 * `build_freight_route` — order a freight line (truck stop → road → depot → truck).
 *
 * The split of labour (docs/FREIGHT-LINE-FEASIBILITY.md §3.2): the model decides
 * **what to move and where to**; the scaffold decides **how** (it finds the
 * station sites by the engine's own rules, lays the road, builds the depot and
 * buys/refits/starts the truck).
 *
 * The tool description states the contract only. It does not tell the model
 * which cargo or route to pick - that choice is the agent's (RL harness scope
 * audit, J1-J4).
 */
export function buildFreightRouteTool(deps: AgentDeps): AgentTool<typeof BuildFreightRouteSchema, ActionResult> {
	return {
		name: "build_freight_route",
		label: "Build Freight Route",
		description:
			"Order a freight line: move `cargo` from the producer industry `from_industry` to the " +
			"consumer industry `to_industry`. The engine computes which station sites can actually load " +
			"that cargo (a station only accepts a cargo when an accepting industry is in its catchment), " +
			"so a producer that cannot be loaded will be refused with a reason. " +
			"Commands are QUEUED: lines are built in submission order, each to completion (loading stop, " +
			"unloading stop, road, depot, truck) before the next starts. " +
			"Returns as soon as the command is delivered - construction is asynchronous in-game, so " +
			"observe() afterwards to see what actually happened.",
		// 变更型工具必须串行：同一条助手消息里的两条命令并发发出，台账的顺序
		// 就不再等于游戏实际应用的顺序（ADR §10.74）。
		executionMode: "sequential",
		parameters: BuildFreightRouteSchema,
		execute: async (_id, params) => {
			const company = params.company ?? DEFAULT_COMPANY;
			const cmd: Record<string, unknown> = {
				cmd: "build_freight_route",
				company,
				cargo: params.cargo,
				from_industry: params.from_industry,
				to_industry: params.to_industry,
			};
			if (params.job !== undefined) cmd.job = params.job;
			deps.sink.gameScript(JSON.stringify(cmd));
			const r: ActionResult = {
				ok: true,
				summary:
					`sent build_freight_route (company=${company}, cargo=${params.cargo}, ` +
					`from_industry=${params.from_industry}, to_industry=${params.to_industry}); ` +
					`construction runs asynchronously — poll observe() for progress`,
				data: cmd,
			};
			return toResult(r);
		},
	};
}

const SetRouteVehiclesSchema = Type.Object({
	count: Type.Number({
		description:
			"Target number of vehicles on the route (at least 1). Higher than the current fleet = more " +
			"vehicles; lower = fewer. 0 is not accepted: the environment treats a count below 1 as no " +
			"request at all, so a route cannot be emptied this way.",
		minimum: 1,
		maximum: 20,
	}),
	company: Type.Optional(Type.Number({ description: "Executor company id (default 0)" })),
	job: Type.Optional(Type.Number({ description: "Optional explicit job id; if omitted the GS assigns one. Re-sending a completed job id is ignored." })),
});

/**
 * `set_route_vehicles` — set the target fleet size of an already running route.
 *
 * M3-1（2026-09-19，SPEC §10.80）：这个动作**本来就是双向的**，但旧名字
 * （`add_vehicles`）与旧契约只讲扩容，于是"缩编"这个能力存在却从未被行使——
 * agent 不会去试一个名字叫"加车"的动作来减车。名字即契约。
 *
 * 环境事实（源码确证）：`V:<count>` 在低于当前车队时卖车（最新优先、永不卖头车），
 * 所以**下限是 1**；`count < 1` 被当作"没有请求"，不是"全部卖掉"。
 */
export function setRouteVehiclesTool(deps: AgentDeps): AgentTool<typeof SetRouteVehiclesSchema, ActionResult> {
	return {
		name: "set_route_vehicles",
		label: "Set Route Vehicles",
		description:
			"Set the target number of road vehicles on an ALREADY RUNNING bus route. A count ABOVE " +
			"the current fleet clones the route's lead vehicle (clones share its orders); a count " +
			"BELOW it sells the route's newest clones. The lead vehicle is never sold, so 1 is the " +
			"floor and a route cannot be emptied this way. It cannot create the first vehicle of a " +
			"route: with no vehicles there is nothing to clone. The executor attempts fleet requests " +
			"in any stage, but can only apply one when the route already has a lead vehicle (and a " +
			"depot to clone from), so a request can be deferred until then.",
				// 游戏按 **FIFO** 应用命令（SPEC §10.39.1），所以这几条**变更型**工具必须串行：
		// pi-agent-core 的默认执行模式是 `parallel`，同一条助手消息里的两条命令会并发
		// 发出，台账（在完成时记录）的顺序就不再等于本局实际应用的顺序。ADR §10.74。
		executionMode: "sequential",
		parameters: SetRouteVehiclesSchema,
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
						`not sent: company ${company} has 0 vehicles. This action changes the size of an ` +
						"EXISTING fleet by cloning the route's lead vehicle; with no vehicles there is " +
						"nothing to clone.",
					data: { company, vehicles },
				});
			}

			// 方向由请求与当前读数共同决定，且必须出现在 summary 里：模型据此才能
			// 区分"我请求了扩容"与"我请求了缩编"（数字相同、方向不同是两件事）。
			const direction = params.count > vehicles ? "grow" : params.count < vehicles ? "shrink" : "unchanged";
			// `cmd: "add_vehicles"` 是 **GS 的线上命令名**（协议，未改，改了要同步 Squirrel 与
			// 旧日志解析）；`set_route_vehicles` 才是**给 agent 看的工具名**。
			// 两者同名过一段时间，是"名字即契约"最容易骗人的地方——这里显式区分。
			const cmd: Record<string, unknown> = { cmd: "add_vehicles", company, count: params.count };
			if (params.job !== undefined) cmd.job = params.job;
			deps.sink.gameScript(JSON.stringify(cmd));
			// 执行器阶段是**请求何时会被读**的原因，因此必须一起回报（2026-09-19 真机证伪）：
			// `CheckAddVehicles()` 只在 `_stage == "done"` 时被调用（executor-ai/main.nut:115），
			// 所以施工期发来的请求只是**被推迟**。若不报这一条，模型只会看到
			// "请求了、什么都没变"，从而学到"请求车队没用"这种**错误因果**（D20）。
			const phase = typeof (c0?.info as { name?: unknown } | undefined)?.name === "string"
				? String((c0?.info as { name?: string }).name)
				: null;
			const r: ActionResult = {
				ok: true,
				summary:
					`requested fleet size ${params.count} (${direction}: currently ${vehicles}, ` +
					`company=${company}). This reports the REQUEST, not the resulting fleet; ` +
					"observe() reports the fleet." +
					(phase
						? ` The executor applies fleet requests when the route has a lead vehicle and a ` +
							`depot; its current phase is "${phase}".`
						: ""),
				data: { ...cmd, vehiclesBefore: vehicles, direction, executorPhase: phase },
			};
			return toResult(r);
		},
	};
}

const SetRouteCargoSchema = Type.Object({
	cargo: Type.Union([Type.String(), Type.Number()], {
		description:
			"Cargo to carry: a cargo LABEL as seen in observe() (e.g. \"PASS\", \"MAIL\") or a numeric cargo id. " +
			"The route's vehicles are refitted to it; vehicles whose engine cannot carry it stay as they are " +
			"and are reported as failures.",
	}),
	company: Type.Optional(Type.Number({ description: "Executor company id (default 0)" })),
	job: Type.Number({ description: "The route (job id) to refit." }),
});

/**
 * `set_route_cargo` — 选货（P1-2）：把一条线的车队改装到指定货物。
 *
 * 观测契约：改装的生效与否以**引擎回执**为准（RefitVehicle 的返回值逐车上报），
 * 不是工具自己的声称。具名失败：未知线/退役线/无此货物标签。
 */
export function setRouteCargoTool(deps: AgentDeps): AgentTool<typeof SetRouteCargoSchema, ActionResult> {
	void deps;
	return {
		name: "set_route_cargo",
		label: "Set Route Cargo",
		description:
			"Refit a running route's vehicles to a different cargo (by label, e.g. MAIL, or by numeric id). " +
			"This is how a route switches what it earns from. The executor refits each vehicle and reports " +
			"per-vehicle results; a vehicle whose engine cannot carry the cargo keeps its current one. " +
			"Unknown or retired routes are refused by name.",
		executionMode: "sequential",
		parameters: SetRouteCargoSchema,
		execute: async (_id, params) => {
			const cmd: Record<string, unknown> = { cmd: "set_route_cargo", company: params.company ?? DEFAULT_COMPANY, job: params.job, cargo: params.cargo };
			deps.sink.gameScript(JSON.stringify(cmd));
			return toResult({
				ok: true,
				summary: `sent set_route_cargo job=${params.job} cargo=${String(params.cargo)}; the executor refits the fleet and reports per-vehicle results in the event stream`,
				data: cmd,
			});
		},
	};
}

const SetRouteEngineSchema = Type.Object({
	engine: Type.Number({
		description:
			"Engine id from the road engine list in observe() (engines: id/name/speed). The route's vehicles " +
			"are replaced with this engine: new vehicles are bought first (same route, same cargo), then the " +
			"old ones are retired to the depot and sold, so capacity does not drop to zero.",
	}),
	company: Type.Optional(Type.Number({ description: "Executor company id (default 0)" })),
	job: Type.Number({ description: "The route (job id) to change." }),
});

/**
 * `set_route_engine` — 换车（P1-2）：把一条线的车队换成指定车型。
 *
 * 观测契约：新车 id 进登记表（fleetIds 变化 = 引擎真值）+ 具名相位
 * （reeng<n>e<engine>j<job>）。先买后卖：运力不断档。
 */
export function setRouteEngineTool(deps: AgentDeps): AgentTool<typeof SetRouteEngineSchema, ActionResult> {
	void deps;
	return {
		name: "set_route_engine",
		label: "Set Route Engine",
		description:
			"Replace a running route's vehicles with a different road engine (by engine id from observe()'s " +
			"engine list). The executor buys the new vehicles first (same orders and cargo), then sends the " +
			"old ones to the depot to be sold. Unknown or retired routes are refused by name.",
		executionMode: "sequential",
		parameters: SetRouteEngineSchema,
		execute: async (_id, params) => {
			const cmd: Record<string, unknown> = { cmd: "set_route_engine", company: params.company ?? DEFAULT_COMPANY, job: params.job, engine: params.engine };
			deps.sink.gameScript(JSON.stringify(cmd));
			return toResult({
				ok: true,
				summary: `sent set_route_engine job=${params.job} engine=${params.engine}; new vehicles are bought before the old ones are retired`,
				data: cmd,
			});
		},
	};
}

const SetPauseSchema = Type.Object({
	paused: Type.Boolean({ description: "true to pause, false to resume" }),
});

/** `set_pause` — pause/resume the dedicated server. */
const RetireRouteSchema = Type.Object({
	job: Type.Number({ description: "The route (blueprint job id) to retire." }),
	company: Type.Optional(Type.Number({ description: "Company id. Defaults to 0." })),
});

/**
 * Retire a route: stop serving it and sell **all** of its vehicles.
 *
 * 这是与"缩编"不同的动作，契约必须把区别说清，因为模型据此学因果：
 *   - 缩编有下限（头车永不卖），**退役没有**：整条线路（含头车）都会被卖掉；
 *   - 退役只对**执行器在本局建过**的线路有效（它只认自己的账）；
 *   - 车必须**停在车库内**才卖得掉，所以生效是逐步的（先回车库、再卖）。
 *
 * 最后一点是引擎前置条件（SPEC §10.84，`vehicle_cmd.cpp:261`），不是策略：
 * 不告诉模型，它只会看到"我请求了、车队没变"。
 */
export function retireRouteTool(deps: AgentDeps): AgentTool<typeof RetireRouteSchema, ActionResult> {
	return {
		name: "retire_route",
		label: "Retire Route",
		description:
			"Stop serving a bus route and sell its whole fleet, **including the lead vehicle** " +
			"(unlike set_route_vehicles, which never sells the lead and therefore cannot empty a " +
			"route). It only works for routes this executor built in the current session: it has no " +
			"record of anything else. Vehicles are sold only once they are parked in a depot, so the " +
			"fleet shrinks over the following game days rather than instantly.",
		executionMode: "sequential",
		parameters: RetireRouteSchema,
		execute: async (_id, params) => {
			const company = params.company ?? DEFAULT_COMPANY;
			const snap = deps.state.snapshot();
			const c0 = snap.companies.get(company);
			const phase =
				typeof (c0?.info as { name?: unknown } | undefined)?.name === "string"
					? String((c0?.info as { name?: string }).name)
					: null;
			const cmd = { cmd: "retire_route", company, job: params.job };
			deps.sink.gameScript(JSON.stringify(cmd));
			return toResult({
				ok: true,
				summary:
					`requested retirement of route ${params.job} (company=${company}). This reports the ` +
					"REQUEST, not the result: the executor sells the route's vehicles once they are " +
					"parked in a depot, so observe() is what reports the fleet." +
					(phase ? ` Its current phase is "${phase}".` : ""),
				data: { ...cmd, executorPhase: phase },
			});
		},
	};
}

const RecallSchema = Type.Object({
	query: Type.Optional(
		Type.String({
			description:
				"Words to look for in the recorded observations of earlier games. Matching is per word: " +
				"a record matches if any of your words appears in it, and records matching more of your " +
				"words come first. This is NOT semantic search - synonyms and rephrasing do not match. " +
				"Omit it to list the most recent records.",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Max records to return (default 5, max 20)." })),
});

/**
 * 按需检索自己过往的观测。
 *
 * 契约有三条必须说清的事实（模型据此学习因果）：
 *   ① 检索的是**本局装载的那份快照**（与开局注入的是同一份，计数一致）；
 *   ② 匹配是**子串**，不是语义；
 *   ③ 本局没有记忆时（控制臂）**明确拒绝**，而不是"空结果"——空结果会被读成"没记到过"。
 */
export function recallTool(deps: AgentDeps): AgentTool<typeof RecallSchema, ActionResult> {
	return {
		name: "recall",
		label: "Recall Observations",
		description:
			"Look up observations recorded at the end of earlier games (each carries the measured reading " +
			"it was distilled from). Matching is per word over the recorded text - a record matches if any " +
			"of your words appears in it, and records matching more of your words rank higher. It is not " +
			"semantic search, so rephrasing does not match. Use it when a past outcome would change what " +
			"you do now.",
		parameters: RecallSchema,
		execute: async (_id, params) => {
			const gated = requireRecall(deps);
			if (!gated.ok) {
				return toResult({ ok: false, summary: gated.summary, data: { available: false } });
			}
			const hits = gated.recall({ query: params.query, limit: params.limit });
			deps.onRecall?.({
				query: params.query ?? null,
				hits: hits.length,
				ids: hits.map((h) => h.id),
			});
			return toResult({
				ok: true,
				summary:
					hits.length === 0
						? `no recorded observation matches that (searched ${params.query ? `for the words in "${params.query}"` : "the library"}).`
						: `${hits.length} recorded observation(s) from earlier games:\n${hits.map((h) => `- ${h.line}`).join("\n")}`,
				data: { available: true, query: params.query ?? null, ids: hits.map((h) => h.id) },
			});
		},
	};
}

export function setPauseTool(deps: AgentDeps): AgentTool<typeof SetPauseSchema, ActionResult> {
	return {
		name: "set_pause",
		label: "Pause/Resume Game",
		description: "Pause or unpause the running OpenTTD server (server-level RCON).",
				// 游戏按 **FIFO** 应用命令（SPEC §10.39.1），所以这几条**变更型**工具必须串行：
		// pi-agent-core 的默认执行模式是 `parallel`，同一条助手消息里的两条命令会并发
		// 发出，台账（在完成时记录）的顺序就不再等于本局实际应用的顺序。ADR §10.74。
		executionMode: "sequential",
		parameters: SetPauseSchema,
		execute: async (_id, params) => {
			const cmd = params.paused ? "pause" : "unpause";
			// Observe the effect instead of claiming it (2026-09-17). Before the
			// rcon reply channel existed this tool reported "sent" for a command
			// that may have done nothing - and this repo has already paid for that
			// exact class of bug (a one-way pause froze a whole run, SPEC 10.28).
			// Two paths, and the command is SENT in both (the first version only
			// "awaited", so a sink without rconAwait never received the command at
			// all - caught by the existing unit test).
			const canAwait = typeof deps.sink.rconAwait === "function";
			const reply = canAwait ? await deps.sink.rconAwait!(cmd) : (deps.sink.rcon(cmd), null);
			if (reply === null) {
				return toResult({
					ok: false,
					summary:
						`sent rcon ${cmd} but the game did not answer. Whether the game is ` +
						"paused is UNKNOWN - the reply channel did not confirm it.",
					data: { paused: params.paused, confirmed: false },
				});
			}
			// 空回复是**正常**的：OpenTTD 的 `pause`/`unpause` 控制台没有输出，
			// 所以 `SERVER_RCON_END` 到达但一行都没打印。旧措辞 `answered: ""` 读起来
			// 像"没有答案"，而且在 2026-09-23 的长跑里，agent 用这个工具**把自己的
			// episode 停了 5 小时**，日志里却只有一行空引号——看不出它做了什么。
			// 规则：把"投递"与"效果"分开说；效果只由世界（游戏日期停走）证明。
			const delivered = reply !== "";
			// 记录归因（谁让它停的）：这是给 owner 看的独立事实，不只是给 agent 的回执。
			deps.onPauseChanged?.(params.paused, Date.now());
			return toResult({
				ok: true,
				summary: delivered
					? `rcon ${cmd} delivered; the game replied: "${reply}"`
					: `rcon ${cmd} delivered (the console printed no line — normal for ${cmd}). ` +
						`Delivery is confirmed; the EFFECT is confirmed only by observing the world: ` +
						`while paused the game date stops advancing.`,
				data: { paused: params.paused, delivered: true, confirmedEffect: delivered, reply },
			});
		},
	};
}

/** Assemble the first tool batch (SPEC §4.3). */

const InspectRouteSchema = Type.Object({
	job: Type.Optional(
		Type.Integer({ description: "route job id; omit to list every known route" }),
	),
});

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

/**
 * `inspect_route` — 线路经济查询（NEXT-2 N2-2）。
 *
 * 为什么需要它：N2-1 让每条线的结果变成事实（车辆数/等待/当年利润），但事实必须
 * **可被主动查询**才有用——否则 agent 只能等 harness 推送，而推送是 harness 在替它
 * 选问题。查询是 agent 自己的动作。
 *
 * 三路径都必须给出明确回答：
 *   - 有 job 且存在 → 该线事实（无任何建议措辞）；
 *   - job 不存在 → 拒绝，并列出已知 job（编造一条不存在的线是构陷）；
 *   - 本模式没有 GS 通道 / 尚无读数 → 拒绝，并说明原因（空成功 = 撒谎）。
 */
export function inspectRouteTool(deps: AgentDeps): AgentTool<typeof InspectRouteSchema, ActionResult> {
	return {
		name: "inspect_route",
		label: "Inspect Route",
		description:
			"Read the economics of a bus line you already ordered: vehicles on it, passengers " +
			"waiting, and year-to-date profit (from the game itself). Call with no job to list " +
			"all known routes.",
		parameters: InspectRouteSchema,
		execute: async (_id, params) => {
			const gated = requireRouteStats(deps);
			if (!gated.ok) {
				return toResult({ ok: false, summary: gated.summary, data: { available: false } });
			}
			const stats = gated.routeStats();
			if (stats.length === 0) {
				return toResult({
					ok: false,
					summary:
						"no route economics reported yet. The game reports a route once its blueprint " +
						"exists; a route with no stations built yet reads as 0 vehicles.",
					data: { available: true, routes: [] },
				});
			}
			if (params.job === undefined) {
				return toResult({
					ok: true,
					summary: stats.map((r) => formatRouteStats(r)).join("; "),
					data: { available: true, routes: stats },
				});
			}
			const one = stats.find((r) => r.job === params.job);
			if (!one) {
				return toResult({
					ok: false,
					summary:
						`unknown route job ${params.job}. Known jobs: ` +
						`${stats.map((r) => r.job).join(", ")}`,
					data: { available: true, known: stats.map((r) => r.job) },
				});
			}
			return toResult({
				ok: true,
				summary: formatRouteStats(one),
				data: { available: true, route: one },
			});
		},
	};
}

/**
 * L2 查询工具（Issue #13）：**问一个具体的问题，把答案带回来**。
 *
 * 为什么需要：观测面是**周期采样**——它告诉模型"世界此刻长什么样"，却不告诉它
 * "**我那辆车**现在在干什么、载了多少、赚了多少"。没有这些，模型只能猜（或者不停
 * 地 observe 一遍又一遍）。
 *
 * 铁律（与动作工具一样）：
 *   - **要么给出答案，要么明说拿不到**（超时/通道坏了 ⇒ 报"没得到回答"，绝不报"没有"）。
 *   - **不评价**（不说"这辆车很赚"），只给事实。
 *   - 只读：这两个工具**不改变世界**。
 */
export function inspectVehicleTool(deps: AgentDeps): AgentTool<typeof InspectVehicleSchema, ActionResult> {
	return {
		name: "inspect_vehicle",
		label: "Inspect Vehicle",
		description:
			"Ask the game about ONE vehicle: its name, where it is, its type and engine, its age, its current speed, how much it is carrying and its profit this year. " +
			"Use it when observe() shows vehicles or a route but not what a specific vehicle is doing. Read-only.",
		executionMode: "sequential",
		parameters: InspectVehicleSchema,
		execute: async (_id, params) => {
			const answer = await deps.sink.gameScriptAwait?.(
				JSON.stringify({ cmd: "inspect_vehicle", vehicle: params.vehicle }),
				INSPECT_TIMEOUT_MS,
			);
			if (answer === undefined) {
				return toResult({
					ok: false,
					summary: `inspect_vehicle is not available in this run (no answer channel); vehicle ${params.vehicle} was not inspected`,
				});
			}
			if (answer === null) {
				return toResult({
					ok: false,
					summary: `no answer from the game within ${INSPECT_TIMEOUT_MS} ms for vehicle ${params.vehicle}; nothing was inspected`,
				});
			}
			if (answer.ok !== true) {
				return toResult({
					ok: false,
					summary: `the game could not inspect vehicle ${params.vehicle}: ${String(answer.reason ?? "unknown reason")}`,
					data: answer,
				});
			}
			const data = (answer.data ?? {}) as Record<string, unknown>;
			return toResult({
				ok: true,
				summary: `vehicle ${params.vehicle}: ${JSON.stringify(data)}`,
				data,
			});
		},
	};
}

/** `inspect_town` — ask the game about ONE town. */
export function inspectTownTool(deps: AgentDeps): AgentTool<typeof InspectTownSchema, ActionResult> {
	return {
		name: "inspect_town",
		label: "Inspect Town",
		description:
			"Ask the game about ONE town: its name, population, houses, where it is and its growth rate. " +
			"Use it when observe() shows towns but not the details of a specific one. Read-only.",
		executionMode: "sequential",
		parameters: InspectTownSchema,
		execute: async (_id, params) => {
			const answer = await deps.sink.gameScriptAwait?.(
				JSON.stringify({ cmd: "inspect_town", town: params.town }),
				INSPECT_TIMEOUT_MS,
			);
			if (answer === undefined) {
				return toResult({
					ok: false,
					summary: `inspect_town is not available in this run (no answer channel); town ${params.town} was not inspected`,
				});
			}
			if (answer === null) {
				return toResult({
					ok: false,
					summary: `no answer from the game within ${INSPECT_TIMEOUT_MS} ms for town ${params.town}; nothing was inspected`,
				});
			}
			if (answer.ok !== true) {
				return toResult({
					ok: false,
					summary: `the game could not inspect town ${params.town}: ${String(answer.reason ?? "unknown reason")}`,
					data: answer,
				});
			}
			const data = (answer.data ?? {}) as Record<string, unknown>;
			return toResult({
				ok: true,
				summary: `town ${params.town}: ${JSON.stringify(data)}`,
				data,
			});
		},
	};
}

export function createTools(deps: AgentDeps): AgentTool<TSchema, ActionResult>[] {
	// Order matters for the model's attention but not for behaviour. The action
	// list itself is derived from THIS array by `capabilitiesTool`, so the
	// catalog cannot report a name that does not exist (AB-1).
	const actions: AgentTool<TSchema, ActionResult>[] = [
		observeTool(deps),
		inspectVehicleTool(deps),
		inspectTownTool(deps),
		estimateRouteTool(deps),
		inspectRouteTool(deps),
		buildBusRouteTool(deps),
		buildFreightRouteTool(deps),
		setRouteVehiclesTool(deps),
		setRouteCargoTool(deps),
		setRouteEngineTool(deps),
		retireRouteTool(deps),
		recallTool(deps),
		setPauseTool(deps),
	];
	const capabilities = capabilitiesTool(deps, () => [...actions, capabilities]) as unknown as AgentTool<TSchema, ActionResult>;
	return [...actions, capabilities];
}
