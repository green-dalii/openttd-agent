/**
 * Unit tests — agent telemetry accumulation (no IO, no network).
 * 事实来源: docs/DASHBOARD-API.md §2.1-2.3 (frozen contract);
 *   pi-ai types.d.ts (Usage/AssistantMessageEvent); pi-agent-core (AgentEvent).
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Telemetry } from "../../src/agent/telemetry.js";

function usage(input: number, output: number, reasoning = 0, costTotal = 0): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
	};
}

function assistantMsg(over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "hello" }],
		api: "openai-completions",
		provider: "test-provider",
		model: "test-model",
		usage: usage(100, 20),
		stopReason: "stop",
		timestamp: Date.now(),
		...over,
	} as AssistantMessage;
}

/** Minimal AgentEvent builders (only the fields telemetry reads). */
const ev = {
	msgStart: (m: AssistantMessage): AgentEvent => ({ type: "message_start", message: m }) as AgentEvent,
	msgEnd: (m: AssistantMessage): AgentEvent => ({ type: "message_end", message: m }) as AgentEvent,
	thinkingDelta: (delta: string, m: AssistantMessage): AgentEvent =>
		({
			type: "message_update",
			message: m,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: m },
		}) as AgentEvent,
	textDelta: (delta: string, m: AssistantMessage): AgentEvent =>
		({
			type: "message_update",
			message: m,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: m },
		}) as AgentEvent,
	turnStart: (): AgentEvent => ({ type: "turn_start" }) as AgentEvent,
	toolStart: (id: string, name: string, args: unknown): AgentEvent =>
		({ type: "tool_execution_start", toolCallId: id, toolName: name, args }) as AgentEvent,
	toolEnd: (id: string, name: string, result: unknown, isError: boolean): AgentEvent =>
		({ type: "tool_execution_end", toolCallId: id, toolName: name, result, isError }) as AgentEvent,
};

describe("Telemetry — peak request size (G6)", () => {
	// 事实来源：pi-ai `Usage`（dist/types.d.ts）= input/output/cacheRead/cacheWrite/reasoning/totalTokens。
	// 一次请求送进模型的 prompt = input + cacheRead + cacheWrite（三个输入侧字段之和）；
	// `reasoning` 是 output 的子集，不属于 prompt。
	function usageWith(prompt: number, output = 10): Usage {
		return {
			input: prompt,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: prompt + output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} as Usage;
	}
	function seen(t: Telemetry, u: Usage): void {
		t.ingestAgentEvent(ev.msgStart(assistantMsg({ usage: u })));
		t.ingestAgentEvent(ev.msgEnd(assistantMsg({ usage: u })));
	}

	it("记录单次请求的最大 prompt（不是最后一次、也不是累计）", () => {
		const t = new Telemetry();
		t.ingestAgentEvent(ev.turnStart());
		seen(t, usageWith(5000));
		seen(t, usageWith(41000));
		seen(t, usageWith(7000));
		expect(t.snapshot().usage.peakRequest.tokens).toBe(41000);
		// 累计值必须仍然正确（峰值不能污染累计）
		expect(t.snapshot().usage.total.input).toBe(5000 + 41000 + 7000);
	});

	it("缓存读写的 prompt 部分也算进请求大小（否则会低估真实上下文）", () => {
		const t = new Telemetry();
		// 10 万 tokens 的 prompt 里 9 万命中缓存；只读 input 会把它报成 1 万
		seen(t, {
			input: 10000,
			output: 500,
			cacheRead: 90000,
			cacheWrite: 0,
			totalTokens: 100500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} as Usage);
		expect(t.snapshot().usage.peakRequest.tokens).toBe(100000);
	});

	it("没有 usage 的调用不参与峰值（缺失 ≠ 0）", () => {
		const t = new Telemetry();
		seen(t, undefined as unknown as Usage);
		expect(t.snapshot().usage.peakRequest.tokens).toBe(0);
		expect(t.snapshot().usage.peakRequest.turn).toBeNull();
	});

	it("峰值附带它发生在第几个 turn（可回溯，而不是只有一个数）", () => {
		const t = new Telemetry();
		t.ingestAgentEvent(ev.turnStart());
		seen(t, usageWith(9000));
		t.ingestAgentEvent(ev.turnStart());
		seen(t, usageWith(30000));
		t.ingestAgentEvent(ev.turnStart());
		seen(t, usageWith(12000));
		const peak = t.snapshot().usage.peakRequest;
		expect(peak.tokens).toBe(30000);
		expect(peak.turn).toBe(2);
	});
});

