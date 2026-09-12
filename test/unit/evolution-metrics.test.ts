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

import { describe, expect, it } from "vitest";
import {
	compareArms,
	toGameMetric,
	summarise,
	groupBySeed,
	MIN_LESSON_SAMPLE,
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
		expect(m.memory).toEqual({ lessonsInjected: 3, strategiesInjected: 1 });
	});

	it("defaults to no injection when nothing was injected", () => {
		const m = toGameMetric(meta());
		expect(m.memory).toEqual({ lessonsInjected: 0, strategiesInjected: 0 });
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
