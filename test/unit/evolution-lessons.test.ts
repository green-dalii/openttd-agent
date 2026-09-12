/**
 * Unit tests — lessons (记忆蒸馏的第一片)。
 *
 * 职责: 锁定 lessons 的**数据契约与三道闸**:证据必须非空、按 id 去重、
 *   注入限量、过期/被覆盖的不得注入。全部是纯函数。
 * 事实来源: SPEC §5.2（机制 1）、§5.3（收敛防抖）、docs/EVOLUTION.md §2.1/§3。
 * 禁止: 在此调用 LLM 或读写磁盘。
 *
 * 为什么这些断言重要:记忆系统的失败模式不是"报错",而是**安静地变蠢**——
 * 把没有事实支撑的臆测固化进库,并在后续每一局里重复注入。一个把错误教训
 * 固化的系统比没有记忆的系统更糟,所以"证据非空"是硬约束而非风格偏好。
 */

import { describe, expect, it } from "vitest";
import {
	LESSON_MAX_AGE_MS,
	MAX_LESSONS_INJECTED,
	dedupeLessons,
	formatForInjection,
	fromReflection,
	lessonId,
	normalizeLessonText,
	selectLessons,
	type Lesson,
} from "../../src/evolution/lessons.js";

const NOW = 1_700_000_000_000;

/** A well-formed lesson; override anything for the case under test. */
function lesson(over: Partial<Lesson> = {}): Lesson {
	return {
		id: lessonId("build near a town with population above 500"),
		text: "build near a town with population above 500",
		kind: "do",
		confidence: 0.6,
		evidence: ["money +12000 between 1952-01 and 1952-06"],
		sourceSessionId: "s1",
		sourceSeed: 7,
		createdAt: NOW - 1000,
		...over,
	};
}

describe("lessons: 规范化与 id", () => {
	it("折叠空白并去掉首尾标点,使同义文本落到同一个 id", () => {
		const a = normalizeLessonText("  Build   near a town.  ");
		const b = normalizeLessonText("build near a town");
		expect(a).toBe(b);
	});

	it("大小写不影响 id(去重必须忽略大小写)", () => {
		expect(lessonId("Build Near A Town")).toBe(lessonId("build near a town"));
	});

	it("id 稳定且随文本变化", () => {
		expect(lessonId("x")).toBe(lessonId("x"));
		expect(lessonId("x")).not.toBe(lessonId("y"));
	});

	it("空/非字符串文本得到空 id(调用方据此拒绝)", () => {
		expect(lessonId("")).toBe("");
		expect(lessonId("   ")).toBe("");
		expect(lessonId(undefined as unknown as string)).toBe("");
	});
});

