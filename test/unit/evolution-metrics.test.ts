/**
 * Unit tests — evolution metrics (the cross-game ledger).
 *
 * 职责: 锁定 SPEC §5.2 #3「每局结构化指标 JSONL + 同 seed 对照实验」的**纯计算**部分。
 *
 * 为什么先做这个（SPEC 对齐）: SPEC §5.2 的三机制（lessons 蒸馏 / 策略库 / metrics）
 *   里，**metrics 是前提** —— 没有跨局度量就无法判断"注入 lessons 到底有没有用"，
 *   反思和蒸馏都会变成自我感觉良好。所以这一层先落地。
 *
 * 最关键的设计点: 每条指标必须记录**本局是否注入过 lessons/策略**（SPEC §5.2 #1/#2 的自变量）。
 *   不记录自变量，所谓"对照实验"就只是把两个数并排放着。
 *
 * 事实来源: SPEC §5.2（三机制）、§5.3（收敛防抖/阈值）、§7 #4（跨局对比图）。
 * 禁止: 在此做 IO；不要在 metrics 里推断因果（SPEC §5.3 明确禁止臆测因果）。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	compareArms,
	toGameMetric,
	summarise,
	groupBySeed,
	MIN_LESSON_SAMPLE,
	degradationStats,
	deliveredOutcome,
	formatMetricStat,
	horizonIsComparable,
	MIN_COMPARABLE_HORIZON_DAYS,
	metricStat,
	type GameMetric,
} from "../../src/evolution/metrics.js";
import type { SessionMeta } from "../../src/agent/session-store.js";

/** A finished session meta, shaped like the real one. */
function meta(over: Partial<SessionMeta> = {}): SessionMeta {
	return {
		id: "s1",
		mode: "agent",
		status: "completed",
		startedAt: 1000,
		endedAt: 61_000,
		seed: 7,
		startYear: 1950,
		mapSize: [256, 256],
		serverName: "openttd-agent",
		companyName: "AI",
		llm: { providerId: "custom", model: "m", api: "openai-completions", kind: "real" },
		appVersion: "0.6.0",
		outcome: { constructionDone: true, money: "299203", vehicles: 4, stations: 3 },
		totals: {
			decisions: 5,
			messages: 6,
			toolCalls: 9,
			toolFailures: 1,
			events: 120,
			usage: {
				input: 3000,
				output: 60,
				reasoning: 15,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3075,
				costTotal: 0.42,
			},
		},
		checkpoints: [],
		...over,
	} as SessionMeta;
}

describe("toGameMetric", () => {
	it("projects the fields a cross-game comparison needs", () => {
		const m = toGameMetric(meta());
		expect(m.id).toBe("s1");
		expect(m.seed).toBe(7);
		expect(m.money).toBe(299203); // string on the wire -> number here
		expect(m.vehicles).toBe(4);
		expect(m.stations).toBe(3);
		expect(m.constructionDone).toBe(true);
		expect(m.decisions).toBe(5);
		expect(m.totalTokens).toBe(3075);
		expect(m.costTotal).toBeCloseTo(0.42, 6);
		expect(m.durationMs).toBe(60_000);
	});

	it("records the experiment's independent variable", () => {
		// Without this, "with vs without lessons" is just two numbers side by side.
		const m = toGameMetric(meta(), { lessonsInjected: 3, strategiesInjected: 1 });
		expect(m.memory).toEqual({ lessonsInjected: 3, strategiesInjected: 1, routeFactsInjected: 0 });
	});

	it("defaults to no injection when nothing was injected", () => {
		const m = toGameMetric(meta());
		expect(m.memory).toEqual({ lessonsInjected: 0, strategiesInjected: 0, routeFactsInjected: 0 });
	});

	it("keeps the brain identity so faux runs cannot be mistaken for real ones", () => {
		// A scripted demo must never be counted as evidence about model quality.
		const m = toGameMetric(meta({ llm: { providerId: "", model: "", api: "", kind: "faux" } }));
		expect(m.llmKind).toBe("faux");
		expect(m.llmModel).toBe("");
	});

	it("keeps the app version so a regression can be traced to a build", () => {
		expect(toGameMetric(meta()).appVersion).toBe("0.6.0");
	});

	it("handles a run that never finished", () => {
		// A killed run has no outcome recorded at all - that is the case under test,
		// so the fixture must drop the default outcome too.
		const m = toGameMetric(meta({ status: "interrupted", endedAt: undefined, outcome: {} }));
		expect(m.status).toBe("interrupted");
		expect(m.durationMs).toBe(0); // not NaN, not a bogus huge number
		expect(m.constructionDone).toBeNull(); // unknown, not false
	});

	it("never emits NaN for missing numbers", () => {
		const m = toGameMetric(meta({ outcome: {}, totals: {} as never }));
		for (const [k, v] of Object.entries(m)) {
			if (typeof v === "number") expect(Number.isFinite(v), `${k} = ${v}`).toBe(true);
		}
	});
});

