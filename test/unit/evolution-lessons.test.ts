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
	applySupersessions,
	formatForInjection,
	fromReflection,
	isImperative,
	lessonId,
	normalizeLessonText,
	selectLessons,
	type Lesson,
} from "../../src/evolution/lessons.js";

const NOW = 1_700_000_000_000;

/** A well-formed lesson; override anything for the case under test. */
function lesson(over: Partial<Lesson> = {}): Lesson {
	return {
		id: lessonId("delivered cargo rose after the second town was connected"),
		text: "delivered cargo rose after the second town was connected",
		outcome: { metric: "delivered", before: 420, after: 1088 },
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
	const ok = (over: Record<string, unknown> = {}) => ({
		text: "Adding vehicles beyond 15 did not increase deliveries",
		outcome: { metric: "delivered", before: 1088, after: 1088 },
		evidence: ["delivered 1088 at 15 vehicles, 1088 at 18 vehicles"],
		...over,
	});

	it("接受一条带证据、带实测读数的观察", () => {
		const l = fromReflection(ok(), ctx)!;
		expect(l).not.toBeNull();
		expect(l.outcome).toEqual({ metric: "delivered", before: 1088, after: 1088 });
		expect(l.sourceSessionId).toBe("s1");
		expect(l.sourceSeed).toBe(7);
		expect(l.createdAt).toBe(NOW);
		expect(l.evidence).toEqual(["delivered 1088 at 15 vehicles, 1088 at 18 vehicles"]);
		expect(l.supersededBy).toBeUndefined();
	});

	it("拒绝**建议/祈使句**（SPEC §10.22 边界；2026-09-18 起是内容级检查）", () => {
		// 旧契约把这些当合法 lesson（kind:do/dont）入库并注入 —— 这正是 R2 要修的
		expect(fromReflection(ok({ text: "Build a single bus route first" }), ctx)).toBeNull();
		expect(fromReflection(ok({ text: "expand the fleet to around 16 vehicles" }), ctx)).toBeNull();
		expect(fromReflection(ok({ text: "DO: check the station first" }), ctx)).toBeNull();
		expect(fromReflection(ok({ text: "avoid building far from towns" }), ctx)).toBeNull();
	});

	it("拒绝没有实测读数(outcome)的条目", () => {
		expect(fromReflection({ text: "x happened", evidence: ["e"] }, ctx)).toBeNull();
	});

	it("拒绝把缺失值硬转成 0 的 outcome", () => {
		expect(fromReflection(ok({ outcome: { metric: "delivered" } }), ctx)).toBeNull();
		expect(fromReflection(ok({ outcome: { metric: "delivered", before: null, after: 3 } }), ctx)).toBeNull();
		expect(fromReflection(ok({ outcome: { metric: "delivered", before: 1, after: "abc" } }), ctx)).toBeNull();
	});

	it("拒绝未知 metric（而不是猜一个）", () => {
		expect(fromReflection(ok({ outcome: { metric: "vibes", before: 1, after: 2 } }), ctx)).toBeNull();
	});

	it("拒绝没有证据的条目(SPEC §5.3:只接受游戏事实佐证)", () => {
		expect(fromReflection(ok({ evidence: [] }), ctx)).toBeNull();
		expect(fromReflection(ok({ evidence: undefined }), ctx)).toBeNull();
		expect(fromReflection(ok({ evidence: ["", "  "] }), ctx)).toBeNull();
	});

	it("拒绝空文本或缺失文本", () => {
		expect(fromReflection(ok({ text: "   " }), ctx)).toBeNull();
		expect(fromReflection(ok({ text: undefined }), ctx)).toBeNull();
	});

	it("拒绝非对象/空输入", () => {
		expect(fromReflection(null, ctx)).toBeNull();
		expect(fromReflection(undefined, ctx)).toBeNull();
		expect(fromReflection("a string", ctx)).toBeNull();
	});

	it("confidence 缺省为保守值,并夹在 0..1", () => {
		expect(fromReflection(ok(), ctx)!.confidence).toBeGreaterThan(0);
		expect(fromReflection(ok(), ctx)!.confidence).toBeLessThanOrEqual(0.5);
		expect(fromReflection(ok({ confidence: 9 }), ctx)!.confidence).toBe(1);
		expect(fromReflection(ok({ confidence: -3 }), ctx)!.confidence).toBe(0);
		expect(Number.isFinite(fromReflection(ok({ confidence: "abc" }), ctx)!.confidence)).toBe(true);
	});

	it("清洗证据:去空白、丢弃空串、去重", () => {
		const l = fromReflection(ok({ evidence: [" delivered 1088 ", "delivered 1088", "", "  "] }), ctx)!;
		expect(l.evidence).toEqual(["delivered 1088"]);
	});

	it("缺少 sessionId 时拒绝(来源不可追溯的教训不得入库)", () => {
		expect(fromReflection(ok(), { sessionId: "", seed: 1, now: NOW })).toBeNull();
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

describe("lessons: formatForInjection（内容级，不是包装级）", () => {
	/**
	 * 事故（2026-09-18，MEMORY D26）：注入行曾是
	 * `Previously an action like this paid off: <text>`，而守卫断言 `^DO\b`
	 * —— **前缀在前，那条正则永远不可能匹配**。真机库里的祈使句
	 * （"Build a single bus route first…"、"expand the fleet to around 16 vehicles"）
	 * 全都通过了守卫，包装还替它们断言了从未验证的因果（"paid off"）。
	 * 守卫必须作用在**被注入的那段文本本身**。
	 */
	it("注入的是记录与读数，不是指令，也不替模型断言因果", () => {
		const out = formatForInjection([lesson()]);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("delivered cargo rose after the second town was connected");
		expect(out[0]).toMatch(/delivered.*420.*1088/s);
		expect(out[0]).not.toMatch(/paid off|should|must/i);
		expect(out[0]).not.toMatch(/^(DO|AVOID|DON'T)\b/i);
	});

	it("历史库里的祈使句即使混进来也不得被注入（纵深防御）", () => {
		expect(formatForInjection([lesson({ id: lessonId("x"), text: "Build a single bus route first" })])).toHaveLength(0);
	});
});

/**
 * 内容级守卫（SPEC §10.22 边界：框架给事实，不给策略）。
 *
 * 必须在**产出处**生效，且理由要让模型看得见（工具抛错 → 模型改写），
 * 而不是事后静默丢弃。
 */
describe("lessons: isImperative 内容检测", () => {
	const advice = [
		"Build a single bus route first",
		"DO: check the station before adding vehicles",
		"AVOID building routes longer than 100 tiles",
		"expand the fleet to around 16 vehicles",
		"You should add vehicles when queues grow",
		"Add a second route to grow income",
		"Never send the same command twice",
		"Prefer one solid route over many half-built ones",
		"Consider adding a second route",
		"Make sure to unpause before issuing commands",
		"Don't build long routes",
		"It is better to start with one route",
	];
	const observations = [
		"Requesting 15 vehicles added 5 of them",
		"The route from town 9 to town 12 delivered 137 units over 300 game days",
		"Adding vehicles beyond 15 did not increase deliveries in the recorded runs",
		"Construction of a 239-tile route did not finish inside a 150 game-day horizon",
		"Delivered cargo stayed at 0 while the executor was still building the road",
	];
	it.each(advice)("拒绝建议/祈使句：%s", (t) => {
		expect(isImperative(t)).toBe(true);
	});
	it.each(observations)("接受对已发生事实的陈述：%s", (t) => {
		expect(isImperative(t)).toBe(false);
	});
});

describe("lessons: supersedes 接线（经验可以被推翻）", () => {
	it("后一条观察可以作废前一条，被作废的不再注入", () => {
		const a = lesson({ id: "a", text: "the first route delivered 0" });
		const b = lesson({
			id: "b",
			text: "the first route delivered 137 after the depot was rebuilt",
			supersedes: ["a"],
		});
		const applied = applySupersessions([a], [b]);
		expect(applied.find((l) => l.id === "a")?.supersededBy).toBe("b");
		expect(selectLessons(applied).map((l) => l.id)).not.toContain("a");
	});

	it("不能作废自己，也不能作废不存在的 id", () => {
		const b = lesson({ id: "b", text: "a route of 75 tiles was still building at the horizon", supersedes: ["b", "nope"] });
		const applied = applySupersessions([], [b]);
		expect(applied.map((l) => l.id)).toEqual(["b"]);
		expect(applied[0]?.supersededBy).toBeUndefined();
	});
});

describe("lessons: dedupeLessons 必须让作废胜出", () => {
	/**
	 * 作废是以**追加**形式表达的（同 id 再写一条带 `supersededBy` 的记录），
	 * 两条的 confidence 与 createdAt 完全相同。若 dedupe 只按"更可信/更新"择优，
	 * 先到的原条会赢 —— 作废被静默丢弃，记忆又变回只增不减（R2 实测踩到）。
	 */
	it("同 id 时，带 supersededBy 的那条胜出（即使先到的没有）", () => {
		const plain = lesson({ id: "a", confidence: 0.9, createdAt: NOW });
		const tomb = lesson({ id: "a", confidence: 0.9, createdAt: NOW, supersededBy: "b" });
		expect(dedupeLessons([plain, tomb])[0]!.supersededBy).toBe("b");
		// 反序输入也必须成立（不能依赖数组顺序）
		expect(dedupeLessons([tomb, plain])[0]!.supersededBy).toBe("b");
	});

	it("都没作废时，仍然是更可信/更新者胜", () => {
		const low = lesson({ id: "a", confidence: 0.2, createdAt: NOW - 5000 });
		const high = lesson({ id: "a", confidence: 0.9, createdAt: NOW - 1000 });
		expect(dedupeLessons([low, high])[0]!.confidence).toBe(0.9);
	});
});
