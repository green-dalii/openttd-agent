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

interface RouteRow {
	_job: number;
	_vehicles: number;
	_waiting: number;
	_income: number | null;
	_profit: number | null;
	idle: boolean;
	income: string;
	incomeHint?: string;
	profit: string;
	profitHint?: string;
	endpoints: string;
	endpointsHint?: string;
	key: string;
}

interface LiveModel {
	// state
	companies: Record<string, unknown>;
	recent: { kind?: string; ts?: number; payload?: { raw?: number; year?: number; month?: number; day?: number } }[];
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
	companyValueKnown(raw: unknown): boolean;
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
	routes: unknown[];
	routesAvailable: boolean;
	routeSortKey: "income" | "job" | "vehicles" | "waiting" | "profit";
	routeSortDir: "asc" | "desc";
	routeRows(): RouteRow[];
	routesSorted(): RouteRow[];
	routesSummary(): {
		available: boolean;
		count: number;
		running: number;
		vehicles: number;
		waiting: number;
		vehiclesDeduplicated?: boolean;
		waitingDeduplicated?: boolean;
		stops?: number;
	};
	/** 数据新鲜度（连接活着 ≠ 数据在流）。 */
	lastFrameAt: number | null;
	link: string;
	dataAge(nowMs?: number): { text: string; tone: string };
	routesNote(): string;
	/** 城镇（Bridge GS 取样：人口前 10） */
	townsRows(): { key: string; id: unknown; population: string; at: string; _population: number }[];
	townsSummary(): { available: boolean; shown: number; total: number | null; shownPopulation: number };
	townsNote(): string;
	townsEmpty(): string;
	townsSampleNote(): string;
	/** 抽屉空态文案（fleet 与 routes 是两个不同的问题） */
	drawerEmptyText(): string;
	/** 产业/货种/公司口径（P1+P2） */
	industries: { id?: unknown; cargo?: unknown; name?: unknown; produced?: unknown; transported?: unknown; stock?: unknown }[];
	industriesTotal: unknown;
	cargoTotals: { label?: unknown; produced?: unknown; transported?: unknown }[];
	industryAvailable: boolean;
	companyCargo: { byCargo?: { label?: string; amount?: number }[]; quarterDelivered?: number | null; monitored?: { towns: number; industries: number } | null } | null;
	companyCargoAvailable: boolean;
	cargoName(label: unknown): string;
	cargoSharePct(produced: unknown, transported: unknown): number | null;
	cargoRows(): { key: string; label: string; name: string; produced: string; transported: string; share: string; shareHint: string }[];
	industryRows(): { key: string; id: unknown; name: string; cargo: string; produced: string; transported: string; stock: string }[];
	industrySampleNote(): string;
	industryNote(): string;
	industryEmpty(): string;
	ownCargoRows(): { key: string; name: string; label: string; amount: string }[];
	ownCargoNote(): string;
	ownQuarterText(): string;
	ownDeliveredTotal(): string;
	/** 可视化的数据源（2026-09-25） */
	worldRate(nowMs?: number): { advancing: boolean; daysPerMin: number | null; lastAt: number | null; samples: number };
	fleetMix(): {
		vehicles: { parts: { label: string; n: number; pct: number | null }[]; total: number };
		stations: { parts: { label: string; n: number; pct: number | null }[]; total: number };
		companies: number;
	};
	performance(): { last: number | null; prev: number | null; delta: number | null; max: number; known: boolean };
	runHealth(nowMs?: number): {
		state: string;
		tiles: { k: string; v: string; state: string; hint: string }[];
		action: string;
		rate: { advancing: boolean; daysPerMin: number | null };
	};
	channelAlive(nowMs?: number): boolean;
	healthTiles(): { k: string; v: string; state: string; hint: string }[];
	worldAdvancing(nowMs?: number): boolean;
	mixRows(): { k: string; total: number; parts: { label: string; n: number; pct: number | null; color: string }[] }[];
	drawerShowsRoutes(): boolean;
	drawerRouteRows(): RouteRow[];
	controlNote(nowMs?: number): string;
	stalled(nowMs?: number): boolean;
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
	chartHeight(preferred?: number): number;
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
	/** 暂停归因（snapshot.control） */
	control: { pausedByAgent?: boolean; agentPausedAt?: number | null } | null;
	/** 城镇样本（Bridge GS：人口前 10） */
	towns: { id?: unknown; population?: unknown; x?: unknown; y?: unknown }[];
	townsTotal: unknown;
	townsAvailable: boolean;
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
		it("splits each turn into input/output/cache（**全零序列从图例中剔除**）", () => {
			// 2026-09-23：5.7h 长跑里 `reasoning` 恒为 0，但旧契约仍把它放进图例与堆叠，
			// 占用空间且让真实序列难以分辨。新契约：series 若所有 turn 都为 0，就不出场。
			const { model } = load();
			model.telemetry = TELEMETRY;
			model.tokenMetric = "total";
			const items = model.tokenItems();
			expect(items).toHaveLength(2);
			// fixture 里 reasoning 列恒 0，应被剔除；剩下 [input, output, cache] 三个数值
			expect(items[0]!.values).toEqual([1000, 20, 5]);
			expect(items[0]!.label).toBe("T1");
		});

