/**
 * Agent telemetry — accumulate pi-agent-core AgentEvents into a dashboard model.
 *
 * 职责: 把 Agent 的事件流（message/thinking/tool）累积成**只读快照**：
 *   token 用量（总量/按 turn/按 tool）、思考文本、每步记录、阶段统计。
 *   供 Web dashboard 与 session 归档消费（契约见 docs/DASHBOARD-API.md §2.3）。
 * 事实来源: pi-agent-core AgentEvent（types.d.ts）；pi-ai AssistantMessage.usage /
 *   AssistantMessageEvent（thinking_delta 等）。
 * 禁止: IO/网络/定时器；不持有 Agent 引用（只吃事件）；不抛异常（坏事件忽略）。
 */

import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

/* ----------------------------- wire types ----------------------------- */

/** Token/cost accounting for one scope (mirrors docs §2.1). */
export interface UsageView {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costTotal: number;
}

/** One observable step: an assistant message or a tool execution (§2.2). */
export interface StepRecord {
	id: string;
	ts: number;
	turn: number;
	kind: "message" | "tool";
	text?: string;
	thinking?: string;
	model?: string;
	provider?: string;
	stopReason?: string;
	usage?: UsageView;
	tool?: string;
	args?: unknown;
	ok?: boolean;
	summary?: string;
	data?: Record<string, unknown>;
	durationMs?: number;
}

/** Full telemetry snapshot handed to the dashboard (§2.3). */
export interface TelemetrySnapshot {
	sessionId: string | null;
	startedAt: number;
	lastActivityAt: number;
	turns: number;
	activeTurn: number;
	steps: StepRecord[];
	usage: {
		total: UsageView;
		byTurn: { turn: number; usage: UsageView; steps: number }[];
		byTool: { tool: string; calls: number; failures: number; avgDurationMs: number }[];
	};
	totals: { decisions: number; messages: number; toolCalls: number; toolFailures: number };
	recentThinking: { turn: number; ts: number; text: string }[];
	brain: { provider: string | null; model: string | null; kind: "real" | "faux" | null };
}

export interface TelemetryOptions {
	/** Max retained steps (default 400, oldest dropped). */
	limit?: number;
	sessionId?: string;
}

const DEFAULT_LIMIT = 400;
const RECENT_THINKING = 5;

function zeroUsage(): UsageView {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		costTotal: 0,
	};
}

/** Defensive numeric read: undefined/NaN → 0. */
function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** pi-ai Usage → wire view (missing reasoning/cost becomes 0, never undefined). */
export function toUsageView(u: Usage | undefined): UsageView {
	if (!u) return zeroUsage();
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		reasoning: num(u.reasoning),
		totalTokens: num(u.totalTokens),
		costTotal: num(u.cost?.total),
	};
}

function addUsage(a: UsageView, b: UsageView): UsageView {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		reasoning: a.reasoning + b.reasoning,
		totalTokens: a.totalTokens + b.totalTokens,
		costTotal: a.costTotal + b.costTotal,
	};
}

/** Concatenate an assistant message's content blocks by kind. */
function joinContent(msg: AssistantMessage, kind: "text" | "thinking"): string {
	const parts: string[] = [];
	for (const block of msg.content ?? []) {
		if (kind === "text" && block.type === "text") parts.push(block.text ?? "");
		if (kind === "thinking" && block.type === "thinking") parts.push(block.thinking ?? "");
	}
	return parts.join("").trim();
}

/** In-flight message being streamed. */
interface PendingMessage {
	thinking: string;
	text: string;
	ts: number;
	turn: number;
}

/** In-flight tool execution. */
interface PendingTool {
	tool: string;
	args: unknown;
	startedAt: number;
	turn: number;
}

/**
 * Accumulates AgentEvents. Pure in-memory; safe to call from a signal handler
 * of `Agent.subscribe()` (never throws, never awaits).
 */
export class Telemetry {
	private readonly limit: number;
	private readonly sessionId: string | null;
	private readonly startedAt = Date.now();

