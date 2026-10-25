/**
 * Harness runtime — the D6a contract, exercised against the real harness.
 *
 * 为什么这组测试不能用假 harness：D6a 的全部风险都在"库的接线细节"上
 * （lane 何时创建、hook 何时触发、transcript 落在哪里、预算窗口按什么重置）。
 * 用一个自己写的假 harness 测这些，只会证明我对自己假设的一致性。
 *
 * 这里用真 `AgentHarness` + 真 `JsonlSessionRepo`（临时目录）+ pi-ai 的 FAUX
 * provider（无网络），所以跑的是真的接线，而不是形状。
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import {
	createHarnessRuntime,
	harnessEnabled,
	HARNESS_LANE_NAME,
	type HarnessRuntime,
} from "../../src/agent/harness-runtime.js";
import { laneDecisionAgent } from "../../src/agent/decision-agent.js";
import { budgetRefusal } from "../../src/agent/tool-budget.js";
import type { ActionResult } from "../../src/agent/types.js";

/** Minimal tool the faux model can call; records every invocation. */
function countingTool(calls: { name: string }[]): AgentTool<TSchema, ActionResult> {
	return {
		name: "observe",
		label: "Observe",
		description: "observe the world",
		parameters: { type: "object", properties: {} } as TSchema,
		execute: async () => {
			calls.push({ name: "observe" });
			return { content: [{ type: "text", text: "world" }], details: { ok: true, summary: "world" } };
		},
	};
}

let dir: string;
let runtime: HarnessRuntime | null = null;

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "d6a-"));
});

afterAll(async () => {
	if (runtime) await runtime.close();
	await rm(dir, { recursive: true, force: true });
});

async function makeRuntime(opts: {
	faux: ReturnType<typeof createFauxCore>;
	calls?: { name: string }[];
	budget?: number;
	transformContext?: (m: never[]) => Promise<never[]>;
	onEvent?: (e: { type: string }) => void;
	/** Receives the provider context actually handed to the stream function. */
	onStreamContext?: (context: unknown) => void;
	/** Emulate a real provider: report the serialized payload back to the harness. */
	emitPayload?: boolean;
}): Promise<HarnessRuntime> {
	const base = opts.faux.streamSimple;
	const streamSimple =
		opts.onStreamContext || opts.emitPayload
			? (model: never, context: never, options: never) => {
					opts.onStreamContext?.(context);
					if (opts.emitPayload) {
						// Real providers call `onPayload` with the exact body they send;
						// faux ignores it, so the hook would otherwise never fire.
						(options as { onPayload?: (p: unknown, m: unknown) => void } | undefined)?.onPayload?.(
							{ model: "stub", messages: (context as { messages?: unknown[] }).messages },
							model,
						);
					}
					return base(model, context, options);
				}
			: base;
	return createHarnessRuntime({
		dataDir: dir,
		sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
		// The harness calls `models.streamSimple` AND `models.getModel` (the latter
		// per checkpoint, for the compaction threshold — even when compaction is
		// disabled). The faux provider supplies both.
		models: {
			streamSimple,
			getModel: () => opts.faux.getModel(),
		} as unknown as Models,
		model: opts.faux.getModel(),
		systemPrompt: "system",
		tools: [countingTool(opts.calls ?? [])],
		maxToolCallsPerDecision: opts.budget ?? 12,
		thinkingLevel: "off",
		...(opts.transformContext ? { transformContext: opts.transformContext as never } : {}),
		...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
	});
}