describe("summarise", () => {
	it("counts runs and completed runs", () => {
		const s = summarise([
			toGameMetric(meta({ id: "a", status: "completed" })),
			toGameMetric(meta({ id: "b", status: "aborted" })),
		]);
		expect(s.count).toBe(2);
		expect(s.completed).toBe(1);
	});

	it("computes the built rate over runs that reached an outcome", () => {
		// A run with unknown outcome must not be counted as a failure.
		const s = summarise([
			toGameMetric(meta({ id: "a", outcome: { constructionDone: true } })),
			toGameMetric(meta({ id: "b", outcome: { constructionDone: false } })),
			toGameMetric(meta({ id: "c", status: "interrupted", outcome: {} })),
		]);
		expect(s.builtRate).toBe(0.5);
	});

	it("reports no rate rather than 0 when nothing is known", () => {
		const s = summarise([toGameMetric(meta({ status: "running", outcome: {} }))]);
		expect(s.builtRate).toBeNull();
	});

	it("totals tokens and cost", () => {
		const s = summarise([toGameMetric(meta({ id: "a" })), toGameMetric(meta({ id: "b" }))]);
		expect(s.totalTokens).toBe(6150);
		expect(s.costTotal).toBeCloseTo(0.84, 6);
	});

	it("summarises an empty ledger without throwing", () => {
		const s = summarise([]);
		expect(s.count).toBe(0);
		expect(s.builtRate).toBeNull();
		expect(s.totalTokens).toBe(0);
	});
});

describe("groupBySeed", () => {
	it("groups runs by seed, because that is what makes runs comparable", () => {
		// SPEC §5.2 #3: the controlled experiment is same-seed, different arm.
		const g = groupBySeed([
			toGameMetric(meta({ id: "a", seed: 7 })),
			toGameMetric(meta({ id: "b", seed: 7 })),
			toGameMetric(meta({ id: "c", seed: 9 })),
		]);
		expect(Object.keys(g).sort()).toEqual(["7", "9"]);
		expect(g["7"]!.map((m) => m.id)).toEqual(["a", "b"]);
		expect(g["9"]!.length).toBe(1);
	});
});

describe("compareArms 必须排除被中断的局（2026-09-12）", () => {
	// 为什么：真机里那 5 条 ledger 记录全是 `status: "interrupted"`、`money: 0`、
	// `stations: 0`、`constructionDone: null` —— 它们是"世界被暂停"那个 bug 时代
	// 留下的、被 Ctrl-C 杀掉的对局。它们作为 "without lessons" 的一票会把该臂
	// 均值拉到 0，于是 M3 对照曲线变成"记忆让成绩变好"的假结论。
	//
	// 被中断的局反映的是**操作者按了 Ctrl-C**，不是 agent 的水平 ——
	// 拿它跟跑完的局比，是把不可比的东西放在一起（MEMORY A2）。
	const mk = (over: Record<string, unknown>) => ({
		id: "x", seed: 7, mode: "agent", status: "completed", startedAt: 0, durationMs: 1,
		appVersion: "0", llmKind: "real", llmModel: "m", constructionDone: true,
		money: 1000, vehicles: 1, stations: 2, decisions: 3, toolCalls: 1, toolFailures: 0,
		totalTokens: 10, costTotal: 0,
		memory: { lessonsInjected: 0, strategiesInjected: 0 },
		...over,
	}) as never;

	it("被中断的局不进入任何一臂", () => {
		const c = compareArms([
			mk({ status: "completed", memory: { lessonsInjected: 0, strategiesInjected: 0 } }),
			mk({ status: "interrupted", money: 0, memory: { lessonsInjected: 0, strategiesInjected: 0 } }),
			mk({ status: "interrupted", money: 0, memory: { lessonsInjected: 0, strategiesInjected: 0 } }),
		]);
		// 只剩 1 局 completed，所以两臂都不够 3
		expect(c.withoutLessons.count).toBe(1);
		expect(c.conclusive).toBe(false);
		// 均值不能被那两条 0 拉下去
		expect(c.withoutLessons.meanMoney).toBe(1000);
	});

	it("被排除的数量要如实说明（不能悄悄丢）", () => {
		const c = compareArms([
			mk({ status: "interrupted", money: 0 }),
			mk({ status: "interrupted", money: 0 }),
			mk({ status: "completed" }),
		]);
		expect(c.note).toMatch(/interrupted/i);
		expect(c.note).toMatch(/2/);
	});

	it("全是中断局时说清楚原因，而不是说'还没有真实对局'", () => {
		const c = compareArms([mk({ status: "interrupted", money: 0 })]);
		expect(c.conclusive).toBe(false);
		expect(c.note).toMatch(/interrupted/i);
	});
});

