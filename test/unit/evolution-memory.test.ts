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
		kind: "do",
		confidence: 0.6,
		evidence: ["money +12000"],
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
		appendLessons(dir, [lesson({ text: "keep depots close" })]);
		const lines = makeLessonProvider(loadMemory(dir, { now: NOW, inject: true }))();
		expect(lines.join(" ")).toContain("keep depots close");
		// RL harness：只能给"发生过什么"，不能给"该做什么"
		expect(lines[0]).toMatch(/previously/i);
		expect(lines[0]).not.toMatch(/^(do|avoid|don't)\b/i);
	});

	it("默认**不注入**：本局是干净的 RL 环境（项目范围 2026-09-12）", () => {
		// 这是本次审核的核心修正。之前只要库里有内容就会被自动注入，
		// 于是"agent 靠环境学习"悄悄变成了"harness 把结论递给 agent"。
		appendLessons(dir, [lesson({ text: "keep depots close" })]);
		appendStrategies(dir, [card({ enabled: true })]);

		const off = loadMemory(dir, { now: NOW });
		expect(off.lines).toEqual([]);
		expect(off.lessons).toEqual([]);
		expect(off.strategies).toEqual([]);

		// 而且计数必须诚实：没注入就记 0，否则 M3 对照实验的自变量是假的
		const counts = memoryCounts(off);
		expect(counts.lessonsInjected).toBe(0);
		expect(counts.strategiesInjected).toBe(0);

		// 显式 opt-in 时才装载
		expect(loadMemory(dir, { now: NOW, inject: true }).lines.length).toBeGreaterThan(0);
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
			{ text: "build near towns", kind: "do", evidence: ["money +12000"], confidence: 0.7 },
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
			complete: completer(JSON.stringify({ lessons: [{ text: "be better", kind: "do" }] })),
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
				JSON.stringify({ lessons: [{ text: "avoid long routes", kind: "dont", evidence: ["money -1"] }] }),
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
		appendLessons(dir, [lesson({ text: "keep depots close to towns" })]);
		const mem = loadMemory(dir, { now: NOW, inject: true });
		const transform = pruningTransformContext({
			keepRecent: 5,
			lessonsProvider: makeLessonProvider(mem),
		});
		const out = await transform([
			{ role: "user", content: "do something" } as never,
		]);
		const text = JSON.stringify(out);
		expect(text).toContain("keep depots close to towns");
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
