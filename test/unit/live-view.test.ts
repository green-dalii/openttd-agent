/**
 * Unit tests — the Live page view model.
 *
 * 职责: 在 `node:vm` 里加载**真实的页面 view model**，锁定它的推导与分派，
 *   不依赖浏览器、不依赖 Alpine。
 *
 * 为什么这样分层（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.4 阶段 4）:
 *   迁移到 Alpine 的风险不是"指令写错"，而是**把已有的业务规则弄丢**
 *   （哪些事件可见、成功/失败怎么判、空态该说什么、成本与结果怎么分开）。
 *   规则留在可测的纯函数里，模板退化为声明式渲染，规则就不会悄悄消失。
 *
 * 事实来源: docs/DASHBOARD-UI.md §5.1、docs/DASHBOARD-API.md §4（WS 帧形状）。
 * 禁止: 断言 Alpine 模板结构；只断言"给什么状态 → 得出什么显示值"。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/live-view.js"), "utf8");

/** Minimal UI stub: enough for the model's formatting calls. */
function uiStub() {
	return {
		fmtInt: (v: unknown) => (v === null || v === undefined ? "—" : String(v)),
		fmtMoney: (v: unknown) => `£${v}`,
		fmtTok: (v: unknown) => `${v}t`,
		fmtCost: (v: unknown) => `$${v}`,
		fmtDuration: (v: unknown) => `${v}ms`,
		fmtAgo: (v: unknown) => `${v}ago`,
		fmtClock: (v: unknown) => `c${v}`,
		fmtPct: (v: number, d?: number) => `${(v * 100).toFixed(d ?? 1)}%`,
		fmtGameDate: (v: unknown) => String(v),
		esc: (v: unknown) => String(v),
		pickColor: (_i: number) => "#5ac8fa",
		categoryOf: (k: unknown) => (k === "date" ? "time" : "other"),
		categoryLabel: (c: unknown) => String(c),
		categoryClass: (c: unknown) => `t-${c}`,
		categoryCounts: (evs: { kind?: unknown }[] | undefined) => {
			const counts: Record<string, number> = {};
			let total = 0;
			for (const e of evs ?? []) {
				const c = e.kind === "date" ? "time" : "other";
				counts[c] = (counts[c] || 0) + 1;
				total++;
			}
			return { counts, total, order: Object.keys(counts) };
		},
		eventMatches: (e: { kind?: unknown }, q: string) => !q || String(e.kind).includes(q),
		briefOf: (e: { kind?: unknown }) => `brief(${e.kind})`,
	};
}

interface LiveModel {
	// state
	companies: Record<string, unknown>;
	recent: unknown[];
	telemetry: unknown;
	steps: unknown[];
	thinking: unknown[];
	stages: unknown[];
	run: unknown;
	runControl: boolean;
	date: unknown;
	evSearch: string;
	evHidden: Set<string>;
	cashMetric: string;
	tokenMetric: string;
	stepFilter: string;
	// derivations
	primaryCompany(): Record<string, unknown>;
	primaryHistory(): Record<string, unknown>[];
	sparkSeries(metric?: string): number[];
	hasSpark(metric?: string): boolean;
	sparkSpecs(): ({ data: number[] } | null)[];
	resultKpis(): { k: string; v: string; hint?: string; spark?: string }[];
	costKpis(): { k: string; v: string; hint?: string }[];
	cashSeries(): { name: string; data: number[]; color: string }[];
	cashLabels(): string[];
	tokenSeries(): { name: string; color: string }[];
	tokenItems(): { label: string; values: number[]; sub: string }[];
	visibleSteps(): { kind: string; ok?: boolean }[];
	visibleEvents(): { kind: string }[];
	categoryChips(): { cat: string; label: string; n: number; off: boolean }[];
	notice(): { show: boolean; kind: string; title: string; body: string; canStart: boolean };
	nowSummary(): { state: string; brain: string; lastDecision: string; intent: string; action: string };
	memory: unknown;
	memoryInEffect(): {
		active: boolean;
		lessonsInjected: number;
		strategiesInjected: number;
		lessons: { text: string; outcome: string; confidence: string; evidence: string[] }[];
		strategies: { label: string }[];
		summary: string;
	};
	stageList(): unknown[];
	stageViewsNewestFirst(): { index?: number; image?: string }[];
	// 快照面板的默认上限（2026-09-22 实测：24 张时占整页 57%）
	stageViews: { index?: number; image?: string; gameDate?: string; phase?: string }[];
	stageViewsLimit: number;
	stageViewsExpanded: boolean;
	stageViewsShown(): { index?: number; image?: string; gameDate?: string; phase?: string }[];
	stageViewsHiddenCount(): number;
	/** 图表高度取自**视口高度**（不取自宽度——宽度会与滚动条形成闭环）。 */
	chartHeight(preferred?: number, viewportH?: number): number;
	// 时间线的默认上限（同一族：阶段总结随运行无限增长）
	stagesLimit: number;
	stagesExpanded: boolean;
	stagesShown(): unknown[];
	stagesHiddenCount(): number;
	companiesEmpty(): boolean;
	companyCards(): { id: string; name: string; isAi: boolean; neg: boolean; money: string; value: string; fleet: string }[];
	toggleCategorySet(cat: string): Set<string>;
	// New: action surface (AB-1 dashboard mirror)
	actionCatalog: unknown;
	actionSurface(): {
		actions: { name: string; effect: string; effectLabel: string; badgeClass: string; gateKey: string | null; gateReason: string; key: string }[];
		total: number;
		writes: number;
		conditional: number;
		summary: string;
	} | null;
}