describe("compareArms", () => {
	/** `n` runs in one arm, with a given money and injection state. */
	function arm(id: string, n: number, money: number, injected: number, seed = 7): GameMetric[] {
		return Array.from({ length: n }, (_, i) =>
			toGameMetric(
				meta({
					id: `${id}${i}`,
					seed,
					outcome: { constructionDone: money > 0, money: String(money) },
				}),
				{ lessonsInjected: injected },
			),
		);
	}

	it("splits into with-lessons vs without-lessons", () => {
		const c = compareArms([...arm("a", 3, 100, 0), ...arm("b", 3, 300, 2)]);
		expect(c.withLessons.count).toBe(3);
		expect(c.withoutLessons.count).toBe(3);
		expect(c.withLessons.meanMoney).toBe(300);
		expect(c.withoutLessons.meanMoney).toBe(100);
	});

	it("refuses to claim a difference from too few samples", () => {
		// SPEC §5.3 forbids speculative conclusions; a 1-vs-1 comparison proves
		// nothing and must be labelled as such rather than reported as a win.
		const c = compareArms([...arm("a", 1, 100, 0), ...arm("b", 1, 999, 2)]);
		expect(c.conclusive).toBe(false);
		expect(c.note).toMatch(/not enough|need|样本/i);
	});

	it("reports a difference only once both arms have enough runs", () => {
		const c = compareArms([...arm("a", MIN_LESSON_SAMPLE, 100, 0), ...arm("b", MIN_LESSON_SAMPLE, 300, 2)]);
		expect(c.conclusive).toBe(true);
		expect(c.moneyDelta).toBe(200);
	});

	it("excludes faux (scripted) runs from the comparison", () => {
		// A scripted demo is not evidence about the model, so mixing it in would
		// corrupt the experiment (SPEC §5.2 #1 is about real runs).
		const fauxRuns = Array.from({ length: 5 }, (_, i) =>
			toGameMetric(
				meta({
					id: `f${i}`,
					seed: 7,
					llm: { providerId: "", model: "", api: "", kind: "faux" },
					outcome: { constructionDone: true, money: "999999" },
				}),
				{ lessonsInjected: 5 },
			),
		);
		const c = compareArms([...arm("a", 3, 100, 0), ...fauxRuns]);
		expect(c.withLessons.count).toBe(0); // all faux runs dropped
	});

	it("handles one arm being empty", () => {
		const c = compareArms(arm("a", 3, 100, 0));
		expect(c.withLessons.count).toBe(0);
		expect(c.conclusive).toBe(false);
		expect(c.moneyDelta).toBeNull();
	});
});

describe("compareArms 必须拒绝被 confound 的结论（2026-09-12）", () => {
	const mk = (over: Record<string, unknown>) => ({
		id: "x", seed: 7, mode: "agent", status: "completed", startedAt: 0, durationMs: 1,
		appVersion: "0", llmKind: "real", llmModel: "m", constructionDone: true,
		money: 1000, vehicles: 1, stations: 2, decisions: 3, toolCalls: 1, toolFailures: 0,
		totalTokens: 10, costTotal: 0,
		memory: { lessonsInjected: 0, strategiesInjected: 0 },
		...over,
	}) as never;

	// 真实数据：6 局里唯一建成的那局**钱最少**（建线要花钱），但 compareArms
	// 给"什么都没建成"的那臂报了 +6342，而且 conclusive=true。
	// 数字是真的，符号的含义与它看起来的**相反**。
	//
	// 这是 MEMORY A2「不要比较不可比的东西」的下一层：原有的排除只挡住
	// "没跑完的局"，挡不住"两臂停在不同阶段"。
	const arm = (injected: number, done: boolean, money: number) =>
		mk({ constructionDone: done, money, memory: { lessonsInjected: injected, strategiesInjected: 0 } });
	/** n 局同构样本（用门槛常量，提升门槛时测试自动跟随）。 */
	const many = (n: number, injected: number, done: boolean, money: number) =>
		Array.from({ length: n }, () => arm(injected, done, money));

	it("两臂建成率不同时，拒绝下结论", () => {
		// 真实形态放大到门槛样本：treatment 全部未建成（钱高，没花钱），
		// control 里 1 局建成（钱低）+ 其余未建成。
		const c = compareArms([
			...many(MIN_LESSON_SAMPLE, 5, false, 286094),
			arm(0, true, 267068),
			...many(MIN_LESSON_SAMPLE - 1, 0, false, 284359),
		]);
		expect(c.withLessons.builtRate).toBe(0);
		expect(c.withoutLessons.builtRate).toBeCloseTo(1 / MIN_LESSON_SAMPLE);
		// 样本量是够的……
		expect(c.withLessons.count).toBe(MIN_LESSON_SAMPLE);
		expect(c.withoutLessons.count).toBe(MIN_LESSON_SAMPLE);
		// ……但结论必须被拒绝
		expect(c.confounded).toBe(true);
		expect(c.conclusive).toBe(false);
		// 而且必须说清楚"钱的符号意思是反的"，不能让人只看到 +6342
		expect(c.note).toMatch(/NOT comparable/);
		expect(c.note).toMatch(/not a benefit/);
		expect(c.note).toMatch(new RegExp(`0% vs ${Math.round(100 / MIN_LESSON_SAMPLE)}%`));
	});

	it("两臂建成率相同时，照常下结论", () => {
		const c = compareArms([
			...many(MIN_LESSON_SAMPLE, 5, true, 1100),
			...many(MIN_LESSON_SAMPLE, 0, true, 1000),
		]);
		expect(c.confounded).toBe(false);
		expect(c.conclusive).toBe(true);
		expect(c.moneyDelta).toBe(100);
		expect(c.note).not.toMatch(/NOT comparable/);
	});

	it("被排除的局即使在 confound 时也必须如实说明", () => {
		const c = compareArms([
			...many(MIN_LESSON_SAMPLE, 5, false, 100),
			...many(MIN_LESSON_SAMPLE, 0, true, 100),
			mk({ status: "interrupted", memory: { lessonsInjected: 0, strategiesInjected: 0 } }),
		]);
		expect(c.note).toMatch(/interrupted/i);
	});
});

