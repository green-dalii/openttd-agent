/**
 * Reflection run — 局终的编排（SPEC §5.1 反思 → 蒸馏 → 落盘）。
 *
 * 职责: 用**一个 pi-agent-core Agent + 反思工具**做复盘（R2b）→ 校验由工具的
 *   `execute` 负责（拒绝会作为工具错误回到模型）→ lessons 落盘、策略过门槛后落盘 →
 *   返回一份可记录的**结果报告**。
 * 事实来源: SPEC §5.1、§5.2、§5.3、§10.74（ADR）、§10.76（R2 契约）。
 * 禁止: 在此创建网络 provider（streamFn 由调用方注入）；禁止在此做磁盘 IO 之外的副作用。
 *
 * 为什么从"文本补全 + JSON 解析"改成工具（2026-09-18, R2b）:
 *   旧路上解析失败只能静默丢弃——模型不知道自己写错了，也就没有机会改写；
 *   而工具的 `execute` 抛错会**把理由交回模型**，下一轮它就能改成一条观察句。
 *   同一个 Agent 类也意味着反思与决策用同一套消息/工具机制（少一套自造协议）。
 *
 * 为什么反思失败必须被吞掉:记账（metrics）是"带/不带 lessons"对照实验的地基,
 * 反思只是锦上添花。让一次网络抖动把整局的结果记录带崩,是明显错误的优先级。
 */

import { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { applySupersessions } from "./lessons.js";
import { buildReflectionPrompt } from "./reflect.js";
import { createReflectionTools, type ReflectionSink } from "./reflect-tools.js";
import { evaluatePromotion, mergeStrategySamples } from "./strategies.js";
import { appendLessons, appendStrategies, readLessons, readStrategies } from "./store.js";
import type { ReflectionFacts } from "./reflect.js";

export interface RunReflectionOptions {
	/** Provider stream function (injected: production = real provider, tests = faux). */
	streamFn: ConstructorParameters<typeof Agent>[0]["streamFn"];
	model: Model<string>;
	dataDir: string;
	facts: ReflectionFacts;
	now?: number;
}

export interface ReflectionReport {
	ok: boolean;
	/** Populated when the model call itself failed. */
	error?: string;
	lessonsSaved: number;
	/** Entries this game's observations replaced (the retraction path, R2). */
	lessonsSuperseded: number;
	/**
	 * Tool calls the model made that were REJECTED, with reasons.
	 * Observable on purpose: a refusal the model never sees teaches nothing
	 * (MEMORY D20/D28), and a run where every attempt was refused must not look
	 * like a run that simply had nothing to record.
	 */
	rejections: string[];
	/**
	 * How many times the model CALLED a recording tool.
	 *
	 * 为什么必须报（2026-09-19 真机事故）：`lessonsSaved: 0` 有两种截然不同的成因——
	 * "这局确实没什么可记"与"模型一个工具都没调（协议不一致/没接上）"。没有这个
	 * 计数，两者在日志里长得一模一样，而后者是**接线失败**（AGENTS §5.1 的教训）。
	 */
	toolCalls: number;
	strategiesPromoted: number;
	/** Raw model reply length — useful for diagnosing empty responses. */
	replyChars: number;
}

/**
 * Reflect on a finished game and persist what survives validation.
 *
 * Never throws: a failed reflection is reported, not propagated. The metrics
 * ledger is written on a separate path (SessionStore.finalize) precisely so that
 * these two concerns cannot take each other down.
 */
export async function runReflection(opts: RunReflectionOptions): Promise<ReflectionReport> {
	const now = opts.now ?? Date.now();
	const ctx = { sessionId: opts.facts.sessionId, seed: opts.facts.seed, now };

	// 反思必须看到**已记录了什么**，否则 `supersedes` 无从产生 ——
	// `supersededBy` 从 Phase C 起就存在、`selectLessons` 也按它过滤，
	// 但全项目没有一处给它赋值：记忆只增不减（R2）。
	const recorded = (() => {
		try {
			return readLessons(opts.dataDir).map((l) => ({ id: l.id, text: l.text }));
		} catch {
			return [];
		}
	})();
	const facts: ReflectionFacts = { ...opts.facts, recorded: opts.facts.recorded ?? recorded };

	// 反思 = 一个 Agent + 两个记录工具。参数由 schema 校验，`execute` 抛错会把
	// 理由交回模型（pi-agent-core 会把 tool error 作为工具结果喂回去），
	// 所以模型有机会把一句"建议"改写成一条观察再试 —— 这是解析 JSON 做不到的。
	const prompt = buildReflectionPrompt(facts);
	const sink: ReflectionSink = { lessons: [], strategies: [], rejections: [] };
	let recordCalls = 0;
	const agent = new Agent({
		streamFn: opts.streamFn,
		// 反思不该看到 UI-only 消息（这里只有一条 user 提示，但保持一致）
		convertToLlm: (msgs) => msgs.filter((m) => m.role === "user" || m.role === "assistant") as never,
		initialState: {
			systemPrompt: prompt.system,
			model: opts.model,
			thinkingLevel: "off",
			tools: createReflectionTools(sink, ctx),
			messages: [],
		},
	});

	let replyChars = 0;
	try {
		agent.subscribe((event) => {
			if (event.type === "tool_execution_start" && String(event.toolName).startsWith("record_")) {
				recordCalls += 1;
			}
			if (event.type === "message_end") {
				const m = event.message as { role?: string; content?: unknown };
				if (m.role === "assistant" && typeof m.content === "string") replyChars += m.content.length;
			}
		});
		await agent.prompt(prompt.user);
		// provider 失败在 pi-agent-core 里是**状态**而不是抛出的异常：
		// 库把错误记在 `agent.state.errorMessage` 上并让本轮结束。读它，
		// 否则一次网络故障会伪装成"这局没什么可记录的"（静默降级）。
		if (agent.state.errorMessage) throw new Error(String(agent.state.errorMessage));
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			error: message,
			lessonsSaved: 0,
			lessonsSuperseded: 0,
			rejections: sink.rejections,
			toolCalls: recordCalls,
			strategiesPromoted: 0,
			replyChars,
		};
	}

	const lessons = sink.lessons;
	const samples = sink.strategies;

	let lessonsSaved = 0;
	let lessonsSuperseded = 0;
	try {
		// 先把 `supersedes` 落到库里（作废已有的、可能已被推翻的观察），
		// 再追加本局的新条目。落盘的库因此包含被作废者（带 supersededBy），
		// 而注入端 `selectLessons` 会把它们滤掉 —— 记忆**可以被推翻**。
		const existing = readLessons(opts.dataDir);
		const applied = applySupersessions(existing, lessons);
		const changed = applied.filter(
			(l) => l.supersededBy && !existing.find((e) => e.id === l.id)?.supersededBy,
		);
		appendLessons(opts.dataDir, changed);
		lessonsSuperseded = changed.length;
		lessonsSaved = appendLessons(opts.dataDir, lessons);
	} catch {
		// Persistence failure is reported as zero saved rather than thrown.
		lessonsSaved = 0;
		lessonsSuperseded = 0;
	}

	let strategiesPromoted = 0;
	try {
		const merged = readStrategies(opts.dataDir);
		// Accumulate this game's samples into the pool. `mergeStrategySamples` also
		// carries over each card's human `enabled` flag, so a confirmed strategy is
		// not silently un-confirmed by a later write.
		//
		// The **whole pool** is persisted, not just the promoted cards: a pattern
		// needs samples from 2 games before it can pass the gate, so the first
		// game's sample has to live somewhere. Writing only winners made the gate
		// unreachable (game 1's sample was discarded, so game 2 only ever saw
		// itself). Injectability is enforced in selectStrategies(), which requires
		// BOTH the gate and the human flag.
		const pool = mergeStrategySamples(samples, merged, now);
		appendStrategies(opts.dataDir, pool);
		strategiesPromoted = pool.filter((c) => evaluatePromotion(c).promoted).length;
	} catch {
		strategiesPromoted = 0;
	}

	if (recordCalls === 0) {
		// 模型一次都没调用记录工具：这**不是**"没什么可记"，而是协议/接线问题，
		// 必须显式喊出来（真机上沉默过一整天，见 R2b 事故）。
		// eslint-disable-next-line no-console
		console.log(
			"[evolution] reflection WARNING: the model called no recording tool - " +
				"nothing was recorded, and this is NOT the same as 'nothing to record'",
		);
	}
	if (sink.rejections.length > 0) {
		// 拒绝必须可见：一局里"全部被拒"和"本来就没什么可记"是两件事。
		// eslint-disable-next-line no-console
		console.log(
			`[evolution] reflection: ${sink.rejections.length} tool call(s) rejected by the validator ` +
				`(the model was told why and could retry)`,
		);
	}
	return {
		ok: true,
		lessonsSaved,
		lessonsSuperseded,
		rejections: sink.rejections,
		toolCalls: recordCalls,
		strategiesPromoted,
		replyChars,
	};
}
