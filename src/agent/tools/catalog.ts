/**
 * 职责：agent 的**能力目录**（AB-1，SPEC §10.91）——"我现在能做什么、哪些现在可用"。
 *
 * 禁止：在这里写策略（先建哪条线、该花多少钱）。目录只描述**接口事实**。
 *
 * 为什么要有它（D32）：判断"agent 能不能做 X"的唯一可靠依据是**环境暴露了哪些动作**。
 * 在此之前那份清单只散落在工具 schema 里，而且**当前是否可用**只能靠失败去发现：
 * `inspect_route` 在无 GS 通道时拒绝、`recall` 在 `--no-memory` 时拒绝。
 *
 * 三条**结构性**要求（靠构造成立，不靠纪律）：
 *   ① 名字**派生自活的工具数组**（见 `createTools`）⇒ 目录不可能漏报/多报；
 *   ② 可用性判断与工具自身的拒绝**共用 `TOOL_WIRING` 同一个谓词** ⇒ 目录不可能撒谎；
 *   ③ 每个工具都必须在 `ACTION_EFFECTS` 里被分类为 read/write ⇒ 新工具不能不表态
 *      （`test/unit/agent-tools.test.ts` 的重放证明守卫）。
 */
import { Type, type TSchema } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentDeps, ActionResult } from "../types.js";

/** 只读 / 会改变游戏状态。这是决策所需的事实，不是建议。 */
export type ActionEffect = "read" | "write";

/**
 * 接线门控：**同一个谓词同时被工具和目录使用**。
 *
 * 返回 `null` = 本局可用；返回字符串 = 本局不可用，且字符串就是给模型看的原因。
 * 工具在 `execute` 开头调用它并**原样**返回该原因——因此"目录说不可用、工具却不拒绝"
 * （或反过来）在结构上不可能发生。
 */
/**
 * 一条门控 = **原因文案 + 生效谓词**绑在一起。
 *
 * 为什么绑在一起（而不是各写一份）：UI（运营面板）需要在**没有 deps** 的情况下
 * 说出"这个动作在本局有条件"，而工具需要在**有 deps** 的情况下说出"这次调用为什么被拒"。
 * 如果两处各写一份文案，它们一定会在某次改动后不一致——那时面板会替 harness 说谎。
 */
export interface ToolGate {
	/** 短标识，给 UI/日志用（`memory` / `gs_channel`）。 */
	key: string;
	/** 给模型与运营者看的**同一句**原因。 */
	reason: string;
	/** 本局是否满足条件。 */
	active: (deps: AgentDeps) => boolean;
}

const NO_MEMORY_REASON = "no memory is available in this run (it was disabled), so there is nothing to recall.";
const NO_GS_REASON = "route economics are not available in this mode (no GS channel reports them)";

export const TOOL_WIRING: Record<string, string> = {
	inspect_route: "gs_channel",
	recall: "memory",
};

export const TOOL_GATES: Record<string, ToolGate> = {
	memory: { key: "memory", reason: NO_MEMORY_REASON, active: (deps) => deps.recall !== undefined },
	gs_channel: { key: "gs_channel", reason: NO_GS_REASON, active: (deps) => deps.routeStats !== undefined },
};

/** 查询某动作在本局是否可用（不可用则给出原因，与工具自身的拒绝文案同源）。 */
export function wiringRefusal(deps: AgentDeps, toolName: string): string | null {
	const gateKey = TOOL_WIRING[toolName];
	if (gateKey === undefined) return null;
	const gate = TOOL_GATES[gateKey];
	if (gate === undefined) return "this action is gated but its gate is not declared"; // 声明错误必须可见，不能静默放行
	return gate.active(deps) ? null : gate.reason;
}

/**
 * 每个动作的**后果分类**。
 *
 * 为什么手写而不是派生：没有任何机械规则能从 schema 推出"这个调用会改变世界"。
 * 因此它是**必须表态的登记表**——漏登记会被守卫抓到（而不是默认成 read）。
 */
export const ACTION_EFFECTS: Record<string, ActionEffect> = {
	observe: "read",
	estimate_route: "read",
	inspect_route: "read",
	recall: "read",
	capabilities: "read",
	build_bus_route: "write",
	set_route_vehicles: "write",
	retire_route: "write",
	set_pause: "write",
};