describe("Telemetry — usage accumulation", () => {
	it("sums token usage across messages and groups it by turn", () => {
		const t = new Telemetry();
		t.ingestAgentEvent(ev.turnStart());
		t.ingestAgentEvent(ev.msgStart(assistantMsg()));
		t.ingestAgentEvent(ev.msgEnd(assistantMsg({ usage: usage(100, 20, 5, 0.01) })));
		t.ingestAgentEvent(ev.turnStart());
		t.ingestAgentEvent(ev.msgEnd(assistantMsg({ usage: usage(300, 40, 0, 0.02) })));

		const s = t.snapshot();
		expect(s.usage.total.input).toBe(400);
		expect(s.usage.total.output).toBe(60);
		expect(s.usage.total.reasoning).toBe(5);
		expect(s.usage.total.totalTokens).toBe(460);
		expect(s.usage.total.costTotal).toBeCloseTo(0.03, 6);
		expect(s.usage.byTurn).toHaveLength(2);
		expect(s.usage.byTurn[0]!.turn).toBe(1);
		expect(s.usage.byTurn[0]!.usage.input).toBe(100);
		expect(s.usage.byTurn[1]!.usage.input).toBe(300);
		expect(s.totals.messages).toBe(2);
	});

	it("treats a missing reasoning breakdown as 0 and never yields undefined", () => {
		const t = new Telemetry();
		const u = usage(10, 2);
		delete (u as { reasoning?: number }).reasoning;
		t.ingestAgentEvent(ev.msgEnd(assistantMsg({ usage: u })));
		const s = t.snapshot();
		expect(s.usage.total.reasoning).toBe(0);
		expect(s.usage.total.cacheRead).toBe(0);
		expect(s.usage.total.cacheWrite).toBe(0);
	});
});

describe("Telemetry — thinking + message steps", () => {
	it("captures thinking deltas and text deltas into the step", () => {
		const t = new Telemetry();
		const m = assistantMsg();
		t.ingestAgentEvent(ev.turnStart());
		t.ingestAgentEvent(ev.msgStart(m));
		t.ingestAgentEvent(ev.thinkingDelta("Let me ", m));
		t.ingestAgentEvent(ev.thinkingDelta("plan.", m));
		t.ingestAgentEvent(ev.textDelta("Building ", m));
		t.ingestAgentEvent(ev.textDelta("a route.", m));
		t.ingestAgentEvent(ev.msgEnd(assistantMsg({ content: [{ type: "text", text: "Building a route." }] })));

		const s = t.snapshot();
		const step = s.steps.find((x) => x.kind === "message");
		expect(step).toBeDefined();
		expect(step?.thinking).toBe("Let me plan.");
		expect(step?.text).toBe("Building a route.");
		expect(step?.model).toBe("test-model");
		expect(step?.provider).toBe("test-provider");
		expect(step?.turn).toBe(1);
		expect(s.recentThinking).toHaveLength(1);
		expect(s.recentThinking[0]!.text).toBe("Let me plan.");
	});

	it("falls back to message content when no deltas were streamed", () => {
		const t = new Telemetry();
		t.ingestAgentEvent(
			ev.msgEnd(
				assistantMsg({
					content: [
						{ type: "thinking", thinking: "deep thought" },
						{ type: "text", text: "answer" },
					],
				}),
			),
		);
		const step = t.snapshot().steps.find((x) => x.kind === "message");
		expect(step?.thinking).toBe("deep thought");
		expect(step?.text).toBe("answer");
	});

	it("ignores thinking deltas that are only whitespace for recentThinking", () => {
		const t = new Telemetry();
		const m = assistantMsg();
		t.ingestAgentEvent(ev.msgStart(m));
		t.ingestAgentEvent(ev.thinkingDelta("   ", m));
		t.ingestAgentEvent(ev.msgEnd(m));
		expect(t.snapshot().recentThinking).toHaveLength(0);
	});
});

