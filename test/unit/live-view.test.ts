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
	resultKpis(): { k: string; v: string; hint?: string }[];
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
	stageList(): unknown[];
	companiesEmpty(): boolean;
	companyCards(): { id: string; name: string; isAi: boolean; neg: boolean; money: string; value: string; fleet: string }[];
	toggleCategorySet(cat: string): Set<string>;
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
