/**
 * Unit tests — 局终反思(prompt 构造 + 响应解析)。
 *
 * 职责: 锁定两件事——(1) prompt 必须**显式禁止臆测因果**(SPEC §5.3);
 *   (2) 响应解析必须**强校验**:模型吐出来的东西未经校验不得入库。
 * 事实来源: SPEC §5.1（反思）、§5.3（禁止臆测因果、只接受游戏事实佐证）,
 *   docs/EVOLUTION.md §5。
 * 禁止: 在此发网络请求(纯函数;调用 LLM 的部分不在本文件断言)。
 *
 * 为什么解析要这么严:反思是唯一让 LLM 参与"总结"的环节,也是**幻觉进入长期记忆**
 * 的唯一入口。模型很擅长产出听起来合理、但游戏里根本没发生过的因果解释;
 * 一旦入库,它会在之后每一局被重复注入。所以宁可丢掉整条,不可放行。
 */

import { describe, expect, it } from "vitest";
import {
	buildReflectionEvidence,
	buildReflectionPrompt,
	isSpeculative,
	parseReflection,
	reflectToLessons,
	reflectToStrategies,
} from "../../src/evolution/reflect.js";

const FACTS = {
	sessionId: "s1",
	seed: 7,
	summary: {
		money: -125000,
		vehicleCount: 4,
		stationCount: 2,
		decisions: 9,
		toolCalls: 6,
		toolFailures: 2,
		constructionDone: false,
		durationMs: 900000,
	},
	evidence: [
		"1950-01: built bus route TownA->TownB, result ok",
		"1951-06: money -40000 over 6 months",
		"1952-03: build_truck_route failed: no depot",
	],
};

describe("reflect: buildReflectionPrompt", () => {
	it("包含禁止臆测因果的硬性要求(SPEC §5.3)", () => {
		const p = buildReflectionPrompt(FACTS);
		const all = `${p.system}\n${p.user}`;
		expect(all).toMatch(/do not (speculate|guess)|禁止|不得臆测|只接受/i);
		expect(all).toMatch(/evidence|事实|佐证/i);
	});

	it("要求每条教训引用游戏事实", () => {
		const p = buildReflectionPrompt(FACTS);
		expect(`${p.system}\n${p.user}`).toMatch(/evidence/i);
	});

	it("把该局的结构化事实喂进去(模型不该被要求回忆)", () => {
		const p = buildReflectionPrompt(FACTS);
		for (const e of FACTS.evidence) expect(p.user).toContain(e);
	});

	it("把关键指标喂进去", () => {
		const p = buildReflectionPrompt(FACTS);
		expect(p.user).toContain("125000");
		expect(p.user).toContain("7");
	});

	it("明确要求 JSON 输出(否则解析层只能靠猜)", () => {
		const p = buildReflectionPrompt(FACTS);
		expect(`${p.system}\n${p.user}`).toMatch(/json/i);
	});

	it("说明 schema:lessons 需要 text/kind/evidence", () => {
		const p = buildReflectionPrompt(FACTS);
		const all = `${p.system}\n${p.user}`;
		expect(all).toContain("text");
		expect(all).toContain("kind");
		expect(all).toMatch(/"do"|"dont"/);
	});

	it("容忍没有证据的局(不抛异常,并如实说明)", () => {
		const p = buildReflectionPrompt({ ...FACTS, evidence: [] });
		expect(p.user).toBeTruthy();
		expect(p.user).toMatch(/no (structured )?evidence|没有|无/i);
	});
});