	private steps: StepRecord[] = [];
	private pendingMsg: PendingMessage | null = null;
	private pendingTools = new Map<string, PendingTool>();
	private recentThinking: { turn: number; ts: number; text: string }[] = [];

	private activeTurn = 0;
	private turns = 0;
	private decisions = 0;
	private messages = 0;
	private toolCalls = 0;
	private toolFailures = 0;
	private lastActivityAt = Date.now();

	private totalUsage: UsageView = zeroUsage();
	private turnUsage = new Map<number, { usage: UsageView; steps: number }>();
	private toolStats = new Map<string, { calls: number; failures: number; totalMs: number }>();
	private brain: { provider: string | null; model: string | null; kind: "real" | "faux" | null } = {
		provider: null,
		model: null,
		kind: null,
	};

	private seq = 0;

	/** Fired with each completed step (runner: audit JSONL + WS push). */
	onStep?: (rec: StepRecord) => void;
	/** Fired on any observable change (runner: throttled broadcast). */
	onActivity?: () => void;

	constructor(opts: TelemetryOptions = {}) {
		this.limit = opts.limit ?? DEFAULT_LIMIT;
		this.sessionId = opts.sessionId ?? null;
	}

	/** Record which brain drives this session (shown in the dashboard header). */
	setBrain(b: { provider: string; model: string; kind: "real" | "faux" }): void {
		this.brain = { provider: b.provider, model: b.model, kind: b.kind };
		this.touch();
	}

	/** Count one decision point (call right before prompting the agent). */
	decisionPoint(): void {
		this.decisions++;
		this.touch();
	}

	/** Consume one pi-agent-core AgentEvent. Best-effort: bad shapes ignored. */
	ingestAgentEvent(ev: AgentEvent): void {
		try {
			const type = (ev as { type?: string }).type;
			switch (type) {
				case "turn_start":
					this.turns++;
					this.activeTurn = this.turns;
					break;
				case "message_start": {
					const msg = (ev as { message?: AssistantMessage }).message;
					this.pendingMsg = {
						thinking: "",
						text: "",
						ts: Date.now(),
						turn: this.activeTurn || this.turns || 1,
					};
					void msg; // deltas accumulate; the end event carries usage
					break;
				}
				case "message_update": {
					const inner = (ev as { assistantMessageEvent?: { type?: string; delta?: string } })
						.assistantMessageEvent;
					if (!inner || !this.pendingMsg) break;
					if (inner.type === "thinking_delta" && typeof inner.delta === "string") {
						this.pendingMsg.thinking += inner.delta;
					} else if (inner.type === "text_delta" && typeof inner.delta === "string") {
						this.pendingMsg.text += inner.delta;
					}
					break;
				}
				case "message_end":
					this.finishMessage((ev as { message?: AssistantMessage }).message);
					break;
				case "tool_execution_start": {
					const e = ev as { toolCallId?: string; toolName?: string; args?: unknown };
					if (!e.toolCallId) break;
					this.pendingTools.set(e.toolCallId, {
						tool: String(e.toolName ?? "unknown"),
						args: e.args,
						startedAt: Date.now(),
						turn: this.activeTurn || this.turns || 1,
					});
					break;
				}
				case "tool_execution_end":
					this.finishTool(ev as {
						toolCallId?: string;
						toolName?: string;
						result?: unknown;
						isError?: boolean;
					});
					break;
				default:
					return; // agent_start/agent_end/turn_end/... not tracked
			}
			this.touch();
		} catch {
			/* telemetry must never break the agent loop */
		}
	}

	/** Current immutable snapshot (fresh arrays; safe to JSON-serialize). */
	snapshot(): TelemetrySnapshot {
		return {
			sessionId: this.sessionId,
			startedAt: this.startedAt,
			lastActivityAt: this.lastActivityAt,
			turns: this.turns,
			activeTurn: this.activeTurn,
			steps: this.steps.map((s) => ({ ...s })),
			usage: {
				total: { ...this.totalUsage },
				byTurn: [...this.turnUsage.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([turn, v]) => ({ turn, usage: { ...v.usage }, steps: v.steps })),
				byTool: [...this.toolStats.entries()]
					.map(([tool, v]) => ({
						tool,
						calls: v.calls,
						failures: v.failures,
						avgDurationMs: v.calls ? Math.round(v.totalMs / v.calls) : 0,
					}))
					.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
			},
			totals: {
				decisions: this.decisions,
				messages: this.messages,
				toolCalls: this.toolCalls,
				toolFailures: this.toolFailures,
			},
			recentThinking: this.recentThinking.map((r) => ({ ...r })),
			brain: { ...this.brain },
		};
	}