/**
 * 门控 + 类型窄化二合一。
 *
 * 为什么需要它：门控字符串是给**模型**看的，而 TS 无法透过一个函数调用完成窄化
 * （`deps.recall` 仍是 `undefined | fn`）。把两者合在一起，既保证工具与目录
 * 用**同一个谓词**，又保证工具内部拿到的引用已窄化——不需要 `!` 断言（那会掩盖真 bug）。
 */
export function requireRecall(
	deps: AgentDeps,
): { ok: true; recall: NonNullable<AgentDeps["recall"]> } | { ok: false; summary: string } {
	const why = wiringRefusal(deps, "recall");
	if (deps.recall === undefined) return { ok: false, summary: why ?? "no memory is available in this run" };
	return { ok: true, recall: deps.recall };
}

export function requireRouteStats(
	deps: AgentDeps,
): { ok: true; routeStats: NonNullable<AgentDeps["routeStats"]> } | { ok: false; summary: string } {
	const why = wiringRefusal(deps, "inspect_route");
	if (deps.routeStats === undefined) return { ok: false, summary: why ?? "route economics are not available in this mode" };
	return { ok: true, routeStats: deps.routeStats };
}

/**
 * 给**运营面板**用的动作面快照（静态，不需要 deps）。
 *
 * 名字的权威仍是 `createTools()`（守卫在 `test/unit/agent-tools.test.ts` 里断言
 * 两者一致），所以这个函数**不是**第二份清单，而是同一个登记表的只读视图。
 * 门控只报"有条件"，不报"本局可不可用"——因为这里拿不到 deps，
 * 而**报错比说谎好**：面板不该声称一个它无法知道的事实。
 */
export function actionCatalog(): {
	name: string;
	effect: ActionEffect;
	gate: { key: string; reason: string } | null;
}[] {
	return Object.keys(ACTION_EFFECTS)
		.sort()
		.map((name) => {
			const gateKey = TOOL_WIRING[name];
			const gate = gateKey === undefined ? undefined : TOOL_GATES[gateKey];
			return {
				name,
				effect: ACTION_EFFECTS[name] ?? "write",
				gate: gate ? { key: gate.key, reason: gate.reason } : null,
			};
		});
}

const CapabilitiesSchema = Type.Object({});

/**
 * 能力目录工具。
 *
 * 它**必须拿到活的工具数组**（由 `createTools` 传入），而不是自己再抄一份名字——
 * 这正是它与"文档里的动作清单"的区别：文档会漂移，派生不会。
 */
export function capabilitiesTool(
	deps: AgentDeps,
	tools: () => readonly AgentTool<TSchema, ActionResult>[],
): AgentTool<typeof CapabilitiesSchema, ActionResult> {
	return {
		name: "capabilities",
		label: "List Capabilities",
		description:
			"List the actions this environment exposes right now: which of them change game state, and " +
			"which are unavailable in this particular run (with the reason). Use it before planning, or " +
			"when you need to know whether something is possible instead of finding out by failing.",
		parameters: CapabilitiesSchema,
		execute: async () => {
			// The list is taken lazily so that the catalog can include ITSELF:
			// a tool the model cannot see in its own action list is a tool it
			// will not use to plan (and `capabilities` is exactly the one that
			// answers "what can I do").
			const actions = tools().map((t) => {
				const gate = wiringRefusal(deps, t.name);
				return {
					name: t.name,
					effect: ACTION_EFFECTS[t.name] ?? "write",
					available: gate === null,
					...(gate === null ? {} : { why: gate }),
				};
			});
			const available = actions.filter((a) => a.available).length;
			const writes = actions.filter((a) => a.effect === "write").length;
			return {
				content: [
					{
						type: "text" as const,
						text:
							`${actions.length} actions exposed (${available} usable now, ${actions.length - available} not): ` +
							actions
								.map((a) => `${a.name}[${a.effect}${a.available ? "" : ": UNAVAILABLE"}]`)
								.join(", "),
					},
				],
				details: {
					ok: true,
					summary:
						`${actions.length} actions (${available} usable now, ${writes} change game state). ` +
						actions
							.filter((a) => !a.available)
							.map((a) => `${a.name}: ${a.why}`)
							.join("; "),
					data: { count: actions.length, available, actions },
				},
			};
		},
	};
}