describe("reflect: isSpeculative(臆测检测)", () => {
	it("抓出英文的推测性措辞", () => {
		for (const t of [
			"probably the route was too long",
			"this maybe happened because of the loan",
			"perhaps we should have waited",
			"it might have been the terrain",
			"I think the town was too small",
			"seems like the AI was slow",
		]) {
			expect(isSpeculative(t), t).toBe(true);
		}
	});

	it("抓出中文的推测性措辞", () => {
		for (const t of ["可能因为路线太长", "大概是贷款导致的", "也许应该等待", "似乎是地形问题"]) {
			expect(isSpeculative(t), t).toBe(true);
		}
	});

	it("放行陈述游戏事实的句子", () => {
		for (const t of [
			"money fell 40000 between 1951-01 and 1951-06",
			"build_truck_route failed with 'no depot' in 1952-03",
			"income stayed negative for 8 months",
			"现金在 1951 年下降了 40000",
		]) {
			expect(isSpeculative(t), t).toBe(false);
		}
	});

	it("不把普通词汇误判(如 'may' 作为月份/公司名片段)", () => {
		// 宁可漏判也不要误杀合法事实——本函数只拦教科书式的推测措辞。
		expect(isSpeculative("1950-05: monthly income -1200")).toBe(false);
		expect(isSpeculative("Maytown station built in 1951")).toBe(false);
	});

	it("非字符串输入不抛异常", () => {
		expect(isSpeculative(undefined)).toBe(false);
		expect(isSpeculative(null)).toBe(false);
		expect(isSpeculative(42)).toBe(false);
	});
});

describe("reflect: parseReflection(响应解析)", () => {
	const good = {
		lessons: [
			{ text: "build close to towns", kind: "do", evidence: ["money +12000 in 1951"] },
		],
		strategies: [
			{ action: "build_bus_route", params: { distance: 20 }, value: 9000, evidence: ["money +9000"] },
		],
	};

	it("解析裸 JSON", () => {
		const r = parseReflection(JSON.stringify(good));
		expect(r.lessons).toHaveLength(1);
		expect(r.strategies).toHaveLength(1);
	});

	it("解析 markdown 代码块包裹的 JSON(模型最常这么输出)", () => {
		const r = parseReflection("Here is my analysis:\n```json\n" + JSON.stringify(good) + "\n```\nDone.");
		expect(r.lessons).toHaveLength(1);
	});

	it("解析前后带散文的 JSON", () => {
		const r = parseReflection(`Sure. ${JSON.stringify(good)} Hope this helps.`);
		expect(r.lessons).toHaveLength(1);
	});

	it("缺失的数组字段视为空,不抛异常", () => {
		const r = parseReflection(JSON.stringify({ lessons: [] }));
		expect(r.lessons).toEqual([]);
		expect(r.strategies).toEqual([]);
	});

	it("垃圾输入得到空结果(而不是异常)", () => {
		expect(parseReflection("no json here").lessons).toEqual([]);
		expect(parseReflection("").lessons).toEqual([]);
		expect(parseReflection("{ broken json").lessons).toEqual([]);
		expect(parseReflection(undefined as unknown as string).lessons).toEqual([]);
	});

	it("非对象/数组型 JSON 顶层得到空结果", () => {
		expect(parseReflection("[1,2,3]").lessons).toEqual([]);
		expect(parseReflection("42").lessons).toEqual([]);
		expect(parseReflection("null").lessons).toEqual([]);
	});

	it("数组里的非对象元素被丢弃", () => {
		const r = parseReflection(JSON.stringify({ lessons: [null, "x", 1, good.lessons[0]] }));
		expect(r.lessons).toHaveLength(1);
	});
});

describe("reflect: reflectToLessons(端到端校验)", () => {
	const ctx = { sessionId: "s1", seed: 7, now: 1234 };

	it("产出通过校验的 lessons", () => {
		const out = reflectToLessons(
			JSON.stringify({ lessons: [{ text: "go near towns", kind: "do", evidence: ["money +1"] }] }),
			ctx,
		);
		expect(out).toHaveLength(1);
		expect(out[0]!.sourceSessionId).toBe("s1");
	});

	it("丢掉没有证据的条目", () => {
		const out = reflectToLessons(
			JSON.stringify({
				lessons: [
					{ text: "be better", kind: "do" },
					{ text: "go near towns", kind: "do", evidence: ["money +1"] },
				],
			}),
			ctx,
		);
		expect(out.map((l) => l.text)).toEqual(["go near towns"]);
	});

	it("丢掉臆测性的条目(prompt 说了不许,代码也要拦)", () => {
		const out = reflectToLessons(
			JSON.stringify({
				lessons: [
					{ text: "probably the route was too long", kind: "dont", evidence: ["money -1"] },
					{ text: "money fell 40000 in 1953", kind: "dont", evidence: ["money -40000"] },
				],
			}),
			ctx,
		);
		expect(out.map((l) => l.text)).toEqual(["money fell 40000 in 1953"]);
	});

	it("同一响应里重复的教训被去重", () => {
		const out = reflectToLessons(
			JSON.stringify({
				lessons: [
					{ text: "Go near towns", kind: "do", evidence: ["e1"] },
					{ text: "go near towns", kind: "do", evidence: ["e2"] },
				],
			}),
			ctx,
		);
		expect(out).toHaveLength(1);
	});

	it("整段垃圾响应得到空数组", () => {
		expect(reflectToLessons("total nonsense", ctx)).toEqual([]);
	});
});

