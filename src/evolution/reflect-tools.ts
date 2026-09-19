/**
 * Reflection tools — 把"复盘"变成一个**用工具记录**的过程（R2b，SPEC §10.76）。
 *
 * 职责: 定义反思阶段可用的两个工具（`record_lesson` / `record_strategy`），
 *   把校验失败**作为工具错误交回模型**，并收集通过校验的条目。
 * 事实来源: SPEC §5.1/§5.2、§10.74（ADR）、§10.76（R2 契约）。
 * 禁止: 在这里调用模型（streamFn 由调用方注入）；禁止在磁盘上做 IO。
 *
 * 为什么不让模型"输出一段 JSON 再由我们解析"（2026-09-18）：
 *   1. 解析失败只能**静默丢弃**——模型永远不知道自己写错了，也就没有机会改写；
 *   2. JSON 里没有 schema，字段名/类型全靠提示词约束（本项目已为"提示词说一套、
 *      代码另一套"付过代价）；
 *   3. 工具契约是 pi-agent-core 的原生机制：参数在 `execute` 之前被 schema 校验，
 *      `execute` 抛错则**错误内容回到模型**（它下一轮就能改）。校验因此成为
 *      **可教学的反馈**，而不是事后过滤（MEMORY D26/D30 的正确形态）。
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateLesson, type ReflectionContext } from "./lessons.js";
import type { Lesson } from "./types.js";
import type { StrategySample } from "./strategies.js";

/** 反思阶段收集到的、已通过校验的条目。 */
export interface ReflectionSink {
	lessons: Lesson[];
	strategies: StrategySample[];
	/** 被拒绝的次数与理由（可观测：拒绝不是静默的）。 */
	rejections: string[];
}

const OutcomeSchema = Type.Object({
	metric: Type.Union(
		[
			Type.Literal("delivered"),
			Type.Literal("deliveredPerDay"),
			Type.Literal("income"),
			Type.Literal("money"),
			Type.Literal("vehicles"),
			Type.Literal("stations"),
			Type.Literal("construction"),
		],
		{ description: "Which measured quantity this observation is about" },
	),
	before: Type.Number({ description: "Reading before the action, as recorded" }),
	after: Type.Number({ description: "Reading after the action, as recorded" }),
});

const LessonParams = Type.Object({
	text: Type.String({
		description:
			"One sentence stating what HAPPENED in this game (an observation). " +
			"Never an instruction or advice - those are rejected.",
	}),
	outcome: OutcomeSchema,
	evidence: Type.Array(Type.String(), {
		description: "The recorded game facts this observation rests on (at least one)",
		minItems: 1,
	}),
	confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	supersedes: Type.Optional(
		Type.Array(Type.String(), {
			description: "Ids of previously recorded observations this one contradicts or replaces",
		}),
	),
});

const StrategyParams = Type.Object({
	action: Type.String({ description: "Tool name the pattern used, e.g. build_bus_route" }),
	params: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]))),
	value: Type.Number({ description: "Measured value of the outcome (money delta), from the record" }),
	evidence: Type.Array(Type.String(), { minItems: 1 }),
});

/**
 * Build the reflection tools. `execute` THROWS on rejection: pi-agent-core turns a
 * thrown error into a tool error the model reads, which is the whole point.
 */
export function createReflectionTools(sink: ReflectionSink, ctx: ReflectionContext): AgentTool[] {
	const recordLesson: AgentTool<typeof LessonParams, { id: string }> = {
		name: "record_lesson",
		label: "Record Lesson",
		description:
			"Record ONE observation about what happened in this game. Call it once per " +
			"observation. If a call is rejected you will be told why - rewrite it as a " +
			"statement about the past and call again.",
		parameters: LessonParams,
		execute: async (_id, params) => {
			const verdict = validateLesson(params, ctx);
			if (!verdict.ok) {
				sink.rejections.push(verdict.reason);
				throw new Error(`record_lesson rejected: ${verdict.reason}`);
			}
			const lesson = verdict.lesson;
			// Same text recorded twice in one reflection is one observation.
			if (!sink.lessons.some((l) => l.id === lesson.id)) sink.lessons.push(lesson);
			return {
				content: [{ type: "text" as const, text: `recorded ${lesson.id}` }],
				details: { id: lesson.id },
			};
		},
	};

	const recordStrategy: AgentTool<typeof StrategyParams, { action: string }> = {
		name: "record_strategy",
		label: "Record Strategy",
		description:
			"Record ONE parameterised pattern that this game provides a sample for " +
			"(used by the promotion gate). Needs a measured `value` and evidence.",
		parameters: StrategyParams,
		execute: async (_id, params) => {
			const action = typeof params.action === "string" ? params.action.trim() : "";
			if (!action) throw new Error("record_strategy rejected: action is required");
			if (!Number.isFinite(params.value)) {
				throw new Error("record_strategy rejected: value must be a measured number");
			}
			const evidence = (Array.isArray(params.evidence) ? params.evidence : [])
				.map((e) => String(e).replace(/\s+/g, " ").trim())
				.filter(Boolean);
			if (evidence.length === 0) throw new Error("record_strategy rejected: evidence is required");
			const paramsIn = params.params && typeof params.params === "object" ? params.params : {};
			sink.strategies.push({
				action,
				params: paramsIn as Record<string, number | string>,
				value: params.value,
				evidence: [...new Set(evidence)],
				sessionId: ctx.sessionId,
				createdAt: ctx.now,
			});
			return {
				content: [{ type: "text" as const, text: `recorded strategy ${action}` }],
				details: { action },
			};
		},
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return [recordLesson, recordStrategy] as unknown as AgentTool<any>[];
}