describe("createHarnessRuntime", () => {
	it("runs a decision through a lane and lands it in the transcript", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText('{"goal":"g","plan":[],"immediate_action":"a","wait_until":null,"rationale":"r"}')])]);
		runtime = await makeRuntime({ faux });
		const agent = laneDecisionAgent(runtime.lane, runtime.context);

		await agent.prompt("Decision point (trigger: start).");

		const msgs = await agent.planMessages();
		expect(msgs.length).toBeGreaterThanOrEqual(2);
		// Oldest → newest, so the plan parser's backwards scan sees the answer last.
		expect((msgs.at(-1) as { role: string }).role).toBe("assistant");
	});

	it("writes the replayable transcript under <dataDir>/sessions/<id>/harness", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("done")])]);
		const rt = await makeRuntime({ faux });
		try {
			await laneDecisionAgent(rt.lane, rt.context).prompt("hi");
			const sessionsDir = join(dir, "sessions");
			const ids = await readdir(sessionsDir);
			expect(ids.length).toBeGreaterThan(0);
			const harnessFiles = await readdir(join(sessionsDir, ids[0]!, "harness"), { recursive: true });
			expect(harnessFiles.some((f) => String(f).endsWith(".jsonl"))).toBe(true);
		} finally {
			await rt.close();
		}
	});

	it("blocks past the budget with the exact same refusal text and counts it", async () => {
		const faux = createFauxCore({});
		const calls: { name: string }[] = [];
		// Three tool calls in a single assistant message, then the answer.
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("observe", {}),
				fauxToolCall("observe", {}),
				fauxToolCall("observe", {}),
			]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const rt = await makeRuntime({ faux, calls, budget: 2 });
		try {
			await laneDecisionAgent(rt.lane, rt.context).prompt("go");
			expect(calls).toHaveLength(2);
			expect(rt.getBudgetBlocks()).toBe(1);
			// The refusal is a fact the model sees, so it must be in the transcript.
			const texts = (await laneDecisionAgent(rt.lane, rt.context).planMessages()).map((m) =>
				JSON.stringify(m),
			);
			expect(texts.some((t) => t.includes(budgetRefusal(2)))).toBe(true);
		} finally {
			await rt.close();
		}
	});

	it("resets the budget at the next decision (before_run, not turn_start)", async () => {
		const faux = createFauxCore({});
		const calls: { name: string }[] = [];
		const toolCall = [fauxToolCall("observe", {})];
		faux.setResponses([
			fauxAssistantMessage(toolCall),
			fauxAssistantMessage([fauxText("first")]),
			fauxAssistantMessage(toolCall),
			fauxAssistantMessage([fauxText("second")]),
		]);
		const rt = await makeRuntime({ faux, calls, budget: 1 });
		try {
			const agent = laneDecisionAgent(rt.lane, rt.context);
			await agent.prompt("decision 1");
			await agent.prompt("decision 2");
			// One usable call per decision, not one per run.
			expect(calls).toHaveLength(2);
			expect(rt.getBudgetBlocks()).toBe(0);
		} finally {
			await rt.close();
		}
	});

	it("applies transform_context and sends the transformed messages to the provider", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
		const seen: string[] = [];
		let received: unknown[] | undefined;
		const rt = await makeRuntime({
			faux,
			transformContext: async (m: never[]) => [...m, { role: "user", content: "INJECTED-MARKER" } as never],
			// The provider context IS what gets sent, so asserting on it proves the
			// hook's output survives to the request (a `before_payload` hook would
			// only be observable with a real provider: faux ignores `onPayload`).
			onStreamContext: (c) => {
				received = (c as { messages?: unknown[] }).messages;
				seen.push(JSON.stringify(c));
			},
		});
		try {
			await laneDecisionAgent(rt.lane, rt.context).prompt("hello");
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.join("\n")).toContain("INJECTED-MARKER");
			expect(JSON.stringify(received)).toContain("INJECTED-MARKER");
		} finally {
			await rt.close();
		}
	});

	it("keeps harness compaction disabled so only our pruning trims context", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
		const rt = await makeRuntime({ faux });
		try {
			const settings = await rt.harness.getCompactionSettings(rt.context);
			expect(settings.enabled).toBe(false);
		} finally {
			await rt.close();
		}
	});

	it("translates harness events into the shapes telemetry consumes", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxToolCall("observe", {})]), fauxAssistantMessage([fauxText("ok")])]);
		const seen: string[] = [];
		const rt = await makeRuntime({ faux, onEvent: (e) => seen.push(e.type) });
		try {
			await laneDecisionAgent(rt.lane, rt.context).prompt("go");
			expect(seen).toContain("message_end");
			expect(seen).toContain("tool_execution_start");
			expect(seen).toContain("tool_execution_end");
			// Never the harness-only names.
			expect(seen).not.toContain("tool_start");
		} finally {
			await rt.close();
		}
	});

	it("uses one lane named `agent`", async () => {
		const faux = createFauxCore({});
		faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
		const rt = await makeRuntime({ faux });
		try {
			const lanes = await rt.harness.lanes(rt.context);
			expect(lanes.map((l) => l.name)).toEqual([HARNESS_LANE_NAME]);
		} finally {
			await rt.close();
		}
	});
});

describe("harnessEnabled", () => {
	it("is off unless explicitly switched on", () => {
		// Default off is the rollback guarantee: an unset env var must never
		// change which backend runs (docs/HARNESS-MIGRATION.md §6).
		expect(harnessEnabled({})).toBe(false);
		expect(harnessEnabled({ AGENT_HARNESS: "" })).toBe(false);
		expect(harnessEnabled({ AGENT_HARNESS: "0" })).toBe(false);
		expect(harnessEnabled({ AGENT_HARNESS: "true" })).toBe(false);
	});

	it("turns on for exactly \"1\"", () => {
		expect(harnessEnabled({ AGENT_HARNESS: "1" })).toBe(true);
		expect(harnessEnabled({ AGENT_HARNESS: " 1 " })).toBe(true);
	});
});

describe("payload digest (D6b)", () => {
	it("records a stable hash of the first payload and the request count", async () => {
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("observe", {})]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const rt = await makeRuntime({ faux, emitPayload: true });
		try {
			expect(rt.getPayloadDigest()).toEqual({ payloadHash: null, payloadShapeHash: null, payloadCount: 0 });
			await laneDecisionAgent(rt.lane, rt.context).prompt("go");
			const d = rt.getPayloadDigest();
			expect(d.payloadHash).toMatch(/^[0-9a-f]{16}$/);
			// Same payload, numbers normalized: the cross-seed comparable fingerprint.
			expect(d.payloadShapeHash).toMatch(/^[0-9a-f]{16}$/);
			// The tool loop made two provider calls; the count is what proves the run
			// actually talked to the model twice.
			expect(d.payloadCount).toBe(2);
		} finally {
			await rt.close();
		}
	});

	it("keeps the FIRST payload's hash even when later payloads differ", async () => {
		const faux = createFauxCore({});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("observe", {})]),
			fauxAssistantMessage([fauxText("done")]),
		]);
		const rt = await makeRuntime({ faux, emitPayload: true });
		try {
			await laneDecisionAgent(rt.lane, rt.context).prompt("go");
			const first = rt.getPayloadDigest().payloadHash;
			await laneDecisionAgent(rt.lane, rt.context).prompt("again");
			// History grew, so the 3rd request differs - the recorded hash must not.
			expect(rt.getPayloadDigest().payloadHash).toBe(first);
			expect(rt.getPayloadDigest().payloadCount).toBe(3);
		} finally {
			await rt.close();
		}
	});
});