describe("C-3：token/决策归一守卫（SPEC §10.43 归因教训）", () => {
	/** arm with explicit decisions + tokens per run */
	function armDT(id: string, n: number, injected: number, decisions: number, tokens: number): GameMetric[] {
		return Array.from({ length: n }, (_, i) =>
			toGameMetric(
				meta({
					id: `${id}${i}`,
					outcome: { constructionDone: true, money: "100000" },
					totals: {
						decisions, toolCalls: 2, toolFailures: 0, events: 10,
						usage: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, costTotal: 0 },
					},
				}),
				{ lessonsInjected: injected },
			),
		);
	}

	it("ArmStats 暴露 tokensPerDecision（归一到每决策）", () => {
		const c = compareArms([
			...armDT("a", MIN_LESSON_SAMPLE, 0, 10, 40_000),   // ctl: 4k/决策
			...armDT("b", MIN_LESSON_SAMPLE, 4, 18, 72_000),   // trt: 4k/决策 —— 相同！
		]);
		expect(c.withoutLessons.tokensPerDecision).toBeCloseTo(4_000, 0);
		expect(c.withLessons.tokensPerDecision).toBeCloseTo(4_000, 0);
	});

	it("归一后两臂相同 → 不得声称'记忆增加 token 成本'（meanTokens 差是行动数混杂）", () => {
		const c = compareArms([
			...armDT("a", MIN_LESSON_SAMPLE, 0, 10, 40_000),
			...armDT("b", MIN_LESSON_SAMPLE, 4, 18, 72_000),
		]);
		// meanTokens 不同（40k vs 72k）但 per-decision 相同 —— note 必须指明这一点
		expect(c.note).toMatch(/per-decision|归一/i);
	});

	it("decisions=0 的局被排除出归一（除零防护，不造 Infinity）", () => {
		const c = compareArms([
			...armDT("a", 2, 0, 0, 5_000),     // 躺平局：0 决策
			...armDT("b", 3, 4, 10, 30_000),
		]);
		expect(Number.isFinite(c.withoutLessons.tokensPerDecision ?? 0)).toBe(true);
		expect(c.withoutLessons.tokensPerDecision).toBeNull(); // 全躺平臂 → null
	});
});

describe("C-1 计分：route facts 注入必须计入 treatment 臂（m3e 实测缺陷）", () => {
	it("lessonsInjected=0 但 routeFactsInjected>0 的局归入 with-lessons", () => {
		const ctl = (i: number) =>
			toGameMetric(meta({ id: `ctl${i}`, outcome: { constructionDone: true, money: "100000" } }), { lessonsInjected: 0, strategiesInjected: 0 });
		const factsOnly = (i: number) =>
			toGameMetric(meta({ id: `fact${i}`, outcome: { constructionDone: true, money: "100000" } }), { lessonsInjected: 0, strategiesInjected: 0, routeFactsInjected: 3 });
		const c = compareArms([ctl(1), ctl(2), ctl(3), factsOnly(1), factsOnly(2), factsOnly(3)]);
		expect(c.withLessons.count).toBe(3);
		expect(c.withoutLessons.count).toBe(3);
	});
});

describe("分级结果：stations 均值（200s 窗口截断主导，二值 done 不够）", () => {
	const st = (i: number, stations: number, injected: number) =>
		toGameMetric(
			meta({
				id: `s${i}`,
				outcome: { constructionDone: false, money: "100000", vehicles: 2, stations },
			}),
			{ lessonsInjected: injected, strategiesInjected: 0 },
		);

	it("ArmStats 暴露 meanStations（截断局也有信息量）", () => {
		const c = compareArms([
			st(1, 4, 0), st(2, 4, 0), st(3, 4, 0), st(4, 4, 0), st(5, 4, 0),
			st(6, 2, 3), st(7, 2, 3), st(8, 0, 3), st(9, 0, 3), st(10, 0, 3),
		]);
		expect(c.withoutLessons.meanStations).toBe(4);
		expect(c.withLessons.meanStations).toBeCloseTo(0.8, 5);
	});
});

/**
 * NEXT-2 N2-4：主指标换成**收益流**。
 *
 * 为什么：money 被"建不建"主导（建线就是花钱→钱变少），三轮 A/B 都卡在这里
 * （SPEC §10.52）。income 才是"这条线到底赚不赚钱"，也是记忆能影响的量。
 * 缺读数的局**不贡献 0**——0 会被读成"确实不赚钱"。
 */
describe("N2-4 收益流指标", () => {
	/** 一局带（或不带）收益读数的样本；memory 0 = control 臂。 */
	const run = (income: number | null) => {
		const m = toGameMetric(meta({ outcome: { constructionDone: true, money: "100000", stations: 4 } }));
		return { ...m, income };
	};
	const statsOf = (runs: ReturnType<typeof run>[]) => compareArms(runs).withoutLessons;

	it("meanIncome 只对报告过收益的局取均值（缺读数的局不冒充 0）", () => {
		const st = statsOf([run(1200), run(null), run(800)]);
		expect(st.meanIncome).toBe(1000);
		expect(st.incomeReported).toBe(2);
	});

	it("全部缺读数 → meanIncome 为 null（不是 0）", () => {
		expect(statsOf([run(null)]).meanIncome).toBeNull();
		expect(statsOf([run(null)]).incomeReported).toBe(0);
	});

	it("负收益合法（亏损线不是缺失值）", () => {
		const st = statsOf([run(-400), run(-200)]);
		expect(st.meanIncome).toBe(-300);
		expect(st.incomeReported).toBe(2);
	});
});

