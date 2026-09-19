/**
 * Unit tests — 记忆的装载与注入,以及局终反思的编排。
 *
 * 职责: 锁定"记忆真的接上了"这条链路——开局读库 → 选出要注入的 → 计数记账;
 *   局终反思 → 蒸馏 → 落盘。用注入的假 `complete`,不碰网络。
 * 事实来源: SPEC §5.1（局生命周期）、§5.2、§5.3,docs/EVOLUTION.md §4。
 * 禁止: 在此发真实 LLM 请求。
 *
 * 为什么这些断言是"接线"而不是"逻辑":本仓库最贵的一课（AGENTS §5.1）是
 * **功能写好了但根本没接上**——`lessonsProvider` 存在了十几版却没人喂。
 * 所以这里明确断言:注入计数 > 0、且真的出现在 prompt 里。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	loadMemory,
	makeLessonProvider,
	memoryCounts,
	type LoadedMemory,
} from "../../src/evolution/memory.js";
import { runReflection } from "../../src/evolution/reflection-run.js";
import { pruningTransformContext } from "../../src/agent/context.js";
import { appendLessons, appendStrategies, readLessons, readStrategies } from "../../src/evolution/store.js";
import { lessonId, type Lesson } from "../../src/evolution/lessons.js";
import { MIN_STRATEGY_VALUE, selectStrategies, strategyId } from "../../src/evolution/strategies.js";
import type { StrategyCard } from "../../src/evolution/types.js";

const NOW = 1_700_000_000_000;

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "evo-mem-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function lesson(over: Partial<Lesson> = {}): Lesson {
	const text = over.text ?? "build near towns";
	return {
		id: lessonId(text),
		text,
		outcome: { metric: "delivered", before: 0, after: 120 },
		confidence: 0.6,
		evidence: ["delivered 120 after the second town was connected"],
		sourceSessionId: "s1",
		sourceSeed: 7,
		createdAt: NOW - 1000,
		...over,
	};
}

function card(over: Partial<StrategyCard> = {}): StrategyCard {
	const params = over.params ?? { distance: 24 };
	return {
		id: strategyId(over.action ?? "build_bus_route", params),
		name: over.action ?? "build_bus_route",
		action: over.action ?? "build_bus_route",
		params,
		valuePerRun: [MIN_STRATEGY_VALUE + 1000, MIN_STRATEGY_VALUE + 2000],
		evidence: ["money +18000"],
		sourceSessionIds: ["s1"],
		createdAt: NOW - 1000,
		enabled: true,
		...over,
	};
}

const FACTS = {
	sessionId: "s9",
	seed: 3,
	summary: {
		money: 1000,
		vehicleCount: 2,
		stationCount: 1,
		decisions: 4,
		toolCalls: 3,
		toolFailures: 0,
		constructionDone: true,
		durationMs: 60000,
	},
	evidence: ["1950-01: built bus route, ok"],
};

describe("memory: loadMemory(开局读库)", () => {
	it("空库 -> 空记忆,provider 返回空数组(不注入任何东西)", () => {
		const mem = loadMemory(dir, { now: NOW, inject: true });
		expect(mem.lessons).toEqual([]);
		expect(mem.strategies).toEqual([]);
		expect(makeLessonProvider(mem)()).toEqual([]);
		expect(memoryCounts(mem)).toEqual({ lessonsInjected: 0, strategiesInjected: 0 });
	});

	it("装载已确认的策略与被选中的 lessons", () => {
		appendLessons(dir, [lesson({ text: "a" }), lesson({ text: "b" })]);
		appendStrategies(dir, [card()]);
		const mem = loadMemory(dir, { now: NOW, inject: true });
		expect(mem.lessons).toHaveLength(2);
		expect(mem.strategies).toHaveLength(1);
	});

	it("未人工确认的策略不装载(SPEC §5.3 guardrail)", () => {
		appendStrategies(dir, [card({ enabled: false })]);
		expect(loadMemory(dir, { now: NOW, inject: true }).strategies).toEqual([]);
	});

	it("被覆盖/过期的 lessons 不装载", () => {
		appendLessons(dir, [
			lesson({ text: "live" }),
			lesson({ text: "dead", supersededBy: "x", confidence: 0.9 }),
		]);
		const mem = loadMemory(dir, { now: NOW, inject: true });
		expect(mem.lessons.map((l) => l.text)).toEqual(["live"]);
	});

	it("限量生效(不能把整库塞进 prompt)", () => {
		appendLessons(
			dir,
			Array.from({ length: 30 }, (_, i) => lesson({ text: `l${i}` })),
		);
		expect(loadMemory(dir, { now: NOW, limit: 3, inject: true }).lessons).toHaveLength(3);
	});

	it("注入行数的计数与实际注入内容一致(记账必须诚实)", () => {
		appendLessons(dir, [lesson({ text: "a" }), lesson({ text: "b" })]);
		appendStrategies(dir, [card()]);
		const mem = loadMemory(dir, { now: NOW, inject: true });
		const lines = makeLessonProvider(mem)();
		const counts = memoryCounts(mem);
		expect(counts.lessonsInjected).toBe(2);
		expect(counts.strategiesInjected).toBe(1);
		expect(lines).toHaveLength(3);
	});

	it("注入内容是可辨认的'对过去的陈述'，不是祈使句", () => {
		appendLessons(dir, [lesson({ text: "depots within 8 tiles of a station loaded faster" })]);
		const lines = makeLessonProvider(loadMemory(dir, { now: NOW, inject: true }))();
		expect(lines.join(" ")).toContain("depots within 8 tiles of a station loaded faster");
		// RL harness：只能给"发生过什么"，不能给"该做什么"。
		// R2（2026-09-18）：格式从 "Previously an action like this paid off: …"
		// 改为 "Recorded in an earlier game: … [<metric> before -> after]" ——
		// 旧格式**替模型断言了因果**（paid off），而那条因果从未被验证过。
		expect(lines[0]).toMatch(/recorded in an earlier game/i);
		expect(lines[0]).not.toMatch(/paid off|should|must/i);
		expect(lines[0]).not.toMatch(/^(do|avoid|don't)\b/i);
	});

	it("默认**注入**：跨局记忆是自我进化的机制（项目决定 2026-09-12）", () => {
		// 曾经我把默认改成了"关闭"，理由是不给 agent 递结论。项目所有者否了：
		// **跨局记忆当然要存在，这是 agent 能自进化的关键。**
		// 所以约束落在**内容**上（只能是 agent 自己观察到的记录，不能是 harness 的建议），
		// 而不是"记忆存在与否"。
		appendLessons(dir, [lesson({ text: "keep depots close" })]);
		appendStrategies(dir, [card({ enabled: true })]);

		const on = loadMemory(dir, { now: NOW });
		expect(on.lines.length).toBeGreaterThan(0);
		expect(memoryCounts(on).lessonsInjected).toBe(1);

		// 关掉时必须连库都不读，这样记的 0 才是真话（M3 对照组的自变量）
		const off = loadMemory(dir, { now: NOW, inject: false });
		expect(off.lines).toEqual([]);
		expect(off.lessons).toEqual([]);
		expect(memoryCounts(off).lessonsInjected).toBe(0);
	});

	it("provider 是纯函数式的:多次调用结果一致(同局内不得漂移)", () => {
		appendLessons(dir, [lesson({ text: "a" })]);
		const provider = makeLessonProvider(loadMemory(dir, { now: NOW, inject: true }));
		expect(provider()).toEqual(provider());
	});

	it("损坏的库文件不会让装载抛异常", () => {
		appendLessons(dir, [lesson({ text: "a" })]);
		// corrupt the store and reload
		rmSync(path.join(dir, "evolution", "lessons.jsonl"));
		expect(() => loadMemory(dir, { now: NOW, inject: true })).not.toThrow();
		expect(loadMemory(dir, { now: NOW, inject: true }).lessons).toEqual([]);
	});
});

describe("reflection-run: runReflection(局终反思编排)", () => {
	/** A fake model call: returns whatever script we hand it. */
	function completer(reply: string | Error) {
		return async () => {
			if (reply instanceof Error) throw reply;
			return reply;
		};
	}

	const GOOD = JSON.stringify({
		lessons: [
			{
				text: "the second route delivered 137 units in 300 game days",
				outcome: { metric: "delivered", before: 0, after: 137 },
				evidence: ["delivered 137 between 1950-01 and 1950-11"],
				confidence: 0.7,
			},
		],
		strategies: [
			{ action: "build_bus_route", params: { distance: 20 }, value: 20000, evidence: ["money +20000"] },
		],
	});

	it("把反思产出的 lessons 落盘", async () => {
		const r = await runReflection({
			complete: completer(GOOD),
			dataDir: dir,
			facts: FACTS,
			now: NOW,
		});
		expect(r.ok).toBe(true);
		expect(r.lessonsSaved).toBe(1);
		expect(readLessons(dir)).toHaveLength(1);
		expect(readLessons(dir)[0]!.sourceSessionId).toBe("s9");
	});

	it("单局策略不会被提升(SPEC §5.3:已验证局>=2 才通过门槛)", async () => {
		const r = await runReflection({ complete: completer(GOOD), dataDir: dir, facts: FACTS, now: NOW });
		expect(r.strategiesPromoted).toBe(0);
		// The sample IS kept as a candidate: the gate needs 2 games, so game 1's
		// sample must persist somewhere or the gate is unreachable.
		const pool = readStrategies(dir);
		expect(pool).toHaveLength(1);
		expect(pool[0]!.valuePerRun).toHaveLength(1);
		expect(pool[0]!.enabled).toBe(false);
	});

	it("未通过门槛的候选不得被注入(池子本身不可注入)", () => {
		// The pool holds candidates; injection must still require the gate. Without
		// this, a single game's sample would be teachable advice.
		const candidate: StrategyCard = { ...card(), enabled: true, valuePerRun: [999999] };
		const mem = { lessons: [], strategies: selectStrategies([candidate]), lines: [] };
		expect(mem.strategies).toEqual([]);
	});

	it("通过门槛但未人工确认的策略也不注入(SPEC §5.3 guardrail)", () => {
		const promoted: StrategyCard = { ...card(), enabled: false };
		expect(selectStrategies([promoted])).toEqual([]);
	});

	it("两次不同局的同模式采样累计后入库", async () => {
		await runReflection({ complete: completer(GOOD), dataDir: dir, facts: FACTS, now: NOW });
		await runReflection({
			complete: completer(GOOD),
			dataDir: dir,
			facts: { ...FACTS, sessionId: "s10" },
			now: NOW + 1000,
		});
		const cards = readStrategies(dir);
		expect(cards).toHaveLength(1);
		expect(cards[0]!.valuePerRun).toHaveLength(2);
	});

	it("没有证据的反思不落盘", async () => {
		const r = await runReflection({
			complete: completer(
				JSON.stringify({
					lessons: [
						{ text: "the route delivered 137 units", outcome: { metric: "delivered", before: 0, after: 137 } },
					],
				}),
			),
			dataDir: dir,
			facts: FACTS,
			now: NOW,
		});
		expect(r.lessonsSaved).toBe(0);
		expect(readLessons(dir)).toEqual([]);
	});

	it("模型调用失败 -> 报告错误但**不抛异常**(反思失败不得毁掉整局)", async () => {
		const r = await runReflection({
			complete: completer(new Error("network down")),
			dataDir: dir,
			facts: FACTS,
			now: NOW,
		});
		expect(r.ok).toBe(false);
		expect(r.error).toContain("network down");
		expect(r.lessonsSaved).toBe(0);
	});

	it("垃圾响应 -> ok 但没有任何产出(不算错误)", async () => {
		const r = await runReflection({ complete: completer("lol no json"), dataDir: dir, facts: FACTS, now: NOW });
		expect(r.lessonsSaved).toBe(0);
		expect(r.strategiesPromoted).toBe(0);
	});

	it("累计落盘而不是覆盖(跨局累积)", async () => {
		await runReflection({ complete: completer(GOOD), dataDir: dir, facts: FACTS, now: NOW });
		await runReflection({
			complete: completer(
				JSON.stringify({
					lessons: [
						{
							text: "a 239-tile route was still under construction at the horizon",
							outcome: { metric: "construction", before: 0, after: 1 },
							evidence: ["road still building at the horizon"],
						},
					],
				}),
			),
			dataDir: dir,
			facts: { ...FACTS, sessionId: "s10" },
			now: NOW + 1000,
		});
		expect(readLessons(dir)).toHaveLength(2);
	});

	it("prompt 用的是这一局的事实", async () => {
		let seen = "";
		await runReflection({
			complete: async (p) => {
				seen = `${p.system}\n${p.user}`;
				return GOOD;
			},
			dataDir: dir,
			facts: FACTS,
			now: NOW,
		});
		expect(seen).toContain("s9");
		expect(seen).toContain("1950-01: built bus route, ok");
	});
});

