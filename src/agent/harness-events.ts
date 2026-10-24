/**
 * Harness event → agent event adapter (D6a/M5).
 *
 * 职责: 把 `AgentHarness` 的事件形状翻译成 `Telemetry.ingestAgentEvent` 已认识的
 *   形状，使看板的 token/步骤统计在两条路径（裸 Agent / harness）上同源。
 * 事实来源: pi-agent-core `HarnessEventPayload`（agent-harness.d.ts:206–）
 *   vs `AgentEvent`（types.d.ts）。差异只有三处：
 *   - `message_update` 的增量在 `event`（harness）而非 `assistantMessageEvent`；
 *   - `tool_start` / `tool_end`（harness）vs `tool_execution_start` / `tool_execution_end`；
 *   - 其余（`turn_start`/`message_start`/`message_end`）同名同形。
 * 禁止: 在此做 IO 或状态；禁止把未知事件伪造成已知事件（宁可返回空数组，
 *   也不要让看板把"没看懂"显示成"没有发生"）。
 */

/** Loose shape: we translate by name, so the caller need not import harness types. */
export interface HarnessEventLike {
	type?: string;
	[k: string]: unknown;
}

/** One agent-shaped event, still loosely typed (`Telemetry` narrows it). */
export type AgentEventLike = { type: string; [k: string]: unknown };

/**
 * Translate one harness event into the agent-shaped events telemetry consumes.
 *
 * @returns `[]` for events telemetry does not track (run lifecycle,
 *   queue/config updates). Retry and fault are counted (D6b): a call that had to
 *   be retried looks exactly like a clean one in tokens and steps, yet it is a
 *   different experimental condition.
 */
export function harnessEventToAgentEvents(ev: HarnessEventLike): AgentEventLike[] {
	switch (ev.type) {
		case "turn_start":
			return [{ type: "turn_start" }];
		case "message_start":
			return [{ type: "message_start", message: ev.message }];
		case "message_update":
			// Harness names the provider event `event`; telemetry reads
			// `assistantMessageEvent` (the bare-Agent name).
			return [{ type: "message_update", assistantMessageEvent: ev.event, message: ev.message }];
		case "message_end":
			return [{ type: "message_end", message: ev.message }];
		case "tool_start":
			return [
				{
					type: "tool_execution_start",
					toolCallId: ev.toolCallId,
					toolName: ev.toolName,
					args: ev.args,
				},
			];
		case "retry_scheduled":
			// D6b: a provider call failed and will be retried. Before this, a retry
			// was invisible: the run looked merely slower and more expensive.
			return [
				{
					type: "retry",
					attempt: ev.attempt,
					maxAttempts: ev.maxAttempts,
					delayMs: ev.delayMs,
					message: ev.errorMessage,
				},
			];
		case "fault":
			return [{ type: "fault", code: ev.code, message: ev.message }];
		case "handler_error":
			// A hook/listener threw. The harness isolates it, but a run whose hooks
			// are failing is not a clean run - surface it instead of hiding it.
			const where = typeof ev.hook === "string" ? ev.hook : typeof ev.event === "string" ? ev.event : ev.kind;
			return [{ type: "fault", message: `handler_error (${where}): ${ev.error}` }];
		case "tool_end":
			return [
				{
					type: "tool_execution_end",
					toolCallId: ev.toolCallId,
					toolName: ev.toolName,
					result: ev.result,
					isError: ev.isError,
				},
			];
		default:
			return [];
	}
}