/**
 * 臂划分必须来自**实验分配**，不能由注入计数推断（2026-09-17，/tmp/n2ab 实测）。
 *
 * 现象：新 dataDir 的前两局（ctl1 与 trt1）注入数都是 0（trt1 是第一局 treatment，
 * 那时还没有任何 lesson/fact 可注入）→ 两局都被判成 control，最终臂变成 6 vs 4。
 * 这是 m3f 缺陷（"treatment 只看 lessons"）的**下一层**：修了"facts 也算注入"，
 * 却没修"注入为空 ≠ 不是 treatment 臂"。
 */
describe("臂划分：以实验分配为准（N2-5 缺陷修复）", () => {
	const run = (arm: "treatment" | "control", injected: number) => ({
		...toGameMetric(meta({ outcome: { constructionDone: true, money: "100000", stations: 4 } }), {
			lessonsInjected: injected,
			strategiesInjected: 0,
			routeFactsInjected: injected,
		}),
		arm,
	});

	it("treatment 臂即使什么都没注入，也算 treatment（分配 ≠ 实际注入量）", () => {
		const cmp = compareArms([run("treatment", 0), run("control", 3)]);
		expect(cmp.withLessons.count).toBe(1);
		expect(cmp.withoutLessons.count).toBe(1);
	});

	it("注入为空要在结论里点名（干预没送到，是实验缺陷不是结果）", () => {
		const cmp = compareArms([run("treatment", 0), run("control", 3)]);
		expect(cmp.treatmentWithoutInjection).toBe(1);
	});

	it("有注入的 treatment 不计入该计数", () => {
		expect(compareArms([run("treatment", 4), run("control", 3)]).treatmentWithoutInjection).toBe(0);
	});

	it("没有 arm 字段的旧记录：退回旧启发式（保持向后兼容，不炸）", () => {
		const legacy = toGameMetric(meta({ outcome: { constructionDone: true, money: "1", stations: 1 } }), {
			lessonsInjected: 5,
			strategiesInjected: 0,
		});
		const cmp = compareArms([legacy, run("control", 0)]);
		expect(cmp.withLessons.count).toBe(1); // lessons>0 → treatment（旧规则）
	});
});

/**
 * N2-4b：**吞吐量**（deliveredCargo）作为运营结果指标。
 *
 * 为什么不是 income：admin 协议里 `income` 是 net（含负的费用，见
 * payload-parsers.ts 注释），施工期必然为负——它继承了 money 的混杂。
 * `deliveredCargo` 是"运了多少货/客"，**不受施工花费与贷款影响**：
 * 有线路真的在运转就有吞吐量，没建线就是 0——这是"这件事有没有做事"的
 * 直接度量，也是记忆能影响的量。
 */
describe("N2-4b 吞吐量指标", () => {
	const run = (delivered: number | null) => {
		const m = toGameMetric(meta({ outcome: { constructionDone: true, money: "1", stations: 4 } }));
		return { ...m, delivered };
	};
	const statsOf = (runs: ReturnType<typeof run>[]) => compareArms(runs).withoutLessons;

	it("meanDelivered 仅统计报告过的局（缺读数不进均值）", () => {
		const st = statsOf([run(120), run(null), run(80)]);
		expect(st.meanDelivered).toBe(100);
		expect(st.deliveredReported).toBe(2);
	});

	it("全部缺失 → null（不是 0：0 会被读成'一票没运'）", () => {
		expect(statsOf([run(null)]).meanDelivered).toBeNull();
	});

	it("0 是合法读数（建了线但没运货），与缺失区分", () => {
		const st = statsOf([run(0), run(0)]);
		expect(st.meanDelivered).toBe(0);
		expect(st.deliveredReported).toBe(2);
	});
});

/**
 * A/B 的比较维度必须可指定（2026-09-17）。
 *
 * 事故：`arm` 字段是按"记忆注入"定义的，而冻结轮的**两臂都 `--no-memory`**
 * → 两臂都被记成 control，整轮统计直接失去对照（我自己引入的缺陷，正是
 * "臂来自分配"那条规则的续集：分配的是什么变量，就得记录**那个**变量）。
 */
describe("compareArms(by) —— 比较维度可选", () => {
	const run = (freeze: boolean, delivered: number) => ({
		...toGameMetric(meta({ outcome: { constructionDone: true, money: "1", stations: 1, delivered } })),
		arm: "control" as const, // 冻结轮两臂都是 --no-memory
		freeze: freeze ? { confirmed: 5, unconfirmed: 0, failures: 0, watchdogTrips: 0, maxHoldMs: 1000 } : null,
	});

	it("by='freeze'：有冻结为 treatment，无冻结为 control（两臂都 arm=control 也要能分开）", () => {
		const cmp = compareArms([run(true, 100), run(false, 20)], "freeze");
		expect(cmp.withLessons.count).toBe(1);
		expect(cmp.withoutLessons.count).toBe(1);
		expect(cmp.withLessons.meanDelivered).toBe(100);
		expect(cmp.withoutLessons.meanDelivered).toBe(20);
	});

	it("by='memory'（默认）：仍按 arm 划分，不受 freeze 字段影响", () => {
		const cmp = compareArms([run(true, 100), run(false, 20)]);
		expect(cmp.withLessons.count).toBe(0);
		expect(cmp.withoutLessons.count).toBe(2);
	});

	it("冻结但一次都没确认上（confirmed=0）→ 算 control：干预没送到就不是 treatment 臂", () => {
		const broken = { ...run(true, 5), freeze: { confirmed: 0, unconfirmed: 4, failures: 0, watchdogTrips: 0, maxHoldMs: 0 } };
		const cmp = compareArms([broken, run(true, 100)], "freeze");
		expect(cmp.withLessons.count).toBe(1);
		expect(cmp.withoutLessons.count).toBe(1);
	});
});