describe("Telemetry — tool steps", () => {
	it("records tool duration, success and failure, aggregated by tool", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000);
			const t = new Telemetry();
			t.ingestAgentEvent(ev.toolStart("c1", "observe", {}));
			vi.setSystemTime(1_150);
			t.ingestAgentEvent(
				ev.toolEnd("c1", "observe", { details: { ok: true, summary: "state read" } }, false),
			);
			t.ingestAgentEvent(ev.toolStart("c2", "build_bus_route", { from_town: 1 }));
			vi.setSystemTime(1_400);
			t.ingestAgentEvent(
				ev.toolEnd("c2", "build_bus_route", { details: { ok: false, summary: "no towns" } }, true),
			);

			const s = t.snapshot();
			expect(s.totals.toolCalls).toBe(2);
			expect(s.totals.toolFailures).toBe(1);
			const toolSteps = s.steps.filter((x) => x.kind === "tool");
			expect(toolSteps).toHaveLength(2);
			expect(toolSteps[0]!.durationMs).toBe(150);
			expect(toolSteps[0]!.ok).toBe(true);
			expect(toolSteps[0]!.summary).toBe("state read");
			expect(toolSteps[1]!.ok).toBe(false);
			expect(s.usage.byTool).toEqual([
				{ tool: "build_bus_route", calls: 1, failures: 1, avgDurationMs: 250 },
				{ tool: "observe", calls: 1, failures: 0, avgDurationMs: 150 },
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("marks a tool step failed from isError even without details", () => {
		const t = new Telemetry();
		t.ingestAgentEvent(ev.toolStart("c1", "observe", {}));
		t.ingestAgentEvent(ev.toolEnd("c1", "observe", undefined, true));
		const step = t.snapshot().steps.find((x) => x.kind === "tool");
		expect(step?.ok).toBe(false);
	});
});

describe("Telemetry — bookkeeping + robustness", () => {
	it("counts decision points and brain info", () => {
		const t = new Telemetry();
		t.decisionPoint();
		t.decisionPoint();
		t.setBrain({ provider: "openai", model: "gpt-5", kind: "real" });
		const s = t.snapshot();
		expect(s.totals.decisions).toBe(2);
		expect(s.brain).toEqual({ provider: "openai", model: "gpt-5", kind: "real" });
	});

	it("emits onStep for both step kinds and pings onActivity", () => {
		const t = new Telemetry();
		const seen: string[] = [];
		t.onStep = (r) => seen.push(r.kind);
		const activity = vi.fn();
		t.onActivity = activity;
		t.ingestAgentEvent(ev.msgEnd(assistantMsg()));
		t.ingestAgentEvent(ev.toolStart("c1", "observe", {}));
		t.ingestAgentEvent(ev.toolEnd("c1", "observe", undefined, false));
		expect(seen).toEqual(["message", "tool"]);
		expect(activity).toHaveBeenCalled();
	});

	it("bounds retained steps and stays JSON-safe", () => {
		const t = new Telemetry({ limit: 3 });
		for (let i = 0; i < 6; i++) t.ingestAgentEvent(ev.msgEnd(assistantMsg()));
		const s = t.snapshot();
		expect(s.steps).toHaveLength(3);
		expect(JSON.parse(JSON.stringify(s)).steps).toHaveLength(3);
	});

	it("never throws on malformed or unrelated events", () => {
		const t = new Telemetry();
		for (const bad of [
			{ type: "message_end", message: { role: "user", content: "hi" } },
			{ type: "message_end" },
			{ type: "message_update" },
			{ type: "tool_execution_end", toolCallId: "x" },
			{ type: "agent_end", messages: [] },
			{ type: "turn_end" },
		] as unknown as AgentEvent[]) {
			expect(() => t.ingestAgentEvent(bad)).not.toThrow();
		}
		expect(t.snapshot().steps.filter((x) => x.kind === "message")).toHaveLength(0);
	});

	it("exposes a session id and monotonic step ids", () => {
		const t = new Telemetry({ sessionId: "sess-1" });
		t.ingestAgentEvent(ev.msgEnd(assistantMsg()));
		t.ingestAgentEvent(ev.toolStart("c", "observe", {}));
		t.ingestAgentEvent(ev.toolEnd("c", "observe", undefined, false));
		const s = t.snapshot();
		expect(s.sessionId).toBe("sess-1");
		expect(s.steps.map((x) => x.id)).toEqual(["s1", "s2"]);
	});
});
