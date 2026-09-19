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
} from "../../src/evolution/reflect.js";
import { createReflectionTools } from "../../src/evolution/reflect-tools.js";

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

	it("要求模型**调用记录工具**（R2b：不再有 JSON 解析层）", () => {
		const p = buildReflectionPrompt(FACTS);
		expect(p.system).toMatch(/record_lesson/);
		expect(p.system).not.toMatch(/json/i);
	});

	it("说明 schema:lessons 需要 text/outcome/evidence（R2：读数取代 do/dont）", () => {
		const p = buildReflectionPrompt(FACTS);
		const all = `${p.system}\n${p.user}`;
		expect(all).toContain("text");
		expect(all).toContain("outcome");
		expect(all).toContain("evidence");
		// 旧的 do/dont 语义必须消失：它把经验塑造成指令（SPEC §10.22 边界）
		expect(all).not.toMatch(/"do"\s*\|\s*"dont"/);
		expect(all).toMatch(/never advice|OBSERVATION/i);
	});

	it("把已记录的库交给反思，并说明可以用 supersedes 取代", () => {
		const p = buildReflectionPrompt({
			...FACTS,
			recorded: [{ id: "abc123", text: "the route delivered 137 units in 300 game days" }],
		});
		expect(p.user).toContain("[abc123]");
		expect(p.user).toContain("the route delivered 137 units in 300 game days");
		expect(p.user).toMatch(/supersedes/);
	});

	it("库为空时说明 nothing yet（反思不该凭空编 id）", () => {
		expect(buildReflectionPrompt(FACTS).user).toMatch(/nothing yet/i);
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

/**
 * R2b（2026-09-18）：反思不再"输出 JSON 由我们解析"，而是**调用记录工具**。
 * 这里测工具契约本身；"拒绝能不能让模型改写"在 evolution-memory.test.ts 里
 * 用 faux provider 走 end-to-end。
 */
describe("reflect-tools: 记录工具就是校验点", () => {
	const ctx = { sessionId: "s1", seed: 7, now: 1234 };
	const call = async (name: string, args: Record<string, unknown>) => {
		const sink = {
			lessons: [] as { id: string }[],
			strategies: [] as { action: string; value: number }[],
			rejections: [] as string[],
		};
		const tool = createReflectionTools(sink as never, ctx).find((t) => t.name === name)!;
		let error: string | null = null;
		try {
			await tool.execute("c1", args as never);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
		return { sink, error };
	};

	it("合法观察被收下", async () => {
		const { sink, error } = await call("record_lesson", {
			text: "the route delivered 137 units in 300 game days",
			outcome: { metric: "delivered", before: 0, after: 137 },
			evidence: ["delivered 137"],
		});
		expect(error).toBeNull();
		expect(sink.lessons).toHaveLength(1);
		expect(sink.rejections).toEqual([]);
	});

	it("建议句**抛错**（pi-agent-core 会把错误作为工具结果回给模型）", async () => {
		const { sink, error } = await call("record_lesson", {
			text: "Build a single bus route first",
			outcome: { metric: "delivered", before: 0, after: 137 },
			evidence: ["e"],
		});
		expect(error).toMatch(/instruction|advice/i);
		expect(sink.lessons).toHaveLength(0);
		// 理由被记下来：拒绝必须是可观测的，不能静默
		expect(sink.rejections).toHaveLength(1);
	});

	it("没有实测读数 → 抛错并说明要什么", async () => {
		const { error } = await call("record_lesson", { text: "x happened", evidence: ["e"] });
		expect(error).toMatch(/outcome is required/i);
	});

	it("没有证据 → 抛错", async () => {
		const { error } = await call("record_lesson", {
			text: "the route delivered 137 units",
			outcome: { metric: "delivered", before: 0, after: 137 },
			evidence: [],
		});
		expect(error).toMatch(/evidence/i);
	});

	it("策略工具要求实测 value 与证据", async () => {
		const bad = await call("record_strategy", { action: "build_bus_route", value: Number.NaN, evidence: ["e"] });
		expect(bad.error).toMatch(/value/i);
		const noEvidence = await call("record_strategy", { action: "build_bus_route", value: 10, evidence: [] });
		expect(noEvidence.error).toMatch(/evidence/i);
		const good = await call("record_strategy", {
			action: "build_bus_route",
			params: { distance: 20 },
			value: 20000,
			evidence: ["money +20000"],
		});
		expect(good.error).toBeNull();
		expect(good.sink.strategies[0]!.value).toBe(20000);
	});

	it("同一条观察在同一个反思里只记一次", async () => {
		const sink = {
			lessons: [] as { id: string }[],
			strategies: [] as { action: string; value: number }[],
			rejections: [] as string[],
		};
		const tool = createReflectionTools(sink as never, ctx).find((t) => t.name === "record_lesson")!;
		const args = {
			text: "the route delivered 137 units",
			outcome: { metric: "delivered", before: 0, after: 137 },
			evidence: ["e"],
		};
		await tool.execute("c1", args as never);
		await tool.execute("c2", args as never);
		expect(sink.lessons).toHaveLength(1);
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

/**
 * 反思必须看到**判据本身**（2026-09-18 对齐检查）。
 *
 * 事故：反思的 outcome 只有 money / vehicles / stations，而 money 被施工花费与
 * 贷款主导（每局都是负收入）；实验却用 `deliveredRun`（运货量）评分。
 * 于是**经验从最混杂的信号里蒸馏**、却用另一个量去评判——记忆学错了对象。
 * 缺读数必须显式写"not measured"，不得印成 0。
 */
describe("反思输入必须包含产出指标与窗口长度", () => {
	const facts = (summary: Record<string, unknown>) => ({
		sessionId: "s1",
		seed: 7,
		summary: {
			money: 100000,
			vehicleCount: 6,
			stationCount: 4,
			decisions: 5,
			toolCalls: 10,
			toolFailures: 0,
			constructionDone: true,
			durationMs: 60000,
			...summary,
		},
		evidence: ["fact"],
	});

	it("有读数时打印交付量与每游戏日速率", () => {
		const { user } = buildReflectionPrompt(facts({ delivered: 300, simulatedDays: 150, episodeStop: "horizon" }));
		expect(user).toMatch(/cargo delivered during the run: 300/);
		expect(user).toMatch(/2\.00\/game day/);
		expect(user).toMatch(/episode ended because: horizon/);
	});

	it("没有读数时说 not measured，而不是印 0", () => {
		const { user } = buildReflectionPrompt(facts({ delivered: null }));
		expect(user).toMatch(/cargo delivered during the run: not measured/);
		expect(user).not.toMatch(/cargo delivered during the run: 0/);
	});
});

/**
 * 契约两半的交叉守卫（2026-09-19 真机事故）。
 *
 * 反思的协议同时存在于**提示词**与**运行时工具**里。R2b 把运行时改成工具调用后，
 * 提示词仍在要求 "Reply with JSON only" → 模型回 JSON、一个工具都不调 →
 * `0 lesson(s) kept`，而日志看起来像"这局没什么可学的"。
 * 这类不一致是**静默**的，所以要用测试把两半钉在一起。
 */
describe("reflect: 提示词与工具契约必须一致", () => {
	const ctx = { sessionId: "s", seed: 1, now: 0 };
	const tools = createReflectionTools({ lessons: [], strategies: [], rejections: [] }, ctx);
	const prompt = buildReflectionPrompt({
		sessionId: "s",
		seed: 1,
		recorded: [],
		summary: {
			money: 0,
			delivered: 0,
			simulatedDays: 30,
			episodeStop: "horizon",
			vehicleCount: 0,
			stationCount: 0,
			decisions: 0,
			toolCalls: 0,
			toolFailures: 0,
			constructionDone: null,
			durationMs: 0,
		},
		evidence: [],
	});

	it("提示词点名的每个工具都真实存在", () => {
		const named = [...prompt.system.matchAll(/\b(record_[a-z_]+)\b/g)].map((m) => m[1]!);
		expect(named.length).toBeGreaterThan(0);
		for (const name of new Set(named)) {
			expect(tools.some((t) => t.name === name), `提示词提到 ${name}，但它不存在`).toBe(true);
		}
	});

	it("不再要求模型用 JSON 回复（那会让它一个工具都不调）", () => {
		expect(prompt.system).not.toMatch(/reply with json/i);
		expect(prompt.system).toMatch(/call/i);
	});

	it("必须告诉模型：被拒会给出理由（否者它无从改写）", () => {
		expect(prompt.system).toMatch(/reject/i);
		expect(prompt.system).toMatch(/tells you the reason|call again/i);
	});
});