describe("memory: LoadedMemory 形状", () => {
	it("计数为 0 时 provider 也不注入(空记忆必须是无副作用的)", () => {
		const empty: LoadedMemory = { lessons: [], strategies: [], lines: [] };
		expect(makeLessonProvider(empty)()).toEqual([]);
		expect(memoryCounts(empty)).toEqual({ lessonsInjected: 0, strategiesInjected: 0 });
	});
});

describe("memory: 注入到底有没有进到 prompt(接线证明)", () => {
	// The most expensive lesson in this repo (AGENTS §5.1) is a component that was
	// written, tested, and never connected. `lessonsProvider` sat unfed for ten
	// versions. So this asserts the whole chain end to end within the process:
	// store -> loadMemory -> provider -> transformContext -> messages.
	it("装载的 lesson 真的出现在送往模型的消息里", async () => {
		appendLessons(dir, [lesson({ text: "depots within 8 tiles of a station loaded faster" })]);
		const mem = loadMemory(dir, { now: NOW, inject: true });
		const transform = pruningTransformContext({
			keepRecent: 5,
			lessonsProvider: makeLessonProvider(mem),
		});
		const out = await transform([
			{ role: "user", content: "do something" } as never,
		]);
		const text = JSON.stringify(out);
		expect(text).toContain("depots within 8 tiles of a station loaded faster");
	});

	it("策略卡也进入注入(不只是 lesson)", async () => {
		appendStrategies(dir, [card()]);
		const mem = loadMemory(dir, { now: NOW, inject: true });
		const transform = pruningTransformContext({ lessonsProvider: makeLessonProvider(mem) });
		const out = await transform([{ role: "user", content: "hi" } as never]);
		expect(JSON.stringify(out)).toContain("build_bus_route");
	});

	it("空记忆时不注入任何额外消息(没有 memory 的游戏不受影响)", async () => {
		const mem = loadMemory(dir, { now: NOW, inject: true });
		const transform = pruningTransformContext({ lessonsProvider: makeLessonProvider(mem) });
		const msgs = [{ role: "user", content: "hi" } as never];
		const out = await transform(msgs);
		expect(out).toHaveLength(1);
	});

	it("没有 provider 时行为不变(向后兼容)", async () => {
		const transform = pruningTransformContext({ keepRecent: 40 });
		const msgs = [{ role: "user", content: "hi" } as never];
		expect(await transform(msgs)).toHaveLength(1);
	});
});