describe("lessons: fromReflection(反思输出的唯一入口)", () => {
	const ctx = { sessionId: "s1", seed: 7, now: NOW };

	it("接受一条带证据的合法反思", () => {
		const l = fromReflection(
			{ text: "avoid building far from towns", kind: "dont", evidence: ["money fell 40000 in 1953"] },
			ctx,
		);
		expect(l).not.toBeNull();
		expect(l!.kind).toBe("dont");
		expect(l!.sourceSessionId).toBe("s1");
		expect(l!.sourceSeed).toBe(7);
		expect(l!.createdAt).toBe(NOW);
		expect(l!.evidence).toEqual(["money fell 40000 in 1953"]);
		expect(l!.supersededBy).toBeUndefined();
	});

	it("拒绝没有证据的条目(SPEC §5.3:只接受游戏事实佐证)", () => {
		expect(fromReflection({ text: "be smarter", kind: "do", evidence: [] }, ctx)).toBeNull();
		expect(fromReflection({ text: "be smarter", kind: "do" }, ctx)).toBeNull();
		expect(fromReflection({ text: "be smarter", kind: "do", evidence: ["", "  "] }, ctx)).toBeNull();
	});

	it("拒绝空文本或缺失文本", () => {
		expect(fromReflection({ text: "   ", kind: "do", evidence: ["e"] }, ctx)).toBeNull();
		expect(fromReflection({ kind: "do", evidence: ["e"] }, ctx)).toBeNull();
	});

	it("拒绝非法 kind(而不是猜一个)", () => {
		expect(fromReflection({ text: "t", kind: "maybe", evidence: ["e"] }, ctx)).toBeNull();
		expect(fromReflection({ text: "t", evidence: ["e"] }, ctx)).toBeNull();
	});

	it("拒绝非对象/空输入", () => {
		expect(fromReflection(null, ctx)).toBeNull();
		expect(fromReflection(undefined, ctx)).toBeNull();
		expect(fromReflection("a string", ctx)).toBeNull();
	});

	it("confidence 缺省为保守值,并夹在 0..1", () => {
		const noConf = fromReflection({ text: "t", kind: "do", evidence: ["e"] }, ctx);
		expect(noConf!.confidence).toBeGreaterThan(0);
		expect(noConf!.confidence).toBeLessThanOrEqual(0.5);
		const high = fromReflection({ text: "t2", kind: "do", evidence: ["e"], confidence: 9 }, ctx);
		expect(high!.confidence).toBe(1);
		const neg = fromReflection({ text: "t3", kind: "do", evidence: ["e"], confidence: -3 }, ctx);
		expect(neg!.confidence).toBe(0);
		const nan = fromReflection({ text: "t4", kind: "do", evidence: ["e"], confidence: "abc" }, ctx);
		expect(Number.isFinite(nan!.confidence)).toBe(true);
	});

	it("清洗证据:去空白、丢弃空串、去重", () => {
		const l = fromReflection(
			{ text: "t", kind: "do", evidence: [" money +1 ", "money +1", "", "  "] },
			ctx,
		);
		expect(l!.evidence).toEqual(["money +1"]);
	});

	it("缺少 sessionId 时拒绝(来源不可追溯的教训不得入库)", () => {
		expect(fromReflection({ text: "t", kind: "do", evidence: ["e"] }, { sessionId: "", seed: 1, now: NOW })).toBeNull();
	});
});

describe("lessons: dedupeLessons(去重)", () => {
	it("同一文本只保留置信度更高的一条", () => {
		const low = lesson({ confidence: 0.2, createdAt: NOW - 5000 });
		const high = lesson({ confidence: 0.9, createdAt: NOW - 1000 });
		const out = dedupeLessons([low, high]);
		expect(out).toHaveLength(1);
		expect(out[0]!.confidence).toBe(0.9);
	});

	it("置信度相同时保留更新的那条", () => {
		const older = lesson({ confidence: 0.5, createdAt: NOW - 9000, sourceSessionId: "old" });
		const newer = lesson({ confidence: 0.5, createdAt: NOW - 1000, sourceSessionId: "new" });
		expect(dedupeLessons([older, newer])[0]!.sourceSessionId).toBe("new");
	});

	it("不同文本都保留", () => {
		const a = lesson({ text: "a", id: lessonId("a") });
		const b = lesson({ text: "b", id: lessonId("b") });
		expect(dedupeLessons([a, b])).toHaveLength(2);
	});

	it("输入顺序不影响结果(确定性)", () => {
		const a = lesson({ text: "a", id: lessonId("a"), confidence: 0.3 });
		const b = lesson({ text: "b", id: lessonId("b"), confidence: 0.8 });
		const c = lesson({ text: "a", id: lessonId("a"), confidence: 0.7, createdAt: NOW });
		const x = dedupeLessons([a, b, c]).map((l) => `${l.id}:${l.confidence}`);
		const y = dedupeLessons([c, b, a]).map((l) => `${l.id}:${l.confidence}`);
		expect(x).toEqual(y);
	});

	it("容忍空输入与垃圾条目", () => {
		expect(dedupeLessons([])).toEqual([]);
		expect(dedupeLessons([null, undefined, lesson()] as unknown as Lesson[])).toHaveLength(1);
	});
});