/** The LiveView module itself (module-level pure helpers live on it). */
function liveViewModule(): { upsertStageView: (l: unknown, x: unknown) => unknown } {
	const sandbox: Record<string, unknown> = { console, JSON, Object, Array, Number, String, Math, Date, Set, Map, Intl };
	sandbox.UI = uiStub();
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return (sandbox.window as { LiveView: { upsertStageView: (l: unknown, x: unknown) => unknown } }).LiveView;
}

function load(): { model: LiveModel } {
	const sandbox: Record<string, unknown> = { console, JSON, Object, Array, Number, String, Math, Date, Set, Map, Intl };
	sandbox.UI = uiStub();
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const factory = (sandbox.window as { LiveView: { create: (seed?: unknown) => LiveModel } }).LiveView;
	return { model: factory.create() };
}

/** A company with economy + history, as the server sends it. */
function company(over: Record<string, unknown> = {}) {
	return {
		info: { name: "AI", isAi: true },
		economy: { money: 298825, loan: 300000, income: -1180, companyValue: 0 },
		stats: { vehicles: 4, stations: 2 },
		history: [
			{ year: 1950, month: 1, money: 100000, loan: 100000, income: 0 },
			{ year: 1950, month: 2, money: 250000, loan: 300000, income: -500 },
			{ year: 1950, month: 3, money: 298825, loan: 300000, income: -1180 },
		],
		...over,
	};
}

const TELEMETRY = {
	sessionId: "s1",
	brain: { kind: "real", provider: "custom", model: "m" },
	activeTurn: 2,
	turns: 3,
	lastActivityAt: 5000,
	totals: { decisions: 3, toolCalls: 4, toolFailures: 1 },
	usage: {
		total: { input: 3000, output: 60, reasoning: 15, cacheRead: 0, cacheWrite: 0, totalTokens: 3075, costTotal: 0.4 },
		byTurn: [
			{ turn: 1, steps: 2, usage: { input: 1000, output: 20, reasoning: 5, cacheRead: 0, totalTokens: 1025, costTotal: 0.1 } },
			{ turn: 2, steps: 1, usage: { input: 2000, output: 40, reasoning: 10, cacheRead: 0, totalTokens: 2050, costTotal: 0.3 } },
		],
		byTool: [{ tool: "build_bus_route", calls: 3, failures: 1, avgDurationMs: 1200 }],
	},
};