describe("reflect: reflectToStrategies", () => {
	it("产出可入库的采样(含 action/params/value/evidence/sessionId)", () => {
		const out = reflectToStrategies(
			JSON.stringify({
				strategies: [
					{ action: "build_bus_route", params: { distance: 20 }, value: 9000, evidence: ["money +9000"] },
				],
			}),
			{ sessionId: "s1", now: 500 },
		);
		expect(out).toHaveLength(1);
		expect(out[0]!.action).toBe("build_bus_route");
		expect(out[0]!.value).toBe(9000);
		expect(out[0]!.sessionId).toBe("s1");
	});

	it("丢掉没有证据或没有 action 的候选", () => {
		const out = reflectToStrategies(
			JSON.stringify({
				strategies: [
					{ action: "build_bus_route", params: {}, value: 9000 },
					{ params: {}, value: 9000, evidence: ["e"] },
					{ action: "build_bus_route", params: {}, value: Number.NaN, evidence: ["e"] },
				],
			}),
			{ sessionId: "s1", now: 500 },
		);
		expect(out).toEqual([]);
	});

	it("params 非对象时归一为空对象", () => {
		const out = reflectToStrategies(
			JSON.stringify({
				strategies: [{ action: "a", params: "nonsense", value: 10, evidence: ["e"] }],
			}),
			{ sessionId: "s1", now: 500 },
		);
		expect(out[0]!.params).toEqual({});
	});

	it("垃圾响应得到空数组", () => {
		expect(reflectToStrategies("nope", { sessionId: "s1", now: 1 })).toEqual([]);
	});
});

describe("reflect: buildReflectionEvidence(喂给模型的事实)", () => {
	it("把阶段总结渲染成带时间的事实行", () => {
		const out = buildReflectionEvidence({
			stages: [{ gameDate: "1950-01-01", turn: 1, note: "planned bus route" }],
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("1950-01-01");
		expect(out[0]).toContain("planned bus route");
	});

	it("把动作结果渲染成成功/失败事实", () => {
		const out = buildReflectionEvidence({
			actions: [
				{ tool: "build_bus_route", ok: true, summary: "built 12 tiles" },
				{ tool: "build_truck_route", ok: false, summary: "no depot" },
			],
		});
		expect(out).toHaveLength(2);
		expect(out[0]).toContain("build_bus_route");
		expect(out[0]).toContain("ok");
		expect(out[1]).toContain("failed");
		expect(out[1]).toContain("no depot");
	});

	it("中文/多行 note 被压成单行(注入的是事实行,不是段落)", () => {
		const out = buildReflectionEvidence({
			stages: [{ gameDate: "1951-01-01", turn: 2, note: "built road\nand depot" }],
		});
		expect(out[0]).not.toContain("\n");
	});

	it("跳过没有内容的条目(空的 note / 没有 tool)", () => {
		const out = buildReflectionEvidence({
			stages: [{ gameDate: "1950-01-01", turn: 1, note: "   " }, { gameDate: "x", turn: 2 }],
			actions: [{ ok: true, summary: "no tool name" }],
		});
		expect(out).toEqual([]);
	});

	it("容忍空输入与垃圾输入(不抛异常)", () => {
		expect(buildReflectionEvidence({})).toEqual([]);
		expect(buildReflectionEvidence({ stages: [], actions: [] })).toEqual([]);
		expect(buildReflectionEvidence({ stages: [null, undefined] as never[] })).toEqual([]);
	});

	it("只描述发生了什么,不加入解释(SPEC §5.3)", () => {
		const out = buildReflectionEvidence({
			actions: [{ tool: "build_bus_route", ok: true, summary: "built 12 tiles" }],
		});
		for (const line of out) expect(isSpeculative(line)).toBe(false);
	});
});