/**
 * R2 闭环：**经验可以被推翻**（2026-09-18）。
 *
 * `supersededBy` 从 Phase C 起就在类型里、`selectLessons` 也一直按它过滤，
 * 但全项目没有一处给它赋值 —— 记忆只增不减，一条被后续游戏否证的观察会
 * 永久注入。这条测试走完整条路：反思看到现库 → 模型给出 supersedes →
 * 落盘时作废 → 注入端不再出现。
 */
describe("R2: 反思 → 落盘 的 supersede 闭环", () => {
	/** 单次回复的 completer（局部的那个是别的 describe 的内部函数）。 */
	const completer = (reply: string) => async () => reply;
	it("第二局推翻第一局的观察：旧条被作废，且不再进入注入", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "r2-sup-"));
		// 第一局：记录一条观察
		await runReflection({
			complete: completer(
				JSON.stringify({
					lessons: [
						{
							text: "adding vehicles beyond 15 increased deliveries",
							outcome: { metric: "delivered", before: 1088, after: 1200 },
							evidence: ["delivered 1200 at 18 vehicles"],
						},
					],
				}),
			),
			dataDir: dir,
			facts: FACTS,
			now: NOW,
		});
		const first = readLessons(dir);
		expect(first).toHaveLength(1);
		const victimId = first[0]!.id;

		// 第二局：模型看到现库，并声明取代它
		let seenPrompt = "";
		const r = await runReflection({
			complete: async (p) => {
				seenPrompt = p.user;
				return JSON.stringify({
					lessons: [
						{
							text: "adding vehicles beyond 15 did not increase deliveries",
							outcome: { metric: "delivered", before: 1088, after: 1088 },
							evidence: ["delivered 1088 at 15 and at 21 vehicles"],
							supersedes: [victimId],
						},
					],
				});
			},
			dataDir: dir,
			facts: { ...FACTS, sessionId: "s2" },
			now: NOW + 1000,
		});

		// 反思提示里确实带上了现库（否则 supersedes 不可能产生）
		expect(seenPrompt).toContain(victimId);
		expect(r.lessonsSuperseded).toBe(1);

		const after = readLessons(dir);
		expect(after.find((l) => l.id === victimId)?.supersededBy).toBeTruthy();
		// 注入端：被推翻的那条不再出现（selectLessons 的既有规则）
		const injected = makeLessonProvider(loadMemory(dir, { now: NOW + 2000, inject: true }))();
		expect(injected.join(" ")).not.toContain("adding vehicles beyond 15 increased deliveries");
		expect(injected.join(" ")).toContain("did not increase");
	});

	it("模型给出的是建议句时，一条都不入库（内容级边界在产出处生效）", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "r2-advice-"));
		const r = await runReflection({
			complete: completer(
				JSON.stringify({
					lessons: [
						{ text: "Build a single bus route first", outcome: { metric: "delivered", before: 0, after: 137 }, evidence: ["e"] },
					],
				}),
			),
			dataDir: dir,
			facts: FACTS,
			now: NOW,
		});
		expect(r.lessonsSaved).toBe(0);
		expect(readLessons(dir)).toHaveLength(0);
	});
});