describe("Live view model", () => {
	describe("result vs cost are separate questions", () => {
		it("keeps the outcome KPIs free of cost metrics", () => {
			// "Is the company winning" and "what does it cost" are different
			// questions; mixing them in one strip is what made the page hard to read.
			const { model } = load();
			model.companies = { "0": company() };
			const keys = model.resultKpis().map((k) => k.k);
			expect(keys).toContain("Cash");
			expect(keys).toContain("Income / yr");
			expect(keys).not.toContain("Tokens used");
		});

		it("puts token spend in the cost group with tool calls", () => {
			const { model } = load();
			model.companies = { "0": company() };
			model.telemetry = TELEMETRY;
			const found = model.costKpis();
			expect(found.some((k) => k.k === "Tokens used")).toBe(true);
			expect(found.some((k) => k.k === "Tool calls")).toBe(true);
		});

		it("shows honest placeholders with no company yet", () => {
			const { model } = load();
			const kpis = model.resultKpis();
			expect(kpis.length).toBeGreaterThan(0);
			for (const k of kpis) expect(k.v, k.k).not.toContain("NaN");
		});
	});

	describe("cash history", () => {
		it("reads the selected metric from each history point", () => {
			const { model } = load();
			model.companies = { "0": company() };
			model.cashMetric = "money";
			expect(model.cashSeries()[0]!.data).toEqual([100000, 250000, 298825]);
			model.cashMetric = "loan";
			expect(model.cashSeries()[0]!.data).toEqual([100000, 300000, 300000]);
		});

		it("labels the axis with game dates, not indices", () => {
			const { model } = load();
			model.companies = { "0": company() };
			expect(model.cashLabels()).toEqual(["1950-01", "1950-02", "1950-03"]);
		});

		it("returns nothing (not NaN) before any company exists", () => {
			const { model } = load();
			expect(model.cashSeries()).toEqual([]);
			expect(model.cashLabels()).toEqual([]);
		});

		it("skips companies with no history so the chart does not show an empty series", () => {
			const { model } = load();
			model.companies = { "0": company(), "1": { info: { name: "B" }, history: [] } };
			expect(model.cashSeries()).toHaveLength(1);
		});
	});

	describe("token composition (stacked bars)", () => {
		it("splits each turn into input/output/reasoning/cache", () => {
			const { model } = load();
			model.telemetry = TELEMETRY;
			model.tokenMetric = "total";
			const items = model.tokenItems();
			expect(items).toHaveLength(2);
			expect(items[0]!.values).toEqual([1000, 20, 5, 0]);
			expect(items[0]!.label).toBe("T1");
		});

		it("switches to a single cost series when asked", () => {
			const { model } = load();
			model.telemetry = TELEMETRY;
			model.tokenMetric = "cost";
			expect(model.tokenSeries()).toHaveLength(1);
			expect(model.tokenItems()[0]!.values).toEqual([0.1]);
		});

		it("never emits NaN when a turn lacks usage", () => {
			// A blank chart with no error is the worst outcome; assert real numbers.
			const { model } = load();
			model.telemetry = { usage: { byTurn: [{ turn: 1 }] } };
			for (const v of model.tokenItems()[0]!.values) {
				expect(Number.isFinite(v)).toBe(true);
			}
		});

		it("has no items before the first turn", () => {
			const { model } = load();
			model.telemetry = { usage: {} };
			expect(model.tokenItems()).toEqual([]);
		});
	});

	describe("steps", () => {
		const STEPS = [
			{ kind: "message", turn: 1 },
			{ kind: "tool", turn: 1, ok: true },
			{ kind: "tool", turn: 2, ok: false },
		];

		it("shows everything by default", () => {
			const { model } = load();
			model.steps = STEPS;
			model.stepFilter = "all";
			expect(model.visibleSteps()).toHaveLength(3);
		});

		it("filters to LLM messages, tools, or failures", () => {
			const { model } = load();
			model.steps = STEPS;
			model.stepFilter = "message";
			expect(model.visibleSteps()).toHaveLength(1);
			model.stepFilter = "tool";
			expect(model.visibleSteps()).toHaveLength(2);
			model.stepFilter = "failed";
			expect(model.visibleSteps()).toHaveLength(1);
		});
	});

	describe("events", () => {
		const EVENTS = [
			{ kind: "date", seq: 1 },
			{ kind: "company_info", seq: 2 },
			{ kind: "date", seq: 3 },
		];

		it("counts categories for the filter chips", () => {
			const { model } = load();
			model.recent = EVENTS;
			const chips = model.categoryChips();
			expect(chips.map((c) => c.cat).sort()).toEqual(["other", "time"]);
			expect(chips.find((c) => c.cat === "time")!.n).toBe(2);
		});

		it("hides a category the user switched off", () => {
			const { model } = load();
			model.recent = EVENTS;
			model.evHidden = new Set(["time"]);
			expect(model.visibleEvents().map((e) => e.kind)).toEqual(["company_info"]);
		});

		it("searches across the brief", () => {
			const { model } = load();
			model.recent = EVENTS;
			model.evSearch = "company";
			expect(model.visibleEvents()).toHaveLength(1);
		});

		it("shows newest first, because this is a 'what just happened' feed", () => {
			const { model } = load();
			model.recent = EVENTS;
			expect(model.visibleEvents()[0]!.kind).toBe("date");
		});

		it("drops the oldest events rather than growing without bound", () => {
			const { model } = load();
			model.recent = Array.from({ length: 400 }, (_, i) => ({ kind: "date", seq: i }));
			expect(model.visibleEvents().length).toBeLessThanOrEqual(160);
		});

		it("marks a hidden category on its chip", () => {
			const { model } = load();
			model.recent = EVENTS;
			model.evHidden = new Set(["time"]);
			expect(model.categoryChips().find((c) => c.cat === "time")!.off).toBe(true);
		});
	});

	describe("notice (the honest empty state)", () => {
		it("says nothing when a real LLM is driving", () => {
			const { model } = load();
			model.telemetry = TELEMETRY;
			expect(model.notice().show).toBe(false);
		});

		it("explains an idle serve-mode page and offers to start", () => {
			// The empty panels are the symptom; this is the explanation.
			const { model } = load();
			model.runControl = true;
			model.run = { state: "idle" };
			const n = model.notice();
			expect(n.show).toBe(true);
			expect(n.title).toMatch(/no run/i);
			expect(n.canStart).toBe(true);
		});

		it("distinguishes 'no LLM' from 'no run'", () => {
			const { model } = load();
			model.runControl = true;
			model.run = { state: "running" };
			model.telemetry = { brain: { kind: "faux" } };
			const n = model.notice();
			expect(n.show).toBe(true);
			expect(n.title).not.toMatch(/no run/i);
			expect(n.body).toMatch(/observ|scripted/i);
		});

		it("surfaces a failed start in full", () => {
			const { model } = load();
			model.runControl = true;
			model.run = { state: "idle", error: "no provider/model configured" };
			const n = model.notice();
			expect(n.kind).toBe("err");
			expect(n.body).toContain("no provider/model configured");
		});

		it("tells the user how to get control when the server has none", () => {
			const { model } = load();
			model.runControl = false;
			const n = model.notice();
			expect(n.show).toBe(true);
			expect(n.canStart).toBe(false);
			// The instruction is rendered as a separate hint line, so assert on
			// everything the user is shown rather than on one field.
			expect(`${n.body} ${(n as { hint?: string }).hint ?? ""}`).toMatch(/--serve/);
		});
	});

	describe("now (the 'what is it doing' summary)", () => {
		it("reports the run state and the brain identity", () => {
			const { model } = load();
			model.runControl = true;
			model.run = { state: "running", mode: "agent" };
			model.telemetry = TELEMETRY;
			const n = model.nowSummary();
			expect(n.state).toBe("running");
			expect(n.brain).toMatch(/real/i);
		});

		it("flags a scripted demo so it is never mistaken for a real model", () => {
			const { model } = load();
			model.telemetry = { brain: { kind: "faux" } };
			expect(model.nowSummary().brain).toMatch(/scripted|not a real/i);
		});

		it("reports how long since the last decision, to expose a stuck agent", () => {
			const { model } = load();
			model.telemetry = { ...TELEMETRY, lastActivityAt: 1000 };
			expect(model.nowSummary().lastDecision).not.toBe("");
		});

		it("shows the latest intent and the latest action", () => {
			const { model } = load();
			model.steps = [
				{ kind: "message", turn: 1, text: "build a line between towns" },
				{ kind: "tool", turn: 1, tool: "build_bus_route", summary: "sent", ok: true },
			];
			const n = model.nowSummary();
			expect(n.intent).toContain("build a line");
			expect(n.action).toContain("build_bus_route");
		});

		it("says so rather than inventing something when there is no activity", () => {
			const { model } = load();
			const n = model.nowSummary();
			expect(n.intent).toMatch(/no .*(decision|activity|step)/i);
			expect(n.action).toBe("—");
		});
	});
});