/**
 * 零膨胀重尾判据（2026-09-17，/tmp/n2ab3 实测）。* 
 *
 * 现象：delivered 逐局为 control [0,23,0,18,15]、treatment [0,77,39,0,0]——
 * **均值 favor treatment（23.2 vs 11.2），中位数 favor control（0 vs 15）**。
 * 单个 77 撑起均值。这是"n=5 不能判定"的量化原因：重尾 + 零膨胀下，
 * 均值与中位数可以符号相反，此时只有分布感知的统计（中位/零率/自助法）能说清。
 */
describe("delivered：分布感知统计 + 判据守卫", () => {
	const run = (arm: "treatment" | "control", delivered: number, built: boolean) => ({
		...toGameMetric(meta({ outcome: { constructionDone: built, money: "1", stations: 2, delivered } })),
		arm,
	});

	const both = [
		run("treatment", 0, false), run("treatment", 77, true), run("treatment", 39, false),
		run("treatment", 0, true), run("treatment", 0, false),
		run("control", 0, true), run("control", 23, true), run("control", 0, false),
		run("control", 18, false), run("control", 15, true),
	];

	it("中位数与零率都被报出（重尾下均值会撒谎）", () => {
		const cmp = compareArms(both);
		expect(cmp.withLessons.medianDelivered).toBe(0);
		expect(cmp.withoutLessons.medianDelivered).toBe(15);
		expect(cmp.withLessons.zeroDeliveredRate).toBeCloseTo(0.6, 6);
		expect(cmp.withoutLessons.zeroDeliveredRate).toBeCloseTo(0.4, 6);
	});

	it("均值与中位数符号相反 → 明确标注（不许只报均值让人以为结论已定）", () => {
		const cmp = compareArms(both);
		expect(cmp.deliveredNote).toMatch(/median|重尾|heavy|disagree/i);
	});

	it("delivered 的判定不被 built-rate 守卫挡住（该守卫是给 money/income 的）", () => {
		// money 的混杂是"没建成 → 没花钱 → 钱更多"；delivered 恰好相反：
		// 没建成 → 没运货 → 0。把它一起挡掉等于用别人的病否决自己的问题。
		const cmp = compareArms(both);
		expect(cmp.conclusive).toBe(false); // money/income 仍不可比（建成率不同）
		expect(cmp.deliveredConclusive).toBe(true); // 但 delivered 样本足够即可判
	});

	it("样本不足时 deliveredConclusive 为 false", () => {
		const few = [run("treatment", 5, true), run("control", 1, true)];
		expect(compareArms(few).deliveredConclusive).toBe(false);
	});
});

/**
 * 障碍模型（hurdle）统计量（2026-09-17，第一性原理）。
 *
 * 实测 33 局：**70% 的局 delivered=0**，非零局 mean≈32 / range 13–77。
 * 即数据生成过程 = `P(>0)=p` × 正值重尾。力量模拟（真实分布）显示：
 *   n=5/臂 时 Mann-Whitney 力量 **0.08**、Fisher 0.07、均值 t 0.20
 *   n=40/臂 才到 0.50；要 0.80 需 ~80–100 局/臂（≈24 小时/轮，不可行）
 * → 均值比较既不是最强的，也不是最匹配 DGP 的。
 *
 * 因此主统计量改为**障碍率**（delivering 局占比，Fisher 精确检验）+
 * Mann-Whitney（秩，稳健于重尾）；均值只作描述并附自助法区间。
 */