describe("lessons: selectLessons(注入前的过滤与限量)", () => {
	it("按置信度降序,同级按时间降序", () => {
		const a = lesson({ text: "a", id: lessonId("a"), confidence: 0.3 });
		const b = lesson({ text: "b", id: lessonId("b"), confidence: 0.9 });
		const c = lesson({ text: "c", id: lessonId("c"), confidence: 0.3, createdAt: NOW });
		const out = selectLessons([a, b, c], { now: NOW });
		expect(out.map((l) => l.text)).toEqual(["b", "c", "a"]);
	});

	it("默认限量生效(不能把整个库塞进 prompt)", () => {
		const many = Array.from({ length: 50 }, (_, i) =>
			lesson({ text: `lesson ${i}`, id: lessonId(`lesson ${i}`) }),
		);
		expect(selectLessons(many, { now: NOW })).toHaveLength(MAX_LESSONS_INJECTED);
	});

	it("显式 limit 生效", () => {
		const many = Array.from({ length: 10 }, (_, i) =>
			lesson({ text: `l${i}`, id: lessonId(`l${i}`) }),
		);
		expect(selectLessons(many, { now: NOW, limit: 3 })).toHaveLength(3);
	});

	it("排除已被覆盖的教训(SPEC:可被后续局覆盖)", () => {
		const live = lesson({ text: "live", id: lessonId("live") });
		const dead = lesson({ text: "dead", id: lessonId("dead"), supersededBy: "something-better" });
		const out = selectLessons([live, dead], { now: NOW });
		expect(out.map((l) => l.text)).toEqual(["live"]);
	});

	it("排除过期教训(默认上限)", () => {
		const fresh = lesson({ text: "fresh", id: lessonId("fresh"), createdAt: NOW - 1000 });
		const stale = lesson({
			text: "stale",
			id: lessonId("stale"),
			createdAt: NOW - LESSON_MAX_AGE_MS - 1,
		});
		expect(selectLessons([fresh, stale], { now: NOW }).map((l) => l.text)).toEqual(["fresh"]);
	});

	it("先 dedupe 再限量(重复项不得挤占注入名额)", () => {
		const dupes = Array.from({ length: 20 }, (_, i) =>
			lesson({ text: "same", id: lessonId("same"), confidence: i / 100 }),
		);
		expect(selectLessons(dupes, { now: NOW })).toHaveLength(1);
	});

	it("容忍空输入", () => {
		expect(selectLessons([], { now: NOW })).toEqual([]);
		expect(selectLessons(undefined as unknown as Lesson[], { now: NOW })).toEqual([]);
	});
});

describe("lessons: formatForInjection", () => {
	it("把 do/dont 渲染成**对过去的陈述**，不是命令", () => {
		// 项目范围（2026-09-12 重申）：这是 RL harness，注入的是"环境反馈"，
		// 不是"策略"。所以绝不能出现 DO / AVOID / 你应该 这类祈使句 ——
		// 那等于把 agent 本该自己从环境里学到的结论直接告诉它。
		const out = formatForInjection([
			lesson({ kind: "do", text: "build near towns" }),
			lesson({ kind: "dont", text: "build far from towns", id: lessonId("x") }),
		]);
		expect(out).toHaveLength(2);
		expect(out[0]).toContain("build near towns");
		expect(out[1]).toContain("build far from towns");
		for (const line of out) {
			// 祈使/建议措辞一律不允许
			expect(line).not.toMatch(/^(DO|AVOID|DON'T)\b/i);
			expect(line).not.toMatch(/\byou should\b|\byou must\b|\bprefer\b|\balways\b|\bnever\b/i);
			// 必须读起来像对发生过什么事的陈述
			expect(line).toMatch(/previously/i);
		}
		// 两类仍然可辨认（否则 agent 分不清成功还是失败）
		expect(out[0]).toMatch(/paid off/i);
		expect(out[1]).toMatch(/did not pay off/i);
	});

	it("每条都是单行(注入进 prompt 的文本不能带换行)", () => {
		const out = formatForInjection([lesson({ text: "line one\nline two" })]);
		expect(out[0]).not.toContain("\n");
	});

	it("空输入得到空数组(调用方据此跳过注入)", () => {
		expect(formatForInjection([])).toEqual([]);
	});
});