describe("company cards", () => {
	it("lists every company, including the AI flag", () => {
		const { model } = load();
		model.companies = {
			"0": company(),
			"1": { info: { name: "Human", isAi: false }, economy: { money: 5 }, stats: {} },
		};
		const cards = model.companyCards();
		expect(cards).toHaveLength(2);
		expect(cards[0]!.isAi).toBe(true);
		expect(cards[1]!.isAi).toBe(false);
	});

	it("flags a negative balance so the card can be coloured", () => {
		const { model } = load();
		model.companies = { "0": company({ economy: { money: -5000 } }) };
		expect(model.companyCards()[0]!.neg).toBe(true);
	});

	it("copes with a company that has no info/economy/stats yet", () => {
		const { model } = load();
		model.companies = { "0": {} };
		const card = model.companyCards()[0]!;
		expect(card.name).toContain("Company 0");
		expect(card.money).not.toContain("NaN");
	});

	it("is empty when there is no company", () => {
		const { model } = load();
		expect(model.companyCards()).toEqual([]);
	});
});

describe("live-view: KPI sparkline series", () => {
	// Regression (2026-09-12): the rewrite left <canvas class="kpi-spark"> in the
	// template but dropped the U.paintSparks() call, so Cash and Income simply had
	// no trend line and nothing errored. Separately, hasHistory(metric) ignored its
	// argument and consulted the *selected* cash metric, so "Income / yr" claimed
	// history whenever Cash had any.
	function withHist(history: Record<string, number>[]) {
		const { model } = load();
		model.companies = { "0": company({ history }) } as unknown as Record<string, unknown>;
		return model;
	}

	it("sparkSeries returns the named metric, in order", () => {
		const m = withHist([
			{ money: 10, income: 1 },
			{ money: 20, income: 2 },
			{ money: 30, income: 3 },
		]);
		expect(m.sparkSeries("money")).toEqual([10, 20, 30]);
		expect(m.sparkSeries("income")).toEqual([1, 2, 3]);
	});

	it("sparkSeries drops non-finite points (missing metric must not become NaN)", () => {
		const m = withHist([{ money: 10 }, { money: 20 }, { money: 30 }]);
		expect(m.sparkSeries("income")).toEqual([]);
		expect(m.sparkSeries("money")).toEqual([10, 20, 30]);
	});

	it("sparkSeries tolerates no metric / no company", () => {
		expect(withHist([]).sparkSeries("money")).toEqual([]);
		expect(withHist([]).sparkSeries(undefined)).toEqual([]);
		const { model: empty } = load();
		expect(empty.sparkSeries("money") as unknown as number[]).toEqual([]);
	});

	it("hasSpark needs more than one point", () => {
		expect(withHist([{ money: 1 }]).hasSpark("money")).toBe(false);
		expect(withHist([{ money: 1 }, { money: 2 }]).hasSpark("money")).toBe(true);
	});

	it("hasSpark is per-metric, not per-selected-metric (the old bug)", () => {
		const m = withHist([{ money: 5 }, { money: 6 }]);
		expect(m.hasSpark("money")).toBe(true);
		// Cash has two points; Income has none. The old implementation returned true
		// for both because it looked at cashMetric.
		expect(m.hasSpark("income")).toBe(false);
	});

	it("sparkSpecs aligns to resultKpis order and is null where there is no series", () => {
		const m = withHist([{ money: 1, income: 2 }, { money: 3, income: 4 }]);
		const specs = m.sparkSpecs();
		const kpis = m.resultKpis();
		expect(specs.length).toBe(kpis.length);
		// Tile i and spec i must describe the same KPI - that is the invariant
		// UI.paintSparks relies on when it matches tiles positionally.
		kpis.forEach((k, i) => {
			if (specs[i]) expect(specs[i]!.data.length).toBeGreaterThan(1);
			else expect(k.spark ? m.hasSpark(k.spark) : false).toBe(false);
		});
	});

	it("sparkSpecs has no entry for KPIs without a spark field", () => {
		const m = withHist([{ money: 1, income: 2 }, { money: 3, income: 4 }]);
		const specs = m.sparkSpecs();
		m.resultKpis().forEach((k, i) => {
			if (!k.spark) expect(specs[i]).toBeNull();
		});
	});
});