describe("hurdle 统计量：零率 / Fisher / Mann-Whitney / 自助法", () => {
	const run = (arm: "treatment" | "control", delivered: number) => ({
		...toGameMetric(meta({ outcome: { constructionDone: delivered > 0, money: "1", stations: 2, delivered } })),
		arm,
	});
	const many = (arm: "treatment" | "control", vals: number[]) => vals.map((v) => run(arm, v));

	it("deliveryRate = 非零局占比（障碍率，DGP 的 p）", () => {
		const cmp = compareArms([...many("treatment", [0, 30, 40, 0, 0, 20]), ...many("control", [0, 0, 0, 10, 0, 0])]);
		expect(cmp.withLessons.deliveryRate).toBeCloseTo(3 / 6, 6);
		expect(cmp.withoutLessons.deliveryRate).toBeCloseTo(1 / 6, 6);
	});

	it("Fisher 精确检验：6/6 vs 1/6 的障碍率差异给出 p 值", () => {
		const cmp = compareArms([...many("treatment", [0, 30, 40, 0, 0, 20]), ...many("control", [0, 0, 0, 10, 0, 0])]);
		expect(cmp.deliveryPValue).not.toBeNull();
		expect(cmp.deliveryPValue!).toBeGreaterThan(0.05); // 6 局太小，不该显著
	});

	it("Mann-Whitney 秩检验对重尾稳健（同一数据给出 p 值）", () => {
		const cmp = compareArms([...many("treatment", [0, 30, 40, 0, 0, 20]), ...many("control", [0, 0, 0, 10, 0, 0])]);
		expect(cmp.mannWhitneyPValue).not.toBeNull();
		expect(cmp.mannWhitneyPValue!).toBeGreaterThan(0);
		expect(cmp.mannWhitneyPValue!).toBeLessThanOrEqual(1);
	});

	it("自助法 95% 区间：区间跨 0 → 明确报'不确定'（重尾下比 p 值更诚实）", () => {
		const cmp = compareArms([...many("treatment", [0, 30, 40, 0, 0, 20]), ...many("control", [0, 0, 0, 10, 0, 0])]);
		expect(cmp.meanDiffCi).not.toBeNull();
		const [lo, hi] = cmp.meanDiffCi!;
		expect(lo).toBeLessThan(hi);
	});

	it("样本不足（<MIN）→ 统计量为 null，不假装算过", () => {
		const cmp = compareArms([run("treatment", 5), run("control", 1)]);
		expect(cmp.deliveryPValue).toBeNull();
		expect(cmp.mannWhitneyPValue).toBeNull();
	});
});

/**
 * 流量指标换代（2026-09-18，SPEC §10.65）。
 *
 * 事故：`delivered = economy.deliveredCargo` 是 **OpenTTD 的当季计数器**
 * （每季归零）。运行恰好在季界后结束就记 0（建成却"零交付"），其余运行各自
 * 覆盖 0–90 游戏天不等的部分季度 —— 两轮 A/B 因此给出**相反方向**。
 * 修法：`deliveredRun` 把季界积分掉（见 delivery-meter），判定优先用它，
 * 但**两臂必须同源**：一边用积分值、一边用原始值，就是拿不可比的东西比。
 */
describe("deliveredRun —— 跨季积分的流量指标优先，且两臂同源", () => {
	const run = (arm: "treatment" | "control", raw: number | null, integrated: number | null) => ({
		...toGameMetric(meta({ outcome: { constructionDone: true, money: "1", stations: 4 } })),
		arm,
		delivered: raw,
		deliveredRun: integrated,
	});
	/** 每臂 5 局（达到报告下限），积分值 = 原始值 + 100，便于区分用了哪个源。 */
	const bothArmsWithRun = () => [
		...Array.from({ length: 5 }, (_, i) => run("treatment", 10 + i, 110 + i)),
		...Array.from({ length: 5 }, (_, i) => run("control", 20 + i, 120 + i)),
	];

	it("两臂都有积分读数 → 用积分值，并声明来源", () => {
		const cmp = compareArms(bothArmsWithRun());
		expect(cmp.deliveredSource).toBe("run");
		expect(cmp.withLessons.meanDelivered).toBe(112); // 110..114
		expect(cmp.withoutLessons.meanDelivered).toBe(122); // 120..124
	});

	it("两臂都没有积分读数（历史行）→ 回落到原始值，不假装是积分值", () => {
		const cmp = compareArms([
			...Array.from({ length: 5 }, (_, i) => run("treatment", 10 + i, null)),
			...Array.from({ length: 5 }, (_, i) => run("control", 20 + i, null)),
		]);
		expect(cmp.deliveredSource).toBe("raw");
		expect(cmp.withLessons.meanDelivered).toBe(12); // 10..14
	});

	it("只有一边有积分读数 → 两臂都用原始值（绝不混用）", () => {
		const cmp = compareArms([
			...Array.from({ length: 5 }, (_, i) => run("treatment", 10 + i, 110 + i)),
			...Array.from({ length: 5 }, (_, i) => run("control", 20 + i, null)),
		]);
		expect(cmp.deliveredSource).toBe("raw");
		expect(cmp.withLessons.meanDelivered).toBe(12);
		expect(cmp.withoutLessons.meanDelivered).toBe(22);
	});
});

/**
 * 披露聚合（R1，2026-09-18）。
 *
 * `channel health` 这行曾**从未在实验日志里出现过**，且实现把 ArmSummary 当行用，
 * 永远吐出 "not reported"。这里锁定两条性质：缺报 ≠ 0；聚合只有一处实现。
 */
/**
 * G7（SPEC §10.85）：判据在**这个配置**下会不会动。
 *
 * 真机事实：horizon=30 的 19 局 `deliveredRun` **全部为 0**，而 horizon=300 的 6 局
 * 全部非 0（90–589）。原因是判据由 `COMPANY_ECONOMY.deliveredCargo` 积分而来，
 * 而那是**按季度重置**的计数器（我们的 `QUARTER_DAYS = 90`，SPEC §10.65）——
 * 短于一个季度的窗口只能观测到"没有变化"。
 *
 * 因此"30 天的 A/B"不是样本不足，而是**判据恒为常数**：它什么都测不出来。
 * 一个恒为常数的判据，任何比较都是谎言——守卫必须在跑之前就拦住。
 */