	/* ------------------------------ internals ------------------------------ */

	private finishMessage(msg: AssistantMessage | undefined): void {
		if (!msg || msg.role !== "assistant") return;
		const pending = this.pendingMsg;
		const turn = pending?.turn ?? (this.activeTurn || this.turns || 1);
		// Prefer streamed deltas; fall back to the final content blocks.
		const thinking = (pending?.thinking || "").trim() || joinContent(msg, "thinking");
		const text = (pending?.text || "").trim() || joinContent(msg, "text");
		const usage = msg.usage ? toUsageView(msg.usage) : undefined;

		const rec: StepRecord = {
			id: this.nextId(),
			ts: Date.now(),
			turn,
			kind: "message",
			text: text || undefined,
			thinking: thinking || undefined,
			model: msg.model,
			provider: msg.provider,
			stopReason: msg.stopReason,
			usage,
		};
		this.messages++;
		this.push(rec);
		if (usage) {
			this.totalUsage = addUsage(this.totalUsage, usage);
			const t = this.turnUsage.get(turn) ?? { usage: zeroUsage(), steps: 0 };
			t.usage = addUsage(t.usage, usage);
			this.turnUsage.set(turn, t);
		}
		if (thinking) {
			this.recentThinking = [
				...this.recentThinking,
				{ turn, ts: rec.ts, text: thinking.slice(0, 2000) },
			].slice(-RECENT_THINKING);
		}
		this.pendingMsg = null;
		this.onStep?.(rec);
	}

	private finishTool(e: {
		toolCallId?: string;
		toolName?: string;
		result?: unknown;
		isError?: boolean;
	}): void {
		const id = e.toolCallId;
		const pending = id ? this.pendingTools.get(id) : undefined;
		if (id) this.pendingTools.delete(id);
		const tool = pending?.tool ?? String(e.toolName ?? "unknown");
		const startedAt = pending?.startedAt ?? Date.now();
		const durationMs = Math.max(0, Date.now() - startedAt);
		const details = (e.result as { details?: Record<string, unknown> } | undefined)?.details;
		const ok = e.isError ? false : details?.ok === undefined ? true : Boolean(details.ok);

		const rec: StepRecord = {
			id: this.nextId(),
			ts: Date.now(),
			turn: pending?.turn ?? (this.activeTurn || this.turns || 1),
			kind: "tool",
			tool,
			args: pending?.args,
			ok,
			summary: typeof details?.summary === "string" ? details.summary : undefined,
			data: details?.data as Record<string, unknown> | undefined,
			durationMs,
		};
		this.toolCalls++;
		if (!ok) this.toolFailures++;
		const st = this.toolStats.get(tool) ?? { calls: 0, failures: 0, totalMs: 0 };
		st.calls++;
		if (!ok) st.failures++;
		st.totalMs += durationMs;
		this.toolStats.set(tool, st);
		this.push(rec);
		this.onStep?.(rec);
	}

	private push(rec: StepRecord): void {
		this.steps.push(rec);
		if (this.steps.length > this.limit) this.steps = this.steps.slice(-this.limit);
		const t = this.turnUsage.get(rec.turn) ?? { usage: zeroUsage(), steps: 0 };
		if (rec.kind === "tool") {
			t.steps++;
			this.turnUsage.set(rec.turn, t);
		}
	}

	private nextId(): string {
		this.seq++;
		return `s${this.seq}`;
	}

	private touch(): void {
		this.lastActivityAt = Date.now();
		try {
			this.onActivity?.();
		} catch {
			/* listener errors must not break ingestion */
		}
	}
}