describe("live-view: stage view upsert (Alpine :key must stay unique)", () => {
	// Regression (2026-09-12): onStage appended blindly, so a re-delivered frame
	// produced TWO entries with the same `index`. `index` is the Alpine x-for :key,
	// and duplicate keys made the stage list render ZERO nodes with no console error.
	function upsert(list: unknown, v: unknown) {
		const fn = liveViewModule().upsertStageView as (
			l: unknown,
			x: unknown,
		) => { index?: number; image?: string }[];
		return fn(list, v);
	}
	const stamp = (i: number, extra: Record<string, unknown> = {}) => ({ index: i, gameDate: "1950-01-01", ...extra });

	it("appends a new index", () => {
		const a = upsert([], stamp(0));
		expect(a).toHaveLength(1);
		const b = upsert(a, stamp(1));
		expect(b.map((x) => x.index)).toEqual([0, 1]);
	});

	it("replaces (not duplicates) a re-delivered index", () => {
		// the exact bug: same frame twice -> two entries, both index 0
		let list = upsert([], stamp(0));
		list = upsert(list, stamp(0));
		expect(list).toHaveLength(1);
		expect(new Set(list.map((x) => x.index)).size).toBe(list.length);
	});

	it("keeps the image when a later frame for the same index lacks it", () => {
		// stageImage frames carry only {index, file}; the body frame may arrive later
		let list = upsert([], stamp(0, { image: "000.png" }));
		list = upsert(list, stamp(0));
		expect(list[0]!.image).toBe("000.png");
	});

	it("lets a later frame supply the image", () => {
		let list = upsert([], stamp(0));
		list = upsert(list, stamp(0, { image: "000.png" }));
		expect(list[0]!.image).toBe("000.png");
	});

	it("never merges different indexes", () => {
		let list = upsert([], stamp(0, { image: "000.png" }));
		list = upsert(list, stamp(1, { image: "001.png" }));
		expect(list.map((x) => x.image)).toEqual(["000.png", "001.png"]);
	});

	it("is idempotent under repeated delivery (the double-listener case)", () => {
		let list: { index?: number }[] = [];
		for (let i = 0; i < 5; i++) list = upsert(list, stamp(3, { image: "003.png" }));
		expect(list).toHaveLength(1);
	});

	it("caps the list at 24 entries", () => {
		let list: { index?: number }[] = [];
		for (let i = 0; i < 40; i++) list = upsert(list, stamp(i));
		expect(list).toHaveLength(24);
		expect(list[list.length - 1]!.index).toBe(39);
	});

	it("ignores junk instead of throwing", () => {
		expect(upsert(undefined, undefined)).toEqual([]);
		expect(upsert([], null)).toEqual([]);
		expect(upsert([stamp(0)], undefined)).toHaveLength(1);
	});

	it("does not mutate the input array", () => {
		const original = [stamp(0)];
		const next = upsert(original, stamp(1));
		expect(original).toHaveLength(1);
		expect(next).toHaveLength(2);
	});
});