		it("**全零序列的剔除是可重放的**（2026-09-22 长跑 reasoning 恒 0）", () => {
			const { model } = load();
			model.telemetry = {
				usage: {
					byTurn: [
						{ turn: 1, usage: { input: 100, output: 10, reasoning: 0, cacheRead: 0 } },
						{ turn: 2, usage: { input: 200, output: 20, reasoning: 0, cacheRead: 0 } },
					],
				},
			};
			model.tokenMetric = "total";
			const items = model.tokenItems();
			expect(items[0]!.values).toEqual([100, 10]); // reasoning 0 + cache 0 → 两者都被剔除
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
 * `chartHeight`：**固定高度**，与视口/宽度/内容无关。
 *
 * 为什么改成固定（2026-09-23）：高度一旦参与按需计算，就多一条反馈通道
 * （高度 → 文档高 → 滚动条 → 宽度 → 布局 → 高度）。用户的原话是
 * "难道不应该是固定高度吗"——固定高度让这条通道在结构上不存在。
 */
describe("chartHeight: 固定高度", () => {
	const h = (p?: number) => (load().model as unknown as { chartHeight(p?: number): number }).chartHeight(p);

	it("**不看视口**：同一个 preferred 在任何窗口下都返回同一个值", () => {
		// 旧实现读 window.innerHeight：这条断言就是它的墓碑。
		const values = new Set([h(260), h(260), h(260)]);
		expect([...values]).toEqual([260]);
	});

	it("上下限：不低于 160，不高于 260（无参默认 260）", () => {
		expect(h(80)).toBe(160);
		expect(h(600)).toBe(260);
		expect(h(undefined)).toBe(260);
		expect(h(220)).toBe(220);
	});
});
describe("routeRows / routesSorted / routesNote（仪表盘线路面板）", () => {
	const sampleRoutes = [
		{ job: 103, vehicles: 0, waiting: 0, profitYtd: 0, incomePerDay: null, townA: 4, townB: 20 },
		{ job: 100, vehicles: 6, waiting: 12, profitYtd: 3650, incomePerDay: 18.25, townA: 4, townB: 20 },
		{ job: 101, vehicles: 4, waiting: 11, profitYtd: -1, incomePerDay: null, townA: 4, townB: 20 },
		{ job: 999, vehicles: 3, waiting: 0, profitYtd: 200, incomePerDay: 10 },
	];
	function makeView() { return load().model; }

	it("routeRows：没有车 → idle 标记 + 不可测的诚实说明", () => {
		const v = makeView();
		v.routes = sampleRoutes; v.routesAvailable = true;
		const r = v.routeRows().find((x) => x._job === 103)!;
		expect(r.idle).toBe(true);
		expect(r.income).toBe("—");
		expect(r.incomeHint).toMatch(/no vehicles/);
	});

	it("routeRows：profitYtd = -1 → '—'，不编造亏损", () => {
		const v = makeView();
		v.routes = sampleRoutes; v.routesAvailable = true;
		const r = v.routeRows().find((x) => x._job === 101)!;
		expect(r.profit).toBe("—");
		expect(r.profitHint).toMatch(/not readable/);
	});

	it("routeRows：账本未知的 job → 端点显示 '—'，且给一句说明（**不编造城镇对**）", () => {
		const v = makeView();
		v.routes = sampleRoutes; v.routesAvailable = true;
		const r = v.routeRows().find((x) => x._job === 999)!;
		expect(r.endpoints).toBe("—");
		expect(r.endpointsHint).toMatch(/endpoints unknown/);
	});

	it("routesSorted：**`null` 永远排最后**（升序也排最后，不是最小值）", () => {
		const v = makeView();
		v.routes = sampleRoutes; v.routesAvailable = true;
		v.routeSortKey = "income"; v.routeSortDir = "asc";
		const jobs = v.routesSorted().map((r) => r._job);
		expect(jobs.slice(-2).sort()).toEqual([101, 103]);
		expect(jobs[0]).toBe(999);
	});

	it("routesNote：routesAvailable=false → 「不可得」提示，**不是**「0 条线路」", () => {
		const v = makeView();
		v.routes = []; v.routesAvailable = false;
		expect(v.routesNote()).toMatch(/unavailable/);
	});

	it("routesNote：可得的空数据 → 「还没建线」，与不可得区分", () => {
		const v = makeView();
		v.routes = []; v.routesAvailable = true;
		expect(v.routesNote()).toMatch(/No routes yet/);
	});
});

describe("controlNote / stalled（页面要说出「为什么不动了」）", () => {
	function makeView() { return load().model; }

	it("pausedBy='agent' → 明确说 agent 自己（set_pause）", () => {
		const v = makeView();
		v.run = { state: "paused", pausedBy: "agent", pausedAt: Date.now() - 5 * 60 * 1000 };
		expect(v.controlNote()).toMatch(/agent itself.*set_pause/i);
	});

	it("pausedBy='dashboard' → 明确说由仪表盘按钮", () => {
		const v = makeView();
		v.run = { state: "paused", pausedBy: "dashboard", pausedAt: Date.now() };
		expect(v.controlNote()).toMatch(/the dashboard/);
	});

	it("running、世界不推进、agent 久无活动、通道仍在 → 停滞告警", () => {
		const v = makeView();
		const old = Date.now() - 20 * 60 * 1000;
		v.run = { state: "running" };
		v.telemetry = { lastActivityAt: old };
		// 通道仍在收数据，但**没有 date 事件**（世界被冻住）——这才是"停滞"的证据。
		v.recent = [
			{ kind: "date", ts: old },
			{ kind: "company_stats", ts: Date.now() - 2_000 },
		];
		expect(v.stalled()).toBe(true);
		expect(v.controlNote()).toMatch(/stalled/i);
	});

	it("没有事件证据时不猜原因（刚重载的页面不闪假告警）", () => {
		const v = makeView();
		v.run = { state: "running" };
		v.telemetry = { lastActivityAt: Date.now() - 20 * 60 * 1000 };
		v.recent = [];
		expect(v.controlNote()).toBe("");
	});

	it("running 且最近有决策 → 不告警", () => {
		const v = makeView();
		v.run = { state: "running" };
		v.telemetry = { lastActivityAt: Date.now() - 30_000 };
		expect(v.stalled()).toBe(false);
		expect(v.controlNote()).toBe("");
	});

	it("paused → 停滞判定不应触发（paused 另有说明）", () => {
		const v = makeView();
		v.run = { state: "paused" };
		v.telemetry = { lastActivityAt: Date.now() - 99 * 60 * 1000 };
		expect(v.stalled()).toBe(false);
	});
});

describe("companyValue 占位值", () => {
	it("占位值 1 / 缺失 → 不显示数字", () => {
		const v = load().model;
		for (const raw of [1, 0, -5, undefined, null, Number.NaN]) {
			expect(v.companyValueKnown(raw), `${raw} 应判为未知`).toBe(false);
		}
	});

	it("真实价值 → 显示", () => {
		const v = load().model;
		expect(v.companyValueKnown(250_000)).toBe(true);
		expect(v.companyValueKnown("1") === false, "字符串 \"1\" 同样是占位值").toBe(true);
	});
});

/**
 * 城镇面板（Bridge GS 取样）。
 *
 * 为什么单独立项（2026-09-25 用户实测）：后端**一直在采**城镇
 * （`bridge-gs/main.nut` 的 `town_list`，`world-state.ts` 的 `TownInfo`），
 * 但 `toWireSnapshot` 从没把它发出去 —— 页面因此永远是空的。
 * 这里锁定"发出来之后怎么显示"，以及两条诚实规则：
 * ① 取样 ≠ 全图（样本量与地图总数分开）；② "读不到" ≠ "零个城镇"。
 */
describe("live-view: towns", () => {
	it("按人口降序渲染，并把样本与全图分开（不说'这些就是全图'）", () => {
		const { model } = load();
		model.townsAvailable = true;
		model.townsTotal = 40;
		model.towns = [
			{ id: 4, population: 700, x: 10, y: 20 },
			{ id: 9, population: 2400, x: 30, y: 40 },
		];
		const rows = model.townsRows();
		expect(rows.map((r) => r.id)).toEqual([9, 4]);
		expect(rows[0]!.at).toBe("30, 40");
		const s = model.townsSummary();
		expect(s.total).toBe(40); // 地图总数
		expect(s.shown).toBe(2); // 只是样本
		expect(s.shownPopulation).toBe(3100);
		expect(model.townsSampleNote()).toContain("largest 2 of 40");
		expect(model.townsSampleNote()).toContain("not the whole map");
	});

	it("townsAvailable=false 是'这个 run 读不到'，不是'地图上没有城镇'", () => {
		const { model } = load();
		model.townsAvailable = false;
		const note = model.townsNote();
		expect(note).not.toBe(""); // 非空 = 面板显示说明而不是空表
		expect(note).toMatch(/Bridge GS|agent mode/);
		// 没有通道时不能把未知总数说成 0
		expect(model.townsSummary().total).toBeNull();
	});

	it("有通道但还没样本时：说明会来，而不是留一张空白表", () => {
		const { model } = load();
		model.townsAvailable = true;
		model.towns = [];
		expect(model.townsNote()).toBe(""); // 表要显示
		expect(model.townsRows()).toEqual([]);
		expect(model.townsSampleNote()).toBe(""); // 半句话不留
		expect(model.townsEmpty()).toMatch(/GS publishes/);
	});

	it("人口缺失时显示 —（而不是 0 —— 那会变成一个假的数字）", () => {
		const { model } = load();
		model.townsAvailable = true;
		model.towns = [{ id: 1, population: undefined, x: 1, y: 2 }];
		expect(model.townsRows()[0]!.population).toBe("—");
	});
});

/**
 * 产业/货种/公司口径的**派生规则**（P1+P2）。
 *
 * 为什么派生放在这里而不是 GS：比率有两种口径（产业口径 = 所有公司 /
 * 公司口径 = 本公司的 monitor 累计）。把它算进管道就等于把口径藏起来；
 * 放在可单测的纯函数里，口径必须显式出现在函数名和 UI 文案上（SPEC §10.99）。
 */
describe("live-view: cargo & industry", () => {
	it("产业口径：share = transported / produced（produced=0 时是 null，不是 0%）", () => {
		const { model } = load();
		model.industryAvailable = true;
		model.cargoTotals = [
			{ label: "COAL", produced: 900, transported: 600 },
			{ label: "PASS", produced: 0, transported: 0 },
		];
		const rows = model.cargoRows();
		expect(rows[0]!.label).toBe("COAL");
		expect(rows[0]!.share).toBe("67%");
		expect(rows[0]!.shareHint).toMatch(/all companies/i);
		expect(rows[1]!.share).toBe("—");
	});

	it("产业表按产量降序，并给出取样说明（largest N of M）", () => {
		const { model } = load();
		model.industryAvailable = true;
		model.industriesTotal = 37;
		model.industries = [
			{ id: 1, cargo: "PASS", name: "Town", produced: 10, transported: 4, stock: null },
			{ id: 2, cargo: "COAL", name: "Coal Mine", produced: 900, transported: 600, stock: 120 },
		];
		const rows = model.industryRows();
		expect(rows.map((r) => r.id)).toEqual([2, 1]);
		expect(rows[0]!.stock).toBe("120");
		expect(rows[1]!.stock).toBe("—");
		expect(model.industrySampleNote()).toContain("largest 2 of 37");
		expect(model.industrySampleNote()).toMatch(/not the whole map|sampled/i);
	});

	it("公司口径：分开呈现，并写明被监视的目的地数（不说成全部交付）", () => {
		const { model } = load();
		model.companyCargoAvailable = true;
		model.companyCargo = { byCargo: [{ label: "PASS", amount: 120 }], quarterDelivered: 5000, monitored: { towns: 10, industries: 0 } };
		expect(model.ownCargoRows()[0]!.amount).toBe("120");
		expect(model.ownCargoNote()).toMatch(/this company/i);
		expect(model.ownCargoNote()).toMatch(/10 towns|monitored/i);
		// 测试桩的 fmtInt 不做千分位（生产实现会），所以这里断言数值本身
		expect(model.ownQuarterText()).toContain("5000");
	});

	it("货种标签归一化：GS 的定长标签（OIL_）→ 友好名（Oil）", () => {
		const { model } = load();
		expect(model.cargoName("OIL_")).toBe("Oil");
		expect(model.cargoName("PASS")).toBe("Passengers");
		expect(model.cargoName("GOOD")).toBe("Goods");
		// 未知标签原样显示（不编名字）
		expect(model.cargoName("ZZZZ")).toBe("ZZZZ");
	});

	it("本公司交付合计：有数据时求和，未收到时 —（不是 0）", () => {
		const { model } = load();
		model.companyCargoAvailable = true;
		model.companyCargo = { byCargo: [{ label: "PASS", amount: 120 }, { label: "COAL", amount: 30 }], quarterDelivered: 900, monitored: { towns: 3, industries: 1 } };
		expect(model.ownDeliveredTotal()).toBe("150");
		// 有通道但还没交付：0 是真实测量值（不是"未知"）
		model.companyCargo = { byCargo: [], quarterDelivered: 0, monitored: { towns: 1, industries: 1 } };
		expect(model.ownDeliveredTotal()).toBe("0");
		model.companyCargoAvailable = false;
		expect(model.ownDeliveredTotal()).toBe("—");
	});

	it("watch 模式：三个口径都显示读不到，且不给 0", () => {
		const { model } = load();
		model.industryAvailable = false;
		model.companyCargoAvailable = false;
		expect(model.industryNote()).toMatch(/Bridge GS|agent mode/);
		expect(model.cargoRows()).toEqual([]);
		expect(model.industryRows()).toEqual([]);
		expect(model.ownCargoRows()).toEqual([]);
		expect(model.ownQuarterText()).toBe("—");
	});
});

/**
 * 为什么"没有进展"——**按世界的证据**分因，而不是一句通用话（2026-09-25 真机）。
 *
 * 事故：agent 在 turn 22 调 `set_pause` 自己冻结了世界。此后进程活着、心跳正常、
 * company 事件照收，但游戏日期永远不再推进 → 没有决策触发。页面当时只显示
 * "No decision for 1 hour… treat this as stalled" —— **没有说出真正的原因**
 * （是 agent 自己停的），用户无从判断该按 Resume 还是该等模型。
 *
 * 新的判据全部来自**世界事实**（不依赖谁写了 run 状态）：
 * ① `control.pausedByAgent`（快照自带，后端记录）→ "agent 自己停的"
 * ② 最近有没有 `date` 事件（世界是否还在推进）
 * ③ agent 最近有没有 step（模型是否还在忙）
 * 三者组合出**互斥**的原因，且每条都带"该做什么"的下一步。
 */
describe("live-view: 没进展的分因诊断（controlNote）", () => {
	const NOW = 1_000_000_000_000;

	it("agent 自己按了暂停（快照事实）→ 直说是它停的，并给 Resume 下一步", () => {
		const { model } = load();
		model.run = { state: "running", pausedBy: null, pausedAt: null };
		model.control = { pausedByAgent: true, agentPausedAt: NOW - 3_600_000 };
		model.telemetry = { lastActivityAt: NOW - 3_600_000, steps: [] };
		model.recent = [];
		const note = model.controlNote(NOW);
		expect(note).toMatch(/agent/i);
		expect(note).toMatch(/paused|pause/i);
		expect(note).toMatch(/resume/i);
	});

	it("世界不推进但模型刚有活动 → '模型还在这一轮里'，不是停滞", () => {
		const { model } = load();
		model.run = { state: "running" };
		model.control = { pausedByAgent: false, agentPausedAt: null };
		model.telemetry = { lastActivityAt: NOW - 30_000, steps: [] };
		// 真实现场（2026-09-25 僵尸局）：company 事件仍在每秒到达，但**没有新的 date**
		model.recent = [
			{ kind: "date", ts: NOW - 3_600_000 },
			{ kind: "company_stats", ts: NOW - 2_000 },
		];
		const note = model.controlNote(NOW);
		expect(note).toMatch(/still inside a turn|thinking|还在这一轮/i);
		expect(note).toMatch(/not stalled/i); // 明确否定，而不是含 "stalled" 字样
	});

	it("世界不推进且模型也无活动、也没暂停 → 真的停滞，并说明下一步", () => {
		const { model } = load();
		model.run = { state: "running" };
		model.control = { pausedByAgent: false, agentPausedAt: null };
		model.telemetry = { lastActivityAt: NOW - 7_200_000, steps: [] };
		model.recent = [
			{ kind: "date", ts: NOW - 7_200_000 },
			{ kind: "company_stats", ts: NOW - 2_000 },
		];
		const note = model.controlNote(NOW);
		expect(note).toMatch(/stalled|停滞/i);
		expect(note).toMatch(/stop|resume|check/i);
	});

	it("世界仍在推进（最近的 date 事件很新）→ 没有 notice（正常在跑）", () => {
		const { model } = load();
		model.run = { state: "running" };
		model.control = { pausedByAgent: false, agentPausedAt: null };
		model.telemetry = { lastActivityAt: NOW - 20_000, steps: [] };
		model.recent = [
			{ kind: "date", ts: NOW - 15_000 },
			{ kind: "company_stats", ts: NOW - 10_000 },
		];
		expect(model.controlNote(NOW)).toBe("");
	});

	it("controlNote 的分因依赖世界事实，而不是 run.state 的表面值", () => {
		const { model } = load();
		// supervisor 还说 running，但快照已经记录 agent 暂停了 —— 以快照为准
		model.run = { state: "running" };
		model.control = { pausedByAgent: true, agentPausedAt: NOW - 60_000 };
		model.telemetry = { lastActivityAt: NOW - 60_000, steps: [] };
		model.recent = [];
		expect(model.controlNote(NOW)).toMatch(/agent/i);
	});
});

/**
 * 可视化背后的纯计算（2026-09-25）。
 *
 * 原则（同 SPEC §10.99 的诚实规则）：**比率与构成都在可单测的纯函数里算**，
 * 模板只做呈现；没有证据时给"未知"而不是 0。
 */
describe("live-view: 可视化的数据源（health / 世界速率 / 车队构成）", () => {
	const NOW = 1_000_000_000_000;

	it("worldRate: 用 date 事件算游戏日/分钟，并标出冻结", () => {
		const { model } = load();
		// 3 分钟内推进了 6 个游戏日 ⇒ 2 days/min；最新 date 很新 ⇒ advancing
		model.recent = [
			{ kind: "date", ts: NOW - 180_000, payload: { raw: 100 } },
			{ kind: "date", ts: NOW - 90_000, payload: { raw: 103 } },
			{ kind: "date", ts: NOW - 2_000, payload: { raw: 106 } },
		];
		const r = model.worldRate(NOW);
		expect(r.advancing).toBe(true);
		expect(r.daysPerMin).toBeGreaterThan(1.5);
		expect(r.daysPerMin).toBeLessThan(2.5);
	});

	it("worldRate: 只有 1 个 date 样本时速率是 null（不是 0），且不算在推进", () => {
		const { model } = load();
		model.recent = [{ kind: "date", ts: NOW - 5_000, payload: { raw: 100 } }];
		const r = model.worldRate(NOW);
		expect(r.daysPerMin).toBeNull();
		expect(r.advancing).toBe(true);
	});

	it("worldRate: date 停在很久前 → advancing=false（世界被冻住的证据）", () => {
		const { model } = load();
		model.recent = [
			{ kind: "date", ts: NOW - 3_600_000, payload: { raw: 100 } },
			{ kind: "company_stats", ts: NOW - 2_000 },
		];
		expect(model.worldRate(NOW).advancing).toBe(false);
	});

	it("fleetMix: 车辆/车站按类型给出占比，只列非零类型（0 类型不占条）", () => {
		const { model } = load();
		model.companies = {
			"0": {
				info: { name: "AI" },
				economy: {},
				stats: {
					vehicles: 17, stations: 9,
					breakdown: { train: 0, truck: 2, bus: 15, aircraft: 0, ship: 0 },
					stationBreakdown: { train: 0, truck: 0, bus: 9, aircraft: 0, ship: 0 },
				},
				history: [],
			},
		};
		const m = model.fleetMix();
		expect(m.vehicles.total).toBe(17);
		expect(m.vehicles.parts.map((x) => [x.label, x.n])).toEqual([["Bus", 15], ["Truck", 2]]);
		expect(m.vehicles.parts[0]!.pct).toBe(88);
		expect(m.stations.total).toBe(9);
		expect(m.stations.parts.map((x) => x.label)).toEqual(["Bus"]);
	});

	it("fleetMix: 没有 breakdown 时 parts 为空（不编构成），total 仍如实", () => {
		const { model } = load();
		model.companies = { "0": { info: {}, economy: {}, stats: { vehicles: 3, stations: 1 }, history: [] } };
		const m = model.fleetMix();
		expect(m.vehicles.total).toBe(3);
		expect(m.vehicles.parts).toEqual([]);
	});

	it("performance: 去年 vs 去年前年，给出差值（没有就 null）", () => {
		const { model } = load();
		model.companies = { "0": { info: {}, economy: { performanceLastYear: 128, performancePrevYear: 114 }, stats: {}, history: [] } };
		const p = model.performance();
		expect(p.last).toBe(128);
		expect(p.prev).toBe(114);
		expect(p.delta).toBe(14);
		expect(p.max).toBe(255);
	});

	it("performance: 首个财年之前的 0/1 是**占位值** → 报'尚无评分'，不是 0 分", () => {
		const { model } = load();
		// 第一个财年结束前游戏报占位值：companyValue 是 1（SPEC §10.95），
		// performance 在真机实测里先是 0、随后 1 —— 同一占位族。画成"0 分"是编造事实。
		for (const ph of [0, 1]) {
			model.companies = { "0": { info: {}, economy: { performanceLastYear: ph, performancePrevYear: ph }, stats: {}, history: [] } };
			const p = model.performance();
			expect(p.known, `占位值 ${ph} 不该被当成评分`).toBe(false);
			expect(p.last).toBeNull();
			expect(p.prev).toBeNull();
			expect(p.delta).toBeNull();
		}
	});

	it("performance: 有真实评分时 known=true 且画条", () => {
		const { model } = load();
		model.companies = { "0": { info: {}, economy: { performanceLastYear: 200, performancePrevYear: 190 }, stats: {}, history: [] } };
		expect(model.performance().known).toBe(true);
	});

	it("performance: 经济数据里没有绩效字段 → 全部为 null（不是 0 分）", () => {
		const { model } = load();
		model.companies = { "0": { info: {}, economy: {}, stats: {}, history: [] } };
		const p = model.performance();
		expect(p.last).toBeNull();
		expect(p.prev).toBeNull();
		expect(p.delta).toBeNull();
	});

	it("runHealthTiles: 把为什么不动变成可读瓦片（原因 + 下一步）", () => {
		const { model } = load();
		model.run = { state: "running" };
		model.control = { pausedByAgent: true, agentPausedAt: NOW - 60_000 };
		model.telemetry = { lastActivityAt: NOW - 60_000, steps: [] };
		model.recent = [{ kind: "company_stats", ts: NOW - 2_000 }];
		const h = model.runHealth(NOW);
		expect(h.state).toBe("blocked");
		expect(h.action).toMatch(/resume/i);
		expect(h.tiles.map((t) => t.k)).toEqual(["World", "Agent", "Game date", "Decision"]);
	});

	it("runHealthTiles: 正常在跑 → state=ok，且没有行动建议", () => {
		const { model } = load();
		model.run = { state: "running" };
		model.control = { pausedByAgent: false, agentPausedAt: null };
		model.telemetry = { lastActivityAt: NOW - 20_000, steps: [] };
		model.recent = [
			{ kind: "date", ts: NOW - 15_000, payload: { raw: 100 } },
			{ kind: "company_stats", ts: NOW - 5_000 },
		];
		const h = model.runHealth(NOW);
		expect(h.state).toBe("ok");
		expect(h.action).toBe("");
	});
});

/**
 * 车队数必须**跨线路去重**（2026-09-25 用户真机：同屏出现 "25 veh" 与 "129"）。
 *
 * 真机数字：17 条线路 / 9 个车站，站点平均出现在 ~3.8 条线路上；公司只有 25 辆车，
 * 却被报成 129（25 × ~5 同量级）。机制：GS 的每条线路读数是"停在这条线**两端站**上的
 * 车"，而车站服务多条线路 ⇒ 同一辆车被重复计数。有车辆 id 就能去重；等待量按站号去重。
 */
describe("routesSummary：跨线路去重（否则两个车队数互相矛盾）", () => {
	const model = load().model;
	const routes = [
		// 三条线路共用车站 4 / 8：站 4 上的 3 辆车会被三条各数一次
		{ job: 100, townA: 4, townB: 8, vehicles: 5, waiting: 30, vehiclesIds: [11, 12, 13, 14, 15], endsA: 4, endsB: 8, waitA: 20, waitB: 10 },
		{ job: 101, townA: 4, townB: 9, vehicles: 3, waiting: 12, vehiclesIds: [11, 12, 13], endsA: 4, endsB: 9, waitA: 20, waitB: 12 },
		{ job: 102, townA: 12, townB: 8, vehicles: 2, waiting: 40, vehiclesIds: [21, 22], endsA: 12, endsB: 8, waitA: 40, waitB: 10 },
	];

	it("车辆按 id 去重（5+3+2 的声明值其实是 7 辆不同的车）", () => {
		model.routes = routes as never;
		const s = model.routesSummary() as unknown as { vehicles: number; vehiclesDeduplicated: boolean };
		expect(s.vehicles).toBe(7);
		expect(s.vehiclesDeduplicated).toBe(true);
	});

	it("等待人数按**站号**去重（站 4 被两条线各报一次 20，站 8 被两条各报一次 10）", () => {
		model.routes = routes as never;
		const s = model.routesSummary() as unknown as { waiting: number; stops: number; waitingDeduplicated: boolean };
		expect(s.stops).toBe(4); // 4, 8, 9, 12
		expect(s.waiting).toBe(20 + 10 + 12 + 40);
		expect(s.waitingDeduplicated).toBe(true);
	});

	it("同一线路两端是同一个站时只算一次（否则站 4 的等待被自己翻倍）", () => {
		model.routes = [
			{ job: 1, townA: 4, townB: 4, vehicles: 1, waiting: 25, vehiclesIds: [1], endsA: 4, endsB: 4, waitA: 25, waitB: 25 },
		] as never;
		const s = model.routesSummary() as unknown as { waiting: number; stops: number };
		expect(s.stops).toBe(1);
		expect(s.waiting).toBe(25);
	});

	it("旧 GS（没有车辆 id）→ 退回求和，但**明说没去重**（不假装已经修好）", () => {
		model.routes = [{ job: 1, vehicles: 4, waiting: 9 }] as never;
		const s = model.routesSummary() as unknown as { vehicles: number; vehiclesDeduplicated: boolean };
		expect(s.vehicles).toBe(4);
		expect(s.vehiclesDeduplicated).toBe(false);
	});
});

/**
 * 数据新鲜度（2026-09-25 用户："Fleet Detail 不会自动更新"）。
 *
 * 面板"数字没变"有两种可能：世界真的没变（事实），或数据早就没在流（缺陷）。
 * 不把"最后一帧多久前"显示出来，用户只能靠猜 —— 而猜错的方向是"相信页面"。
 */
describe("dataAge：说清数据在不在流", () => {
	const model = load().model;
	const NOW = 1_700_000_000_000;

	it("刚收到帧 → ok，且写明是数据而不是含糊的 live", () => {
		model.lastFrameAt = NOW - 3_000;
		const a = model.dataAge(NOW) as unknown as { text: string; tone: string };
		expect(a.tone).toBe("ok");
		expect(a.text).toMatch(/^data /);
	});

	it("30 秒没帧 → warn（还没到死掉的程度，但该被注意到）", () => {
		model.lastFrameAt = NOW - 30_000;
		expect((model.dataAge(NOW) as unknown as { tone: string }).tone).toBe("warn");
	});

	it("90 秒没帧 → bad，并且直说没有数据 90 秒", () => {
		model.lastFrameAt = NOW - 90_000;
		const a = model.dataAge(NOW) as unknown as { text: string; tone: string };
		expect(a.tone).toBe("bad");
		expect(a.text).toBe("no data for 90s");
	});

	it("一帧都没收到 → 未知（dim），不是 0 秒前", () => {
		model.lastFrameAt = null;
		const a = model.dataAge(NOW) as unknown as { text: string; tone: string };
		expect(a.tone).toBe("dim");
		expect(a.text).not.toMatch(/0s/);
	});
});

/** 口径必须写在界面上：不说清"这是哪一种车数"，两个数字就会继续互相打架。 */
describe("车队口径写在界面上（否则 25 与 129 会继续并存）", () => {
	it("KPI 标题与提示说清是线路端点的车，而不是含糊的在线路上", () => {
		const html = readFileSync(join(PUBLIC_DIR, "pages/live.html"), "utf8");
		expect(html).toMatch(/Vehicles at route ends/);
		// 旧标题（听上去像车队规模，其实只是"站在端点上的车"）
		expect(html).not.toMatch(/Vehicles on routes/);
		// 未去重时（老 GS）必须明说，不能假装已经修好
		expect(html).toMatch(/not de-duplicated/);
	});

	it("页头有独立的数据新鲜度项（连接活着 ≠ 数据在流）", () => {
		const html = readFileSync(join(PUBLIC_DIR, "pages/live.html"), "utf8");
		expect(html).toMatch(/x-text="dataAge\(\)\.text"/);
	});
});
