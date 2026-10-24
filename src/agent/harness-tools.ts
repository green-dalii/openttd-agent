/**
 * Agent tools → harness tools adapter (D6a/M3).
 *
 * 职责: 形状转换。`AgentTool.execute(toolCallId, params, signal?, onUpdate?)`
 *   vs `AgentHarnessTool.execute(toolCallId, params, onUpdate, toolContext, invocation)`。
 *   我们既不使用工具上下文，也不使用 durable replay memo，所以两个额外参数被忽略，
 *   而 `signal` 位置为空 —— harness 的取消由它在 drive 层统一处理。
 * 事实来源: pi-agent-core types.d.ts:340（AgentTool）、harness/types.d.ts:78（AgentHarnessTool）。
 * 禁止: 在此改写 params / 结果；禁止吞掉抛出的错误（工具用抛错表达失败，
 *   适配层把它变成"成功"会让模型看不到失败）。
 */

import type { AgentHarnessTool, AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";

/**
 * Re-shape agent tools for the harness.
 *
 * `executionMode` is kept on the object but the harness ignores it (verified:
 * no `executionMode` reads under `harness/runtime/`); ordering comes from the
 * global `toolExecution` option instead. Callers must set that to
 * `"sequential"` — see `harness-runtime.ts`.
 */
export function toHarnessTools<TContext extends object | undefined, TDetails>(
	tools: readonly AgentTool<TSchema, TDetails>[],
): AgentHarnessTool<TContext, TSchema, TDetails>[] {
	return tools.map((tool) => ({
		...tool,
		execute: async (toolCallId: string, params: never, onUpdate: never) =>
			tool.execute(toolCallId, params, undefined, onUpdate),
	})) as AgentHarnessTool<TContext, TSchema, TDetails>[];
}