describe("live-view: memory in effect (本局被注入了什么)", () => {
	// The snapshot carries what this game was TOLD. The ledger only has a count, and
	// a count cannot tell you whether the intended lesson was the one injected - so
	// the page shows content. This is the surface that makes "is it wired?"
	// answerable by looking, rather than by reading logs.
	function withMemory(mem: unknown) {
		const { model } = load();
		model.memory = mem;
		return model;
	}

	it("没有记忆时明确说'什么都没注入',而不是留空", () => {
		const m = withMemory(null);
		const out = m.memoryInEffect();
		expect(out.active).toBe(false);
		expect(out.summary).toMatch(/nothing/i);
		expect(out.lessons).toEqual([]);
	});

	it("有记忆时给出计数与摘要", () => {
		const out = withMemory({
			lessonsInjected: 2,
			strategiesInjected: 1,
			lessons: [
				{ text: "build near towns", kind: "do", confidence: 0.8, evidence: ["money +1"] },
				{ text: "avoid long routes", kind: "dont", confidence: 0.5, evidence: ["money -1"] },
			],
			strategies: [{ action: "build_bus_route", params: { distance: 24 } }],
		}).memoryInEffect();
		expect(out.active).toBe(true);
		expect(out.lessonsInjected).toBe(2);
		expect(out.strategiesInjected).toBe(1);
		expect(out.lessons).toHaveLength(2);
		expect(out.summary).toContain("2");
	});

	it("保留实测读数与证据(用户要能判断这条经验是否可信)", () => {
		const out = withMemory({
			lessons: [
				{
					text: "routes longer than 200 tiles did not finish inside the horizon",
					outcome: { metric: "construction", before: 0, after: 1 },
					confidence: 0.5,
					evidence: ["road still building at the horizon"],
				},
			],
		}).memoryInEffect();
		// 面板把读数渲染成人读的一行（前端是 JS，无类型；这里锁的是**显示内容**）
		expect(out.lessons[0]!.outcome).toBe("construction 0 → 1");
		expect(out.lessons[0]!.evidence).toEqual(["road still building at the horizon"]);
	});

	it("策略卡渲染成可读的一行(含参数)", () => {
		const out = withMemory({
			strategies: [{ action: "build_bus_route", params: { distance: 24 } }],
		}).memoryInEffect();
		expect(out.strategies[0]!.label).toContain("build_bus_route");
		expect(out.strategies[0]!.label).toContain("distance=24");
	});

	it("计数缺失时回退到实际条目数(不显示 0 却有内容)", () => {
		const out = withMemory({ lessons: [{ text: "a", kind: "do", evidence: ["e"] }] }).memoryInEffect();
		expect(out.lessonsInjected).toBe(1);
		expect(out.active).toBe(true);
	});

	it("容忍垃圾/缺字段(不抛异常,不渲染空条目)", () => {
		const out = withMemory({
			lessons: [{}, null, { text: "  " }, { text: "ok", kind: "do", evidence: [] }],
			strategies: [null, { params: {} }, { action: "build_road" }],
		}).memoryInEffect();
		expect(out.lessons.map((l) => l.text)).toEqual(["ok"]);
		expect(out.strategies.map((s) => s.label)).toEqual(["build_road"]);
	});

	it("非数组字段不会炸掉渲染", () => {
		expect(() => withMemory({ lessons: "nope", strategies: 42 }).memoryInEffect()).not.toThrow();
		expect(withMemory({ lessons: "nope" }).memoryInEffect().lessons).toEqual([]);
	});
});

/**
 * 模板 ↔ 视图模型的交叉守卫（AGENTS §5.2）。
 *
 * 事故类型："静默缺失的 UI"——模板绑定到一个**已不存在的属性**时，
 * 渲染结果是空白/不显示，**控制台零报错**，单测与 lint 都抓不到。
 * R2 把 lesson 的 `kind` 换成 `outcome` 时，模板里还留着 `l.kind`：
 * 若不改，用户会看到一个空的 do/avoid 徽标而没有任何报警。
 * 这条测试把两边钉在一起：模板里对 lesson 用的每个字段，
 * 视图模型都必须真的产出。
 */
