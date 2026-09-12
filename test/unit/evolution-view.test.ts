/**
 * Unit tests — Evolution 页视图模型。
 *
 * 职责: 锁定跨局记忆页的**展示契约**:两臂对照怎么说、样本不足时怎么说、
 *   策略卡为什么可注入/不可注入。
 * 事实来源: SPEC §6.1 #4、§5.2 #3、§5.3；docs/DASHBOARD-API.md §3.5。
 * 禁止: 在此断言规则实现（promotion/样本判定由服务端负责，见 src/evolution/web-view.ts）。
 *
 * 为什么"样本不足"必须显式测:这个页面的唯一说服力来源是**对照实验**。
 * 如果它在 1 局 vs 1 局时就显示"带 lessons 更好",它就变成了一个自我安慰的仪表盘
 * —— 而 SPEC §5.3 明确禁止这种没有证据的因果结论。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/evolution-view.js"), "utf8");

interface EvModel {
	data: unknown;
	loading: boolean;
	error: unknown;
	armCards(): { label: string; runs: string; money: string }[];
	verdictText(): string;
	verdictOk(): boolean;
	gameRows(): { id: string; memory: string; hasMemory: boolean }[];
	moneySeries(): { data: number[] }[];
	moneyLabels(): string[];
	lessonRows(): { text: string; kindLabel: string; superseded: boolean; evidence: string }[];
	strategyRows(): {
		id: string;
		label: string;
		promoted: boolean;
		enabled: boolean;
		injectable: boolean;
		reason: string;
	}[];
	injectableCount(): number;
	empty(): boolean;
}

function uiStub() {
	return {
		fmtInt: (v: unknown) => String(v ?? 0),
		fmtMoney: (v: unknown) => `£${Math.round(Number(v) || 0)}`,
		fmtTok: (v: unknown) => `${v}t`,
		fmtCost: (v: unknown) => `$${v}`,
		fmtPct: (v: number, d?: number) => `${((Number(v) || 0) * 100).toFixed(d ?? 1)}%`,
	};
}

function load(): EvModel {
	const sandbox: Record<string, unknown> = { console, JSON, Object, Array, Number, String, Math, Date };
	sandbox.UI = uiStub();
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const view = (sandbox.window as { EvolutionView: { create: () => EvModel } }).EvolutionView;
	return view.create();
}

function withData(payload: unknown): EvModel {
	const m = load();
	m.data = payload;
	m.loading = false;
	return m;
}

const METRIC = (over: Record<string, unknown> = {}) => ({
	id: "20260912-100000-seed7",
	seed: 7,
	status: "completed",
	llmKind: "real",
	startedAt: 1000,
	money: 250000,
	decisions: 9,
	totalTokens: 40000,
	costTotal: 0.42,
	memory: { lessonsInjected: 0, strategiesInjected: 0 },
	...over,
});

describe("evolution-view: 两臂对照（SPEC §5.2 #3）", () => {
	it("样本不足时明说不足,而不是给一个结论", () => {
		const m = withData({
			metrics: [METRIC({ memory: { lessonsInjected: 1, strategiesInjected: 0 } })],
			arms: {
				withLessons: { count: 1, meanMoney: 300000, meanTokens: 10, builtRate: 1 },
				withoutLessons: { count: 1, meanMoney: 200000, meanTokens: 10, builtRate: 1 },
				moneyDelta: 100000,
				conclusive: false,
				note: "Not enough runs to compare: need 2 more with-lessons run(s).",
			},
		});
		expect(m.verdictOk()).toBe(false);
		expect(m.verdictText()).toContain("Not enough runs");
	});

	it("样本足够时才给出结论", () => {
		const m = withData({
			metrics: [],
			arms: {
				withLessons: { count: 3, meanMoney: 300000, meanTokens: 10, builtRate: 1 },
				withoutLessons: { count: 3, meanMoney: 200000, meanTokens: 10, builtRate: 1 },
				moneyDelta: 100000,
				conclusive: true,
				note: "",
			},
		});
		expect(m.verdictOk()).toBe(true);
		expect(m.verdictText()).toMatch(/better/);
		expect(m.verdictText()).toContain("£100000");
	});

	it("两臂各渲染一张卡片", () => {
		const m = withData({
			arms: {
				withLessons: { count: 3, meanMoney: 300000, meanTokens: 10, builtRate: 1 },
				withoutLessons: { count: 2, meanMoney: 200000, meanTokens: 10, builtRate: null },
				moneyDelta: 100000,
				conclusive: false,
				note: "nope",
			},
		});
		const cards = m.armCards();
		expect(cards).toHaveLength(2);
		expect(cards[0]!.label).toMatch(/with/i);
		expect(cards[1]!.label).toMatch(/without/i);
		// unknown rate must render as a placeholder, not as 0%
		expect(cards[1]!.money).toBe("£200000");
	});

	it("完全没有 arms 时安全", () => {
		const m = withData({ metrics: [] });
		expect(m.armCards()).toEqual([]);
		expect(m.verdictText()).toBeTruthy();
		expect(m.verdictOk()).toBe(false);
	});
});

describe("evolution-view: 跨局列表", () => {
	it("最新的局排在最前", () => {
		const m = withData({
			metrics: [METRIC({ id: "old", startedAt: 1 }), METRIC({ id: "new", startedAt: 9 })],
		});
		expect(m.gameRows().map((r) => r.id)).toEqual(["new", "old"]);
	});

	it("标注本局有没有被注入记忆(对照实验的分组依据)", () => {
		const m = withData({
			metrics: [
				METRIC({ id: "a", memory: { lessonsInjected: 2, strategiesInjected: 1 } }),
				METRIC({ id: "b", memory: { lessonsInjected: 0, strategiesInjected: 0 } }),
			],
		});
		const rows = m.gameRows();
		expect(rows.find((r) => r.id === "a")!.hasMemory).toBe(true);
		expect(rows.find((r) => r.id === "b")!.memory).toBe("none");
	});

	it("现金序列按时间升序(折线要能读出趋势)", () => {
		const m = withData({
			metrics: [METRIC({ startedAt: 9, money: 900 }), METRIC({ startedAt: 1, money: 100 })],
		});
		expect(m.moneySeries()[0]!.data).toEqual([100, 900]);
		expect(m.moneyLabels()).toHaveLength(2);
	});

	it("容忍空/垃圾 metrics", () => {
		expect(withData({ metrics: [] }).gameRows()).toEqual([]);
		expect(withData({ metrics: "nope" }).gameRows()).toEqual([]);
		expect(withData({}).moneySeries()[0]!.data).toEqual([]);
	});
});

describe("evolution-view: lesson 库", () => {
	it("按置信度降序", () => {
		const m = withData({
			lessons: [
				{ text: "low", kind: "do", confidence: 0.2, evidence: ["e"] },
				{ text: "high", kind: "do", confidence: 0.9, evidence: ["e"] },
			],
		});
		expect(m.lessonRows().map((l) => l.text)).toEqual(["high", "low"]);
	});

	it("区分 do / avoid 并带证据与来源(用户要能判断可信度)", () => {
		const m = withData({
			lessons: [
				{
					text: "avoid long routes",
					kind: "dont",
					confidence: 0.6,
					evidence: ["money -40000", "routes 3"],
					sourceSessionId: "prev-1",
					sourceSeed: 7,
				},
			],
		});
		const row = m.lessonRows()[0]!;
		expect(row.kindLabel).toBe("avoid");
		expect(row.evidence).toContain("money -40000");
	});

	it("标出已被覆盖的教训(它不会被注入)", () => {
		const m = withData({
			lessons: [{ text: "old", kind: "do", confidence: 0.5, evidence: ["e"], supersededBy: "x" }],
		});
		expect(m.lessonRows()[0]!.superseded).toBe(true);
	});

	it("容忍空/垃圾 lessons", () => {
		expect(withData({ lessons: [] }).lessonRows()).toEqual([]);
		expect(withData({ lessons: 42 }).lessonRows()).toEqual([]);
	});
});

describe("evolution-view: 策略候选池", () => {
	const strategy = (over: Record<string, unknown> = {}) => ({
		id: "s1",
		action: "build_bus_route",
		params: { distance: 24 },
		valuePerRun: [9000, 12000],
		enabled: false,
		promotion: { promoted: true, value: 10500, runs: 2, reason: "value 10500 over 2 games" },
		...over,
	});

	it("可注入 = 通过门槛 AND 人工确认(两道闸缺一不可)", () => {
		const m = withData({ strategies: [strategy({ enabled: false })] });
		const row = m.strategyRows()[0]!;
		expect(row.promoted).toBe(true);
		expect(row.enabled).toBe(false);
		expect(row.injectable).toBe(false);
	});

	it("未通过门槛时即使人工确认也不可注入", () => {
		const m = withData({
			strategies: [
				strategy({ enabled: true, promotion: { promoted: false, value: 100, runs: 1, reason: "needs >= 2" } }),
			],
		});
		const row = m.strategyRows()[0]!;
		expect(row.injectable).toBe(false);
		expect(row.reason).toContain("needs >= 2");
	});

	it("两道闸都过才是 injectable,并计数", () => {
		const m = withData({
			strategies: [
				strategy({ id: "a", enabled: true }),
				strategy({ id: "b", enabled: false }),
			],
		});
		expect(m.strategyRows().find((s) => s.id === "a")!.injectable).toBe(true);
		expect(m.injectableCount()).toBe(1);
	});

	it("按价值降序", () => {
		const m = withData({
			strategies: [
				strategy({ id: "low", promotion: { promoted: true, value: 1, runs: 2, reason: "" } }),
				strategy({ id: "high", promotion: { promoted: true, value: 999, runs: 2, reason: "" } }),
			],
		});
		expect(m.strategyRows().map((s) => s.id)).toEqual(["high", "low"]);
	});

	it("参数渲染成可读的一行", () => {
		expect(withData({ strategies: [strategy()] }).strategyRows()[0]!.label).toBe(
			"build_bus_route (distance=24)",
		);
	});

	it("缺少 promotion 字段时保守处理(不假装已通过)", () => {
		const m = withData({ strategies: [{ id: "x", action: "a", params: {}, enabled: true }] });
		expect(m.strategyRows()[0]!.promoted).toBe(false);
		expect(m.strategyRows()[0]!.injectable).toBe(false);
	});

	it("容忍空/垃圾 strategies", () => {
		expect(withData({ strategies: [] }).strategyRows()).toEqual([]);
		expect(withData({ strategies: "nope" }).strategyRows()).toEqual([]);
	});
});

describe("evolution-view: 空态", () => {
	it("什么都没记录时明说为空", () => {
		const m = withData({ metrics: [], lessons: [], strategies: [] });
		expect(m.empty()).toBe(true);
	});

	it("加载中或出错时不算空态(避免闪一句'没有数据')", () => {
		const loading = load();
		loading.loading = true;
		expect(loading.empty()).toBe(false);
		const errored = load();
		errored.loading = false;
		errored.error = "boom";
		expect(errored.empty()).toBe(false);
	});

	it("有 metrics 就不算空", () => {
		expect(withData({ metrics: [METRIC()], lessons: [] }).empty()).toBe(false);
	});
});
