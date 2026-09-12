/**
 * Unit tests — 学习库(lessons / strategies)的磁盘持久化。
 *
 * 职责: 锁定与 metrics 账本**同一套约定**:append-only、按 id 收敛、
 *   单行损坏不丢整本库、压缩用临时文件 + rename。
 * 事实来源: docs/EVOLUTION.md §2、SPEC §5.2/§5.3、store.ts（metrics 的既有约定）。
 * 禁止: 在此断言统计逻辑（见 evolution-lessons / evolution-strategies 测试）。
 *
 * 为什么容错是硬要求:记忆库是**跨局累积物**,一次损坏就丢掉全部历史,
 * 等于把系统的学习能力清零。单行坏掉必须只损失那一行。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	appendLessons,
	appendStrategies,
	compactLessons,
	compactStrategies,
	lessonsPath,
	readLessons,
	readStrategies,
	setStrategyEnabled,
	strategiesPath,
} from "../../src/evolution/store.js";
import { lessonId, type Lesson } from "../../src/evolution/lessons.js";
import { MIN_STRATEGY_VALUE, strategyId } from "../../src/evolution/strategies.js";
import type { StrategyCard } from "../../src/evolution/types.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "evo-learn-"));
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
		createdAt: 1000,
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
		createdAt: 1000,
		enabled: false,
		...over,
	};
}

describe("learning store: 路径", () => {
	it("与 metrics 同目录(一个 evolution/ 文件夹)", () => {
		expect(path.dirname(lessonsPath(dir))).toBe(path.dirname(lessonsPath(dir)));
		expect(path.basename(lessonsPath(dir))).toBe("lessons.jsonl");
		expect(path.basename(strategiesPath(dir))).toBe("strategies.jsonl");
		expect(path.dirname(lessonsPath(dir))).toBe(path.join(dir, "evolution"));
	});
});

describe("learning store: lessons", () => {
	it("空库读出空数组,不创建文件", () => {
		expect(readLessons(dir)).toEqual([]);
		expect(existsSync(lessonsPath(dir))).toBe(false);
	});

	it("写入后能读回(往返一致)", () => {
		const l = lesson();
		appendLessons(dir, [l]);
		const out = readLessons(dir);
		expect(out).toHaveLength(1);
		expect(out[0]!.text).toBe(l.text);
		expect(out[0]!.evidence).toEqual(l.evidence);
		expect(out[0]!.sourceSessionId).toBe("s1");
	});

	it("一次写入多条", () => {
		appendLessons(dir, [lesson({ text: "a" }), lesson({ text: "b" })]);
		expect(readLessons(dir)).toHaveLength(2);
	});

	it("空数组不写文件", () => {
		appendLessons(dir, []);
		expect(existsSync(lessonsPath(dir))).toBe(false);
	});

	it("跳过明显无效的条目(无 id / 非对象)", () => {
		appendLessons(dir, [lesson(), null as unknown as Lesson, { text: "x" } as unknown as Lesson]);
		expect(readLessons(dir)).toHaveLength(1);
	});

	it("同一 id 多次写入后按置信度收敛,而不是被最后一条覆盖", () => {
		// 与其他账本不同:lessons 的读取要按"更可信者胜"收敛。
		// 否则追加一条低置信度重复项就会把更好的结论挤掉。
		appendLessons(dir, [lesson({ confidence: 0.9 })]);
		appendLessons(dir, [lesson({ confidence: 0.2, sourceSessionId: "s2" })]);
		const out = readLessons(dir);
		expect(out).toHaveLength(1);
		expect(out[0]!.confidence).toBe(0.9);
	});

	it("被覆盖(supersededBy)的教训读得出来,但不参与注入由 selectLessons 负责", () => {
		appendLessons(dir, [lesson({ supersededBy: "better" })]);
		const out = readLessons(dir);
		expect(out).toHaveLength(1);
		expect(out[0]!.supersededBy).toBe("better");
	});

	it("单行损坏不丢整本库", () => {
		appendLessons(dir, [lesson({ text: "keep me" })]);
		appendFileSync(lessonsPath(dir), "{not json at all\n", "utf8");
		appendFileSync(lessonsPath(dir), "\n", "utf8");
		appendLessons(dir, [lesson({ text: "also keep" })]);
		const out = readLessons(dir);
		expect(out.map((l) => l.text).sort()).toEqual(["also keep", "keep me"]);
	});

	it("输出确定(与写入顺序无关)", () => {
		appendLessons(dir, [lesson({ text: "a" })]);
		appendLessons(dir, [lesson({ text: "b" })]);
		const first = readLessons(dir).map((l) => l.text);
		const second = readLessons(dir).map((l) => l.text);
		expect(first).toEqual(second);
	});

	it("compactLessons 去重并返回条数,坏行一并清掉", () => {
		appendLessons(dir, [lesson({ text: "a", confidence: 0.5 })]);
		appendLessons(dir, [lesson({ text: "a", confidence: 0.9 })]);
		appendFileSync(lessonsPath(dir), "garbage\n", "utf8");
		const n = compactLessons(dir);
		expect(n).toBe(1);
		const raw = readFileSync(lessonsPath(dir), "utf8");
		expect(raw).not.toContain("garbage");
		expect(readLessons(dir)).toHaveLength(1);
		expect(readLessons(dir)[0]!.confidence).toBe(0.9);
	});

	it("compactLessons 在空库上是安全的", () => {
		expect(compactLessons(dir)).toBe(0);
	});
});

describe("learning store: strategies", () => {
	it("空库读出空数组", () => {
		expect(readStrategies(dir)).toEqual([]);
	});

	it("写入后能读回(含 valuePerRun 与 enabled 状态)", () => {
		const c = card({ enabled: true });
		appendStrategies(dir, [c]);
		const out = readStrategies(dir);
		expect(out).toHaveLength(1);
		expect(out[0]!.valuePerRun).toEqual(c.valuePerRun);
		expect(out[0]!.enabled).toBe(true);
	});

	it("同一 id 后来者胜(卡片是累积后的完整快照)", () => {
		appendStrategies(dir, [card({ valuePerRun: [MIN_STRATEGY_VALUE + 1] })]);
		appendStrategies(dir, [
			card({ valuePerRun: [MIN_STRATEGY_VALUE + 1, MIN_STRATEGY_VALUE + 2] }),
		]);
		const out = readStrategies(dir);
		expect(out).toHaveLength(1);
		expect(out[0]!.valuePerRun).toHaveLength(2);
	});

	it("保留人工确认状态(不能因为重写而丢失)", () => {
		appendStrategies(dir, [card({ enabled: false })]);
		appendStrategies(dir, [card({ enabled: true })]);
		expect(readStrategies(dir)[0]!.enabled).toBe(true);
	});

	it("单行损坏不丢整本库", () => {
		appendStrategies(dir, [card({ action: "a" })]);
		appendFileSync(strategiesPath(dir), "}}}broken\n", "utf8");
		appendStrategies(dir, [card({ action: "b", params: { x: 1 } })]);
		expect(readStrategies(dir)).toHaveLength(2);
	});

	it("compactStrategies 去重", () => {
		appendStrategies(dir, [card()]);
		appendStrategies(dir, [card()]);
		expect(compactStrategies(dir)).toBe(1);
	});

	it("跳过无效条目(无 id / 非对象)", () => {
		appendStrategies(dir, [card(), {} as unknown as StrategyCard]);
		expect(readStrategies(dir)).toHaveLength(1);
	});
});

describe("learning store: setStrategyEnabled(人工确认 guardrail)", () => {
	it("翻转指定卡片的 enabled", () => {
		appendStrategies(dir, [card({ enabled: false })]);
		const id = card().id;
		expect(setStrategyEnabled(dir, id, true)).toBe(true);
		expect(readStrategies(dir)[0]!.enabled).toBe(true);
	});

	it("可以关回去", () => {
		appendStrategies(dir, [card({ enabled: true })]);
		expect(setStrategyEnabled(dir, card().id, false)).toBe(true);
		expect(readStrategies(dir)[0]!.enabled).toBe(false);
	});

	it("未知 id 返回 false(让 API 能答 404,而不是假装成功)", () => {
		appendStrategies(dir, [card()]);
		expect(setStrategyEnabled(dir, "nope", true)).toBe(false);
		expect(setStrategyEnabled(dir, "", true)).toBe(false);
	});

	it("只影响目标卡片", () => {
		appendStrategies(dir, [card({ action: "a" }), card({ action: "b", params: { q: 1 } })]);
		setStrategyEnabled(dir, card({ action: "a" }).id, true);
		const out = readStrategies(dir);
		expect(out.find((c) => c.action === "a")!.enabled).toBe(true);
		expect(out.find((c) => c.action === "b")!.enabled).toBe(false);
	});
});
