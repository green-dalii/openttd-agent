/**
 * Harness event adapter (D6a/M5).
 *
 * 为什么值得单测：这是两条路径共享看板的唯一接缝。接错一个字段名不会报错，
 * 只会让 token 曲线变成 0，而"0 消耗"看起来就像"模型没被调用"。
 */

import { describe, expect, it } from "vitest";
import { harnessEventToAgentEvents } from "../../src/agent/harness-events.js";

describe("harnessEventToAgentEvents", () => {
	it("renames the provider delta field that telemetry actually reads", () => {
		const out = harnessEventToAgentEvents({
			type: "message_update",
			runId: "r1",
			message: { role: "assistant" },
			event: { type: "text_delta", delta: "hi" },
		});
		expect(out).toEqual([
			{
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hi" },
				message: { role: "assistant" },
			},
		]);
	});

	it("maps tool_start to tool_execution_start with the same call id", () => {
		const out = harnessEventToAgentEvents({
			type: "tool_start",
			runId: "r1",
			turnId: "t1",
			toolCallId: "call-9",
			toolName: "observe",
			args: { company: 0 },
		});
		expect(out).toEqual([
			{ type: "tool_execution_start", toolCallId: "call-9", toolName: "observe", args: { company: 0 } },
		]);
	});

	it("maps tool_end carrying isError, which is what the failure count uses", () => {
		const out = harnessEventToAgentEvents({
			type: "tool_end",
			runId: "r1",
			turnId: "t1",
			toolCallId: "call-9",
			toolName: "observe",
			result: { content: [], details: {} },
			isError: true,
			terminate: false,
		});
		expect(out).toEqual([
			{
				type: "tool_execution_end",
				toolCallId: "call-9",
				toolName: "observe",
				result: { content: [], details: {} },
				isError: true,
			},
		]);
	});

	it("passes through the same-named events unchanged in meaning", () => {
		expect(harnessEventToAgentEvents({ type: "turn_start", runId: "r", turnId: "t" })).toEqual([
			{ type: "turn_start" },
		]);
		expect(harnessEventToAgentEvents({ type: "message_end", message: { role: "assistant" } })).toEqual([
			{ type: "message_end", message: { role: "assistant" } },
		]);
	});

	it("drops untracked events instead of inventing a tracked one", () => {
		for (const type of ["run_start", "run_end", "retry_scheduled", "fault", "entry_added", "unknown_future"]) {
			expect(harnessEventToAgentEvents({ type })).toEqual([]);
		}
		expect(harnessEventToAgentEvents({})).toEqual([]);
	});
});
