/**
 * Harness runtime — assemble the pi-agent-core `AgentHarness` for one game run (D6a).
 *
 * 职责: 把"一局 = 一个可回放会话"装配起来：`NodeExecutionEnv` + `JsonlSessionRepo`
 *   （写入 `<dataDir>/sessions/<id>/harness/`）+ 一个 lane（名 `agent`），并把三条
 *   既有契约接上：
 *   1. **每次决策重置工具预算**（`before_run` hook）→ 与裸 Agent 的 `agent_start` 等价；
 *   2. **工具预算拒绝文案逐字相同**（`before_tool` hook → `ToolBudget`）；
 *   3. **上下文剪枝 + lessons/成绩注入**（`transform_context` hook）。
 * 事实来源: `docs/HARNESS-MIGRATION.md`（方案与已核实事实）；pi-agent-core
 *   harness/agent-harness.d.ts（AgentHarnessOptions / HookMap）。
 * 禁止: 打开 harness 的自动 compaction —— 同一时间只能有一套上下文裁剪机制，
 *   否则两次运行看到的提示词不同（`compaction.enabled=false` 是硬要求）。
 */

import { AgentHarness, DEFAULT_COMPACTION_SETTINGS, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import type {
	AgentMessage,
	AgentTool,
	JsonlSessionRepo as JsonlSessionRepoType,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/pi-agent-core/harness/context";
import type { Context } from "@earendil-works/pi-agent-core/harness/context";
import type { TSchema } from "typebox";
import type { ActionResult } from "./types.js";
import { createHash } from "node:crypto";
import { ToolBudget } from "./tool-budget.js";
import { payloadShapeHash as payloadShapeHashOf } from "./payload-shape.js";
import { stableStringify } from "./scaffold-fingerprint.js";
import { toHarnessTools } from "./harness-tools.js";
import { harnessEventToAgentEvents, type AgentEventLike } from "./harness-events.js";

/** Lane name inside the harness session. One lane per run. */
export const HARNESS_LANE_NAME = "agent";

/**
 * Is the harness backend on? `AGENT_HARNESS=1` enables it; anything else (or
 * unset) keeps the historical bare-Agent path.
 *
 * Deliberately not part of the scaffold knobs: the backend must NOT change what
 * the model sees, so it must not enter the scaffold fingerprint. It is a
 * plumbing switch, and its only job is to make the migration reversible by
 * configuration (docs/HARNESS-MIGRATION.md §6).
 */
export function harnessEnabled(env: Record<string, string | undefined>): boolean {
	return (env.AGENT_HARNESS ?? "").trim() === "1";
}

export interface HarnessRuntimeOptions {
	/** Run data dir; the harness transcript goes to `<dataDir>/sessions/<sessionId>/harness`. */
	dataDir: string;
	/** Our run/session id (also the harness session id, so the two records share a key). */
	sessionId: string;
	/** Already-configured provider registry (catalog or custom path). */
	models: Models;
	model: Model<string>;
	systemPrompt: string;
	tools: readonly AgentTool<TSchema, ActionResult>[];
	maxToolCallsPerDecision: number;
	thinkingLevel: ThinkingLevel;
	/** Pruning + lessons/score injection (same function the bare Agent path uses). */
	transformContext?: (messages: AgentMessage[]) => Promise<AgentMessage[]>;
	/** Fired after each tool call, exactly like the bare path's `afterToolCall`. */
	onActionResult?: (tool: string, result: ActionResult) => void;
	/** Receives agent-shaped events (see harness-events.ts) for telemetry. */
	onEvent?: (event: AgentEventLike) => void;
}

export interface HarnessRuntime {
	harness: AgentHarness<undefined>;
	lane: Awaited<ReturnType<AgentHarness<undefined>["lane"]>>;
	/** Cancellation context for this run (abort on close). */
	context: Context;
	/** Tool calls refused by the budget (run-level health signal). */
	getBudgetBlocks(): number;
	/**
	 * Fingerprint of the FIRST request body actually serialized (D6b), and how
	 * many requests were made. Null until the first request leaves.
	 */
	getPayloadDigest(): {
		payloadHash: string | null;
		/**
		 * Same fingerprint with every number normalized away: comparable across
		 * seeds (payloadHash is not, because the world's numbers are random).
		 */
		payloadShapeHash: string | null;
		payloadCount: number;
	};
	/** Close the harness (flushes the transcript, releases the session). */
	close(): Promise<void>;
}

/**
 * Build the harness for one run.
 *
 * The lane is created on demand by `lane(name)`; the harness derives its initial
 * configuration from `options` (model / thinking level / active tools), so no
 * separate `LaneConfiguration` seed is needed here.
 */
export async function createHarnessRuntime(opts: HarnessRuntimeOptions): Promise<HarnessRuntime> {
	const sessionsRoot = joinPath(opts.dataDir, "sessions", opts.sessionId, "harness");
	const env = new NodeExecutionEnv({ cwd: opts.dataDir });
	const repo: JsonlSessionRepoType = new JsonlSessionRepo({ fileSystem: env, sessionsRoot });

	const session = await repo.create({ cwd: opts.dataDir, id: opts.sessionId }, BACKGROUND_CONTEXT);

	const budget = new ToolBudget(opts.maxToolCallsPerDecision);
	let payloadHash: string | null = null;
	let payloadShapeHash: string | null = null;
	let payloadCount = 0;

	const harnessTools = toHarnessTools<undefined, ActionResult>(opts.tools);

	const canceller = withCancel(BACKGROUND_CONTEXT);

	const { harness } = await AgentHarness.create<undefined>(
		{
			session,
			models: opts.models,
			model: opts.model,
			systemPrompt: opts.systemPrompt,
			thinkingLevel: opts.thinkingLevel,
			tools: harnessTools,
			activeToolNames: opts.tools.map((t) => t.name),
			// Verified: the harness ignores per-tool `executionMode`; ordering comes
			// from here. Writes must stay FIFO (SPEC §10.39.1).
			toolExecution: "sequential",
			// HARD REQUIREMENT (docs/HARNESS-MIGRATION.md §6): only one context
			// trimming mechanism may run. Our pruning lives in `transform_context`,
			// so the harness's own compaction stays off (token counts inherited from
			// the library defaults so the disabled setting is still well-formed).
			compaction: { ...DEFAULT_COMPACTION_SETTINGS, enabled: false },
		},
		canceller.context,
	);

	// 1. Budget window resets at the decision boundary. `before_run` fires once
	//    per prompt, which is exactly one decision (turn_start would be wrong:
	//    a single decision can span several turns).
	harness.hooks.on("before_run", async () => {
		budget.reset();
		return undefined;
	});

	// 2. Real payload fingerprint (D6b): what the provider will actually see, not
	//    what we believe we built. The FIRST request carries the whole scaffold
	//    (system prompt + tool schemas + first world projection), so it is the
	//    discriminator a benchmark needs; later requests differ by history.
	harness.hooks.on("before_payload", async (event) => {
		payloadCount += 1;
		if (payloadHash === null) {
			payloadHash = createHash("sha256")
				.update(stableStringify(event.payload), "utf8")
				.digest("hex")
				.slice(0, 16);
			// Cross-seed comparability: the raw hash can never match two seeds,
			// because the world's numbers differ. The shape hash can.
			payloadShapeHash = payloadShapeHashOf(event.payload);
		}
		return undefined;
	});

	// 2. Budget + unknown-tool refusal, same text as the bare path.
	harness.hooks.on("before_tool", async (event) => {
		if (!opts.tools.some((t) => t.name === event.toolName)) {
			return { block: { reason: `unknown tool: ${event.toolName}` } };
		}
		const refusal = budget.admit();
		return refusal === undefined ? undefined : { block: { reason: refusal } };
	});

	// 3. Context hygiene (pruning + lessons/score injection).
	if (opts.transformContext) {
		const transform = opts.transformContext;
		harness.hooks.on("transform_context", async (event) => ({
			messages: await transform(event.messages),
		}));
	}

	// 4. Tool results → audit (parity with the bare path's `afterToolCall`).
	//    Note: the hook event carries `details`, not `result` (HookMap.after_tool).
	if (opts.onActionResult) {
		const onActionResult = opts.onActionResult;
		harness.hooks.on("after_tool", async (event) => {
			const details = event.details as ActionResult | undefined;
			if (details) onActionResult(event.toolName, details);
			return undefined;
		});
	}

	// 5. Events → telemetry (renamed to the shapes telemetry already reads).
	if (opts.onEvent) {
		const onEvent = opts.onEvent;
		harness.events.on("turn_start", (e) => emit(onEvent, e));
		harness.events.on("message_start", (e) => emit(onEvent, e));
		harness.events.on("message_update", (e) => emit(onEvent, e));
		harness.events.on("message_end", (e) => emit(onEvent, e));
		harness.events.on("tool_start", (e) => emit(onEvent, e));
		harness.events.on("tool_end", (e) => emit(onEvent, e));
		// D6b: transport retries and runtime faults become visible counters.
		harness.events.on("retry_scheduled", (e) => emit(onEvent, e));
		harness.events.on("retry_end", (e) => emit(onEvent, e));
		harness.events.on("fault", (e) => emit(onEvent, e));
		harness.events.on("handler_error", (e) => emit(onEvent, e));
	}

	const lane = await harness.lane(HARNESS_LANE_NAME, canceller.context);

	return {
		harness,
		lane,
		context: canceller.context,
		getBudgetBlocks: () => budget.blocked,
		getPayloadDigest: () => ({ payloadHash, payloadShapeHash, payloadCount }),
		close: async () => {
			await harness.close(canceller.context);
		},
	};
}

/** Translate + deliver one harness event. Never lets a listener error break the run. */
function emit(onEvent: (e: AgentEventLike) => void, event: unknown): void {
	for (const translated of harnessEventToAgentEvents(event as { type?: string })) {
		try {
			onEvent(translated);
		} catch {
			/* telemetry must never break the agent loop */
		}
	}
}

/** Minimal posix/win-agnostic join (paths here are our own data dir). */
function joinPath(...parts: string[]): string {
	return parts
		.filter((p) => p.length > 0)
		.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+/, "")))
		.join("/");
}