describe("G7: 判据退化检测（常数判据不能比较）", () => {
	it("全部为 0 或未测 → 报退化（这不是「没有效果」）", () => {
		const rows = [
			{ deliveredRun: 0 },
			{ deliveredRun: 0 },
		] as unknown as Parameters<typeof deliveredOutcome>[0];
		const d = deliveredOutcome(rows);
		expect(d.degenerate).toBe(true);
		expect(d.measured).toBe(2);
	});

	it("有非零值 → 不报退化", () => {
		const rows = [{ deliveredRun: 0 }, { deliveredRun: 152 }] as unknown as Parameters<
			typeof deliveredOutcome
		>[0];
		expect(deliveredOutcome(rows).degenerate).toBe(false);
	});

	it("全部未测量 → 也报退化（说明判据根本没接上）", () => {
		const rows = [{ deliveredRun: null }] as unknown as Parameters<typeof deliveredOutcome>[0];
		const d = deliveredOutcome(rows);
		expect(d.degenerate).toBe(true);
		expect(d.measured).toBe(0);
	});
});

describe("G7: 可比 horizon 的下限由计数器粒度决定", () => {
	it("下限是 2 个季度（积分需要跨过一个完整的季度边界）", () => {
		expect(MIN_COMPARABLE_HORIZON_DAYS).toBe(180);
	});

	it("30 天的配置被判定为不可比，300 天可以", () => {
		expect(horizonIsComparable(30)).toBe(false);
		expect(horizonIsComparable(120)).toBe(false);
		expect(horizonIsComparable(180)).toBe(true);
		expect(horizonIsComparable(300)).toBe(true);
	});
});

describe("metricStat / degradationStats: 缺报不是 0", () => {
	it("没人报过 → null（不是 0）", () => {
		expect(metricStat([null, undefined])).toBeNull();
		expect(formatMetricStat(null)).toBe("not reported");
	});

	it("真实的 0 会被报告，并与缺报区分开", () => {
		const stat = metricStat([0, null, 0]);
		expect(stat).toEqual({ reported: 2, max: 0, total: 0 });
		expect(formatMetricStat(stat)).toBe("n=2 max=0 total=0");
	});

	it("混合行：只在报告行上取 max/total", () => {
		expect(metricStat([0, 5, null, 2])).toEqual({ reported: 3, max: 5, total: 7 });
		expect(metricStat([Number.NaN, 1])).toEqual({ reported: 1, max: 1, total: 1 });
	});

	it("G6：峰值请求大小进入披露（max = 各局最大值；旧行缺报 ≠ 0）", () => {
		const rows = [
			{ gsErrors: 0, toolBudgetBlocks: 0, peakRequestTokens: 41000 },
			{ gsErrors: 0, toolBudgetBlocks: 0, peakRequestTokens: 96000 },
			{ gsErrors: 0, toolBudgetBlocks: 0, peakRequestTokens: null }, // 旧记录：未测量
		] as unknown as Parameters<typeof degradationStats>[0];
		const d = degradationStats(rows) as { peakRequestTokens?: { reported: number; max: number } };
		expect(d.peakRequestTokens).toEqual({ reported: 2, max: 96000, total: 137000 });
	});

	it("全部未测量 → not reported（不能说成 0）", () => {
		const rows = [{ gsErrors: 0, toolBudgetBlocks: 0, peakRequestTokens: null }] as unknown as Parameters<
			typeof degradationStats
		>[0];
		const d = degradationStats(rows) as { peakRequestTokens?: unknown };
		expect(formatMetricStat(d.peakRequestTokens as never)).toBe("not reported");
	});

	it("degradationStats 从账本行取通道健康与工具封顶", () => {
		const rows = [
			{ gsErrors: 0, toolBudgetBlocks: 0 },
			{ gsErrors: 4, toolBudgetBlocks: 2 },
		] as unknown as Parameters<typeof degradationStats>[0];
		const d = degradationStats(rows);
		expect(d.gsErrors).toEqual({ reported: 2, max: 4, total: 4 });
		expect(d.toolBudgetBlocks).toEqual({ reported: 2, max: 2, total: 2 });
	});
});

/**
 * D28 的机械守卫：**披露必须走在判据路径上**。
 *
 * G7 的退化检测只有在"每个会打印比较结论的地方"都调用它时才有意义；
 * 曾经我们踩过这个坑（`channel health` 只写在 m3-verdict 里、且读的是错误的字段，
 * 于是那一行永远显示 not reported）。这条测试保证：两个 verdict 与实验脚本
 * 都不会悄悄把守卫删掉。
 */
describe("G7: 退化守卫必须在所有会下结论的路径上", () => {
	const files = ["scripts/run-experiment.ts", "scripts/m3-verdict.ts"];
	it.each(files)("%s 使用 deliveredOutcome 或 horizonIsComparable", (f) => {
		const src = readFileSync(f, "utf8");
		expect(
			src.includes("deliveredOutcome(") || src.includes("horizonIsComparable("),
			`${f} 必须检查判据是否会动（SPEC §10.85 / D28）`,
		).toBe(true);
	});

	it("实验脚本在跑之前拒绝短于 2 个季度的比较", () => {
		const src = readFileSync("scripts/run-experiment.ts", "utf8");
		expect(src).toContain("horizonIsComparable(hz)");
		expect(src).toContain("MIN_COMPARABLE_HORIZON_DAYS");
	});
});