describe("live.html: 记忆面板绑定与视图模型一致", () => {
	it("模板对 lesson 绑定的字段都存在于 memoryInEffect() 的输出里", () => {
		const html = readFileSync(join(PUBLIC_DIR, "pages", "live.html"), "utf8");
		const block = html.slice(html.indexOf("mem-list"), html.indexOf("memoryInEffect().strategies"));
		const bound = new Set<string>();
		for (const m of block.matchAll(/\bl\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) bound.add(m[1]!);
		expect(bound.size).toBeGreaterThan(0);

		const { model } = load();
		model.memory = {
			lessons: [
				{
					text: "the route delivered 137 units in 300 game days",
					outcome: { metric: "delivered", before: 0, after: 137 },
					confidence: 0.6,
					evidence: ["delivered 137"],
				},
			],
		};
		const out = model.memoryInEffect();
		const lesson = out.lessons[0]! as unknown as Record<string, unknown>;
		for (const key of bound) {
			expect(Object.prototype.hasOwnProperty.call(lesson, key), `模板绑定了 l.${key}，视图模型必须提供`).toBe(true);
		}
		// 旧的 do/dont 语义不许再出现在模板里（它是指令，不是读数）
		expect(block).not.toMatch(/l\.kind|mem-do|mem-dont/);
	});
});

/**
 * Action surface panel (AB-1 dashboard mirror) — 运营者要能**看到** agent 现在能做什么。
 *
 * 锁的事项：列表必须从 `/api/capabilities` 的形状派生（name/effect/gate），不能凭空写。
 * 写动作、读动作、有门控的动作要分开计数；空目录也要可渲染（不崩）。
 */
describe("live-view: action surface panel", () => {
	// Same shape as /api/capabilities: { actions: [{name, effect, gate}], generatedFrom }.
	function withCatalog(payload: unknown) {
		const { model } = load();
		model.actionCatalog = payload;
		return model;
	}

	it("derives counts from the catalog (read/write/conditional)", () => {
		// Three reads + two writes + one gated tool = the kind of mixed surface a
		// real run exposes (e.g. observe, capabilities, recall are read; build/set
		// are write; recall is gated by memory).
		const m = withCatalog({
			actions: [
				{ name: "observe", effect: "read", gate: null },
				{ name: "estimate_route", effect: "read", gate: null },
				{ name: "capabilities", effect: "read", gate: null },
				{ name: "build_bus_route", effect: "write", gate: null },
				{ name: "set_route_vehicles", effect: "write", gate: null },
				{ name: "recall", effect: "read", gate: { key: "memory", reason: "no memory is available" } },
			],
		});
		const out = m.actionSurface();
		expect(out).not.toBeNull();
		expect(out!.total).toBe(6);
		expect(out!.writes).toBe(2);
		expect(out!.conditional).toBe(1);
		// The summary line is what the panel header renders; do not let it drift.
		expect(out!.summary).toBe("6 action(s) · 2 change game state · 1 conditional");
	});

	it("shows the gate reason for conditional actions (operator must know why)", () => {
		// 不说原因的门控就是隐藏状态——AB-1 的根本动机。
		const m = withCatalog({
			actions: [
				{ name: "inspect_route", effect: "read", gate: { key: "gs_channel", reason: "route economics are not available" } },
			],
		});
		const out = m.actionSurface();
		expect(out!.actions[0]!.gateKey).toBe("gs_channel");
		expect(out!.actions[0]!.gateReason).toMatch(/route economics/);
	});

	it("returns null (not {}) when the catalog is empty/absent so the panel stays hidden", () => {
		// Page contract: server returns 404 when the hook is absent (no LLM brain
		// wired). The panel must not render an empty list pretending to be the
		// surface — that would be a UI lie about capability.
		const m = withCatalog(null);
		expect(m.actionSurface()).toBeNull();

		const m2 = withCatalog({ actions: [] });
		// Empty list is still a valid catalog but renders nothing useful; we
		// surface it as null so the panel stays hidden rather than showing "0
		// actions" (the panel's header line — "N action(s) ..." — would otherwise
		// collide with this empty-list case).
		expect(m2.actionSurface()).toBeNull();
	});

	it("keys items by name so Alpine's :key stays unique", () => {
		// If two rows share a :key, the whole list renders zero nodes (live-view's
		// own stage-view upsert test covers the same invariant for stages). The
		// view model must not produce duplicate keys.
		const m = withCatalog({
			actions: [
				{ name: "observe", effect: "read", gate: null },
				{ name: "build_bus_route", effect: "write", gate: null },
				{ name: "set_pause", effect: "write", gate: null },
			],
		});
		const out = m.actionSurface();
		const keys = out!.actions.map((a) => a.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("labels every write action so the badge is human-readable", () => {
		// The badge text is the only thing telling the operator "this changes the
		// game state" — without it, the read/write split is invisible.
		const m = withCatalog({
			actions: [
				{ name: "observe", effect: "read", gate: null },
				{ name: "build_bus_route", effect: "write", gate: null },
				{ name: "retire_route", effect: "write", gate: null },
			],
		});
		const out = m.actionSurface();
		for (const a of out!.actions) {
			expect(a.effectLabel.length).toBeGreaterThan(0);
			expect(a.badgeClass).toMatch(/^tag-(read|write)$/);
		}
		const writes = out!.actions.filter((a) => a.effect === "write");
		for (const w of writes) {
			expect(w.effectLabel).toBe("changes game state");
			expect(w.badgeClass).toBe("tag-write");
		}
	});
});

/**
 * Stage views 的**渲染上限**（2026-09-22 用户实测）。
 *
 * 快照每到一个施工相位就多一张，真机量到 24 张时该面板 **4317px**、占整页 **57%**
 * （整页 7639px ≈ 8.5 屏），而每张缩略图只有 ~310px 宽。数量随运行时长无限增长，
 * 所以默认视图必须有上限——但**上限不是删数据**：展开后必须全给。
 */
describe("stage views 默认只渲染最新若干张", () => {
	function withViews(n: number) {
		const { model } = load();
		model.stageViews = Array.from({ length: n }, (_, i) => ({
			index: i,
			gameDate: "1950-0" + (i + 1),
			phase: "st" + i,
		}));
		return model;
	}

	it("默认只给最新 N 张，且是**最新**的（顺序不能反）", () => {
		const m = withViews(24);
		const shown = m.stageViewsShown();
		expect(shown.length).toBe(m.stageViewsLimit);
		// 最新在前：索引最大的那个必须在第一位
		expect(shown[0]!.index).toBe(23);
		expect(shown.map((v) => v.index)).toEqual([23, 22, 21, 20, 19, 18]);
	});

	it("未显示的张数可被读出（按钮文案要用它）", () => {
		expect(withViews(24).stageViewsHiddenCount()).toBe(24 - 6);
		expect(withViews(3).stageViewsHiddenCount()).toBe(0);
	});

	it("展开后**全部**都给（上限是默认视图，不是删数据）", () => {
		const m = withViews(24);
		m.stageViewsExpanded = true;
		expect(m.stageViewsShown().length).toBe(24);
		expect(m.stageViewsHiddenCount()).toBe(0);
	});

	it("没有快照时返回空数组而不是 null（x-for 不得穿过可空表达式）", () => {
		const { model } = load();
		expect(model.stageViewsShown()).toEqual([]);
	});
});

/**
 * 事件列表的**引用稳定性**（2026-09-22 实测 13,000+ 次 DOM 变更/秒的根因）。
 *
 * `onSnapshot` 每帧赋一个新数组 → Alpine 的 x-for 整表重渲染 → docH 抖动 131px →
 * 滚动锚定把这 131px 原样转嫁成用户的滚动漂移（"页面自己在滚"）。
 * 事件是追加的，所以"长度 + 末尾序号相同"就等价，此时必须**保持同一个引用**。
 */
describe("sameEventList: 等价就不换引用", () => {
	function model() {
		return load().model as unknown as { sameEventList: (a: unknown, b: unknown) => boolean };
	}
	function make(n: number) {
		return Array.from({ length: n }, (_, i) => ({ seq: i + 1, kind: "date", text: "e" + i }));
	}

	it("同样的内容（不同数组实例）判为等价", () => {
		const a = make(3);
		const b = make(3); // 内容一样、实例不同
		expect(a === b).toBe(false);
		expect(model().sameEventList(a, b)).toBe(true);
	});

	it("长度不同就不同", () => {
		expect(model().sameEventList(make(3), make(4))).toBe(false);
	});

	it("末尾事件变了就不同", () => {
		const a = make(3);
		const b = make(3);
		b[2]!.seq = 99;
		expect(model().sameEventList(a, b)).toBe(false);
	});

	it("末尾文本长大了就不同（同一事件在流式增长）", () => {
		const a = make(2);
		const b = make(2);
		b[1]!.text = "e1 plus more";
		expect(model().sameEventList(a, b)).toBe(false);
	});

	it("空数组/非数组不抛错（快照字段缺失是常态）", () => {
		expect(model().sameEventList([], [])).toBe(true);
		expect(model().sameEventList(undefined, [])).toBe(true);
		expect(model().sameEventList(null, make(1))).toBe(false);
	});
});

/**
 * 阶段总结时间线的默认上限（与 Stage views 同一族问题）。
 * 真机量到 46 段 = 2254px，占整页三分之一，而它只是"已经做了什么"的清单。
 */
describe("时间线默认只渲染最新若干段", () => {
	function withStages(n: number) {
		const { model } = load();
		model.stages = Array.from({ length: n }, (_, i) => ({ gameDate: "1950-0" + (i + 1), turn: i, note: "n" + i }));
		return model;
	}

	it("默认给最新 N 段，且最新在前", () => {
		const m = withStages(46);
		const shown = m.stagesShown() as { turn: number }[];
		expect(shown.length).toBe(m.stagesLimit);
		expect(shown[0]!.turn).toBe(45);
	});

	it("未显示段数可读（按钮文案要用）", () => {
		expect(withStages(46).stagesHiddenCount()).toBe(46 - 8);
		expect(withStages(2).stagesHiddenCount()).toBe(0);
	});

	it("展开后全部给（上限不是丢数据）", () => {
		const m = withStages(46);
		m.stagesExpanded = true;
		expect(m.stagesShown().length).toBe(46);
	});

	it("无数据时给空数组（x-for 不得穿过可空表达式）", () => {
		const { model } = load();
		expect(model.stagesShown()).toEqual([]);
	});
});

/**
 * `chartHeight`：高度取自**视口高度**，且有上下限。
 *
 * 用户实测"Result 图表子图过长（纵向）"：写死 260px 在 720p 窗口上等于半屏。
 * 关键约束是**不能取自宽度**——高度依赖宽度 + 滚动条占宽度 = 闭环振荡
 *（宽度变→高度变→文档高变→滚动条状态变）。这里把这条写进测试。
 */
describe("chartHeight: 跟随视口高度", () => {
	function h(preferred: number, viewportH: number): number {
		return (load().model as unknown as { chartHeight(p?: number, v?: number): number }).chartHeight(
			preferred,
			viewportH,
		);
	}

	it("矮窗口变矮（720p 下 260 的请求被压到 245）", () => {
		expect(h(260, 720)).toBe(216);
		expect(h(260, 720)).toBeLessThan(260);
	});

	it("高窗口不超过请求值（不无限长）", () => {
		expect(h(260, 2000)).toBe(260);
		expect(h(220, 1200)).toBe(220);
	});

	it("极小窗口也有下限（不能压成一条线）", () => {
		expect(h(260, 300)).toBe(160);
	});
});
