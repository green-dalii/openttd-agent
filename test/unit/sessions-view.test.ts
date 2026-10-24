/**
 * Unit tests — the Sessions page as an Alpine component.
 *
 * 职责: 在 `node:vm` 里加载**真实的页面组件模块**，断言其状态推导与格式化，
 *   不依赖浏览器、不依赖 Alpine 运行时。
 *
 * 为什么这样测（docs/FRONTEND.md §3.4 阶段 4）:
 *   迁移到 Alpine 的最大风险不是"指令写错"，而是**把已有的业务规则弄丢**
 *   （例如 interrupted 与 running 必须区分、对比表的 Δ 方向、只统计 completed 的成功率）。
 *   因此组件把可推导的部分抽成纯函数（`sessionsModel`），由本文件锁住；
 *   DOM 绑定部分由真机 E2E 覆盖。
 *
 * 禁止: 断言 Alpine 的模板内部结构（那是上游实现）；只断言"给什么状态 → 得出什么显示值"。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/sessions-view.js"), "utf8");

interface SessionLike {
	id: string;
	status: string;
	mode: string;
	seed?: number;
	companyName?: string;
	startedAt?: number;
	endedAt?: number;
	outcome?: Record<string, unknown>;
	totals?: Record<string, unknown>;
}

interface Model {
	visible(): SessionLike[];
	totals(): { count: number; done: number; successRate: number | null; tokens: number; cost: number };
	statusInfo(s: string): { cls: string; title: string };
	isBuilt(s: SessionLike): boolean;
	isIncomplete(s: SessionLike): boolean;
	compareRows(): { key: string; a: string; b: string; delta: number | null }[];
	tokenSlices(): { label: string; value: number; color: string }[];
	toggleOnlyDone(value: boolean): void;
	steps(): { kind: string; ok?: boolean }[];
	deltaText(d: number | null): string;
	deltaClass(d: number | null): string;
	trainingSeries(metrics: unknown[]): {
		runs: { key: string; order: number; scenario: string; deliveredRun: number | null; comparable: boolean; reason: string | null }[];
		summary: { total: number; comparable: number; excludedCounts: Record<string, number> };
		verdict: string;
	};
	trainingChartSvg(series: unknown, width?: number, height?: number): string;
	runFacts(session: SessionLike & { savegame?: { exists?: boolean; path?: string } }): Array<{
		k: string;
		v: string;
		tone: string;
		title?: string;
	}>;
}

/** Load the component module with a recording UI stub. */
function load(
	sessions: SessionLike[] = [],
	data: Record<string, unknown> | null = null,
	compareData: Record<string, unknown> | null = null,
	opts: { onlyDone?: boolean; withUi?: boolean } = {},
): { model: Model; prefWrites: [string, unknown][]; fetched: string[] } {
	const prefWrites: [string, unknown][] = [];
	const fetched: string[] = [];
	const U = {
		fmtInt: (v: unknown) => (v === null || v === undefined ? "—" : String(v)),
		fmtMoney: (v: unknown) => `£${v}`,
		fmtTok: (v: unknown) => `${v}t`,
		fmtCost: (v: unknown) => `$${v}`,
		// Faithful to common.js: unknown pricing must read as "unknown", not "$0".
		fmtCostKnown: (v: unknown, known?: boolean) => (known === false ? "unknown" : `$${v}`),
		fmtDuration: (v: unknown) => `${v}ms`,
		fmtAgo: (v: unknown) => `${v}ago`,
		fmtClock: (v: unknown) => `c${v}`,
		fmtPct: (v: number, d?: number) => `${(v * 100).toFixed(d ?? 1)}%`,
		fmtGameDate: (v: unknown) => String(v),
		esc: (v: unknown) => String(v),
		toast: () => {},
		getPref: (_k: string, dflt: unknown) => dflt,
		setPref: (k: string, v: unknown) => prefWrites.push([k, v]),
		$: () => null,
		renderNav: () => "",
	};
	const sandbox: Record<string, unknown> = {
		document: { getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [] },
		fetch: (url: string) => {
			fetched.push(String(url));
			return Promise.resolve({
				ok: true,
				json: () => Promise.resolve(data || { sessions }),
			});
		},
		console,
		JSON,
		Object,
		Array,
		Number,
		String,
		Math,
		Date,
		Map,
		Set,
		Promise,
		Error,
	};
	sandbox.UI = U;
	if (opts.withUi !== false) sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const factory = (
		sandbox.window as {
			SessionsView: {
				create: (seed: {
					sessions: SessionLike[];
					data: Record<string, unknown> | null;
					compareData: Record<string, unknown> | null;
					onlyDone: boolean;
				}) => Model;
			};
		}
	).SessionsView;
	return {
		model: factory.create({
			sessions,
			data,
			compareData,
			onlyDone: opts.onlyDone ?? false,
		}),
		prefWrites,
		fetched,
	};
}

const S = (over: Partial<SessionLike> = {}): SessionLike => ({
	id: "s1",
	status: "completed",
	mode: "agent",
	seed: 7,
	startedAt: 1000,
	endedAt: 2000,
	outcome: { constructionDone: true, money: 100000, vehicles: 4, stations: 3 },
	totals: { decisions: 5, toolCalls: 9, toolFailures: 1, usage: { totalTokens: 3000, costTotal: 0.5 } },
	...over,
});

describe("sessions view model", () => {
	describe("status badges", () => {
		it("keeps `interrupted` distinct from `running`", () => {
			// A hard-killed run must not look like a live one; it also needs to
			// explain itself rather than read as a generic warning.
			const { model } = load();
			const run = model.statusInfo("running");
			const int = model.statusInfo("interrupted");
			expect(int.cls).not.toBe(run.cls);
			expect(int.title).toMatch(/cleanly|crash|kill/i);
		});

		it("maps every status the backend can emit", () => {
			const { model } = load();
			for (const s of ["running", "completed", "aborted", "error", "interrupted"]) {
				expect(model.statusInfo(s).cls, s).toBeTruthy();
			}
		});

		it("falls back safely for an unknown status", () => {
			const { model } = load();
			expect(() => model.statusInfo("who-knows")).not.toThrow();
			expect(model.statusInfo("who-knows").cls).toBeTruthy();
		});
	});

	describe("totals", () => {
		it("counts runs and completed runs", () => {
			const { model } = load([
				S({ id: "a", status: "completed" }),
				S({ id: "b", status: "aborted" }),
				S({ id: "c", status: "interrupted" }),
			]);
			const t = model.totals();
			expect(t.count).toBe(3);
			expect(t.done).toBe(1);
		});

		it("computes the success rate over completed runs only", () => {
			// A run that never finished has no outcome to judge; including it would
			// understate the rate.
			const { model } = load([
				S({ id: "a", status: "completed", outcome: { constructionDone: true } }),
				S({ id: "b", status: "completed", outcome: { constructionDone: false } }),
				S({ id: "c", status: "aborted", outcome: { constructionDone: true } }),
			]);
			expect(model.totals().successRate).toBe(0.5);
		});

		it("reports no rate rather than 0% when nothing completed", () => {
			// "—" and "0%" mean different things: nothing finished vs everything failed.
			const { model } = load([S({ status: "running" })]);
			expect(model.totals().successRate).toBeNull();
		});

		it("sums tokens and cost across every run", () => {
			const { model } = load([
				S({ id: "a", totals: { usage: { totalTokens: 100, costTotal: 0.1 } } }),
				S({ id: "b", totals: { usage: { totalTokens: 250, costTotal: 0.25 } } }),
			]);
			const t = model.totals();
			expect(t.tokens).toBe(350);
			expect(t.cost).toBeCloseTo(0.35, 6);
		});

		it("survives runs with missing totals", () => {
			const { model } = load([{ id: "x", status: "completed", mode: "agent" }]);
			const t = model.totals();
			expect(t.tokens).toBe(0);
			expect(t.cost).toBe(0);
		});
	});

	describe("list filtering", () => {
		it("shows everything by default", () => {
			const { model } = load([S({ id: "a" }), S({ id: "b", status: "aborted" })]);
			expect(model.visible().length).toBe(2);
		});

		it("shows only completed runs when the toggle is on", () => {
			const { model } = load(
				[S({ id: "a", status: "completed" }), S({ id: "b", status: "aborted" })],
				null,
				null,
				{ onlyDone: true },
			);
			expect(model.visible().map((s) => s.id)).toEqual(["a"]);
		});
	});

	describe("outcome flags", () => {
		it("distinguishes built / incomplete / unknown", () => {
			const { model } = load();
			expect(model.isBuilt(S({ outcome: { constructionDone: true } }))).toBe(true);
			expect(model.isBuilt(S({ outcome: { constructionDone: false } }))).toBe(false);
			expect(model.isIncomplete(S({ outcome: { constructionDone: false } }))).toBe(true);
			// Unknown must not be reported as a failure.
			expect(model.isIncomplete(S({ outcome: {} }))).toBe(false);
			expect(model.isBuilt(S({ outcome: {} }))).toBe(false);
			// A run with no outcome at all is unknown, not a failure either.
			expect(model.isBuilt(S({ outcome: undefined }))).toBe(false);
			expect(model.isIncomplete(S({ outcome: undefined }))).toBe(false);
		});
	});

	describe("token slices (donut)", () => {
		it("builds slices in a fixed colour order and drops empty ones", () => {
			const { model } = load([], {
				meta: { totals: { usage: { input: 100, output: 0, reasoning: 20, cacheRead: 5 } } },
			});
			const slices = model.tokenSlices();
			expect(slices.map((s) => s.label)).toEqual(["Input", "Reasoning", "Cache read"]);
			expect(slices.every((s) => s.value > 0)).toBe(true);
			expect(slices[0]!.color).toBeTruthy();
		});

		it("returns nothing when there is no usage", () => {
			const { model } = load([], { meta: {} });
			expect(model.tokenSlices()).toEqual([]);
		});
	});

	describe("comparison rows", () => {
		const a = { meta: { id: "run-a", mode: "agent", totals: { decisions: 3, usage: { totalTokens: 1000, costTotal: 0.2 } }, outcome: { constructionDone: false, money: 1000, vehicles: 1, stations: 1 } } };
		const b = { meta: { id: "run-b", mode: "watch", totals: { decisions: 9, usage: { totalTokens: 4000, costTotal: 0.9 } }, outcome: { constructionDone: true, money: 5000, vehicles: 4, stations: 3 } } };

		it("computes deltas as right-minus-left", () => {
			// The sign convention is what makes the table readable: positive Cash is
			// an improvement, positive cost/failures is a regression.
			const { model } = load([], a, b);
			const rows = model.compareRows();
			const cash = rows.find((r) => r.key === "Cash")!;
			expect(cash.delta).toBe(4000);
			const tokens = rows.find((r) => r.key === "Tokens")!;
			expect(tokens.delta).toBe(3000);
		});

		it("has no delta for non-numeric rows", () => {
			const { model } = load([], a, b);
			for (const key of ["Result", "Mode"]) {
				const row = model.compareRows().find((r) => r.key === key)!;
				expect(row.delta, key).toBeNull();
			}
		});

		it("marks an unpriced run's cost as unknown and refuses a Δ", () => {
			const priced = {
				meta: { ...a.meta, totals: { ...a.meta.totals, usage: { totalTokens: 1000, costTotal: 0.2, costKnown: true } } },
			};
			const unpriced = {
				meta: { ...b.meta, totals: { ...b.meta.totals, usage: { totalTokens: 4000, costTotal: 0, costKnown: false } } },
			};
			const { model } = load([], priced, unpriced);
			const cost = model.compareRows().find((r) => r.key === "Cost")!;
			expect(cost.b).toBe("unknown");
			expect(cost.delta).toBeNull();
		});

		it("shows the comparability facts (backend / scaffold / payload), D6c", () => {
			// Two runs are only comparable when the runtime, the scaffold and the
			// payload agree. The row must say "not measured" when the run did not
			// record a payload (bare-Agent path) - not an empty string.
			const withManifest = {
				meta: {
					...a.meta,
					manifest: {
						servedModel: "m",
						backend: "harness",
						thinkingLevel: "off",
						toolBudget: 12,
						scaffoldHash: "7956ab6d8c86fa60",
						payloadHash: "c4a214dc8d0dea46",
						payloadCount: 5,
					},
				},
			};
			const bare = {
				meta: {
					...b.meta,
					manifest: {
						servedModel: "m",
						backend: "agent",
						thinkingLevel: "off",
						toolBudget: 12,
						scaffoldHash: "7956ab6d8c86fa60",
						payloadHash: null,
						payloadCount: null,
					},
				},
			};
			const { model } = load([], withManifest, bare);
			const rows = model.compareRows();
			expect(rows.find((r) => r.key === "Backend")).toMatchObject({ a: "harness", b: "agent" });
			// Same scaffold -> the same 8 chars on both sides; that is the point of the row.
			expect(rows.find((r) => r.key === "Scaffold")).toMatchObject({ a: "7956ab6d", b: "7956ab6d" });
			expect(rows.find((r) => r.key === "Payload")).toMatchObject({ a: "c4a214dc", b: "not measured" });
		});

		it("shows both runs' values", () => {
			const { model } = load([], a, b);
			const mode = model.compareRows().find((r) => r.key === "Mode")!;
			expect(mode.a).toBe("agent");
			expect(mode.b).toBe("watch");
		});

		it("survives missing data on either side", () => {
			const { model } = load([], a, null);
			expect(() => model.compareRows()).not.toThrow();
		});
	});

	describe("preferences", () => {
		it("persists the completed-only toggle", () => {
			const { model, prefWrites } = load([], null, null, { onlyDone: false });
			model.toggleOnlyDone(true);
			expect(prefWrites).toEqual([["sessions.onlyDone", true]]);
		});
	});
});

/**
 * The imperative donut is the one part of the Alpine migration that cannot be
 * declared in the template, so it is pinned here.
 *
 * Regression (2026-09-11): `drawDonut()` read `tokenSlices()` inside its
 * `$nextTick` callback. Alpine's `x-effect` only tracks reads made in the
 * effect's SYNCHRONOUS scope, so the dependency was invisible: when the session
 * data arrived asynchronously the effect never re-ran, and the donut stayed
 * blank (measured in the browser: canvas exists, 0 painted pixels) while the
 * legend rendered correctly - the tell-tale sign of a tracked-dependency bug.
 */
describe("sessions component: donut drawing contract", () => {
	/** Minimal stand-in for the Alpine component instance. */
	function makeInstance(over: Record<string, unknown> = {}) {
		const calls: string[] = [];
		let nextTickSync = true;
		const inst: Record<string, unknown> = {
			$refs: { donut: { __canvas: true } },
			$nextTick(fn: () => void) {
				calls.push("nextTick");
				nextTickSync = false;
				fn();
			},
			tokenSlices() {
				// Record whether this was read synchronously (i.e. trackable).
				calls.push(nextTickSync ? "tokenSlices:sync" : "tokenSlices:async");
				return [{ label: "Input", value: 10, color: "#000" }];
			},
			metaUsage: () => ({ totalTokens: 10 }),
			...over,
		};
		return { inst, calls };
	}

	it("reads its data synchronously so the effect can track it", () => {
		// Load the page script and pull out drawDonut via the Alpine registration.
		const registered: (() => Record<string, unknown>)[] = [];
		const sandbox: Record<string, unknown> = {
			document: {
				addEventListener: (name: string, fn: () => void) => {
					if (name === "alpine:init") fn();
				},
				getElementById: () => null,
			},
			UI: {
				$: () => null,
				getPref: (_k: string, d: unknown) => d,
				setPref: () => {},
				renderNav: () => "",
				renderChrome: () => {},
				segmented: () => {},
				combobox: () => null,
				toast: () => {},
				fmtTok: (v: unknown) => String(v),
				categoryOf: () => "x",
				categoryClass: () => "x",
				categoryLabel: () => "x",
				eventMatches: () => true,
				briefOf: () => "",
			},
			Charts: { donut: () => {} },
			Alpine: {
				data: (_name: string, factory: () => Record<string, unknown>) => registered.push(factory),
				magic: () => {},
				store: () => {},
			},
			SessionsView: { create: (seed: unknown) => ({ seed }) },
			fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
			console, JSON, Object, Array, Number, String, Math, Date, Map, Set, Promise, Error,
		};
		sandbox.window = sandbox;
		sandbox.globalThis = sandbox;
		vm.createContext(sandbox);
		runInContext(sandbox);

		const factory = registered[0];
		expect(factory, "sessions component must register with Alpine").toBeTruthy();
		const component = factory!();
		expect(typeof component.drawDonut, "component must expose drawDonut").toBe("function");

		// Re-run drawDonut against the harness instance and inspect the read order.
		const { inst, calls } = makeInstance();
		(component.drawDonut as (this: unknown) => void).call(
			Object.assign(Object.create(null), inst, { drawDonut: component.drawDonut }),
		);
		// The token slices must be read BEFORE the async boundary, or Alpine cannot
		// see the dependency and the chart never redraws.
		expect(calls).toContain("tokenSlices:sync");
		expect(calls.indexOf("tokenSlices:sync")).toBeLessThan(calls.indexOf("nextTick"));
	});

	function runInContext(sandbox: Record<string, unknown>): void {
		const src = readFileSync(join(PUBLIC_DIR, "assets/js/sessions.js"), "utf8");
		vm.runInContext(src, vm.createContext(sandbox));
	}
});

/**
 * W1：局在暂停中结束时，审核页必须**第一眼**标出来（SPEC §10.101）。
 *
 * `outcomeRows` 属于页面脚本的**呈现**层（`sessions.js`，与仓库其余页面脚本一样
 * 由源码守卫 + 集成/E2E 覆盖），所以这里锁它必须包含的事实与措辞。
 */
describe("sessions: 暂停收场的局要能被一眼挑出（W1 源码守卫）", () => {
	const src = readFileSync(join(PUBLIC_DIR, "assets/js/sessions.js"), "utf8");

	it("outcomeRows 在 blockedByPause 时优先返回被自己按停 + 不要当学习结果", () => {
		expect(src).toMatch(/blockedByPause === true/);
		expect(src).toMatch(/pausedBy === "agent"/);
		expect(src).toMatch(/NOT a learning result/);
		// 必须**优先**返回（早于其它测量项），否则审核者要在一堆数字里找它
		const fn = src.slice(src.indexOf("outcomeRows()"), src.indexOf("brainText()"));
		expect(fn.indexOf("blockedByPause")).toBeLessThan(fn.indexOf("Construction done"));
	});
});

/**
 * 列表项的"索引事实"（2026-09-25 用户："/sessions 统计信息过少，缺少关键信息，
 * 也缺少该 session 的存档文件位置显示"）。
 *
 * 关键断言是**无效样本必须显眼**：一条被暂停结束 / 世界冻住的局，在列表里若长得和好局
 * 一样，它就会被拿去参与平均（W1/W2 的全部意义就丢在这张列表上）。
 */
describe("sessions 列表：runFacts（不必点开就能判断一局值不值得看）", () => {
	const model = load().model;
	const factsOf = (s: Record<string, unknown>) => {
		const rows = model.runFacts(s as never);
		const by = (k: string) => rows.find((r) => r.k === k);
		return { rows, by };
	};

	it("正常局：交付量 + 窗口 + 存档位置", () => {
		const { by } = factsOf({
			outcome: { deliveredRun: 33, deliveredRunComplete: true, simulatedDays: 1500, reachedHorizon: true },
			savegame: { exists: true, path: "/tmp/dd/save/20260926-075117-seed9.sav" },
		});
		expect(by("delivered")!.v).toBe("33 ✓");
		expect(by("window")!.v).toBe("1500d");
		expect(by("save")!.v).toMatch(/save\/20260926-075117-seed9\.sav$/);
		// 完整路径在 title 里（列表只给尾巴，但"这局能不能接着玩"要能拿到全路径）
		expect(by("save")!.title).toBe("/tmp/dd/save/20260926-075117-seed9.sav");
		expect(by("verdict")).toBeUndefined();
	});

	it("被暂停结束的局 → 一眼可见的 exclude 标记（W1）", () => {
		const { by } = factsOf({ outcome: { deliveredRun: 0, blockedByPause: true, pausedBy: "agent" } });
		expect(by("verdict")!.tone).toBe("bad");
		expect(by("verdict")!.v).toMatch(/paused/);
		expect(by("verdict")!.v).toMatch(/exclude/);
	});

	it("世界冻住的局 → 另一种原因，同样 exclude（W2：两类原因不许合并成一个词）", () => {
		const { by } = factsOf({ outcome: { worldFrozen: true, worldFrozenMs: 3_600_000 } });
		expect(by("verdict")!.tone).toBe("bad");
		expect(by("verdict")!.v).toMatch(/world frozen/);
		expect(by("verdict")!.v).not.toMatch(/paused/);
	});

	it("GS 报错 / 未达窗口 → 警告级（次一级，但要说出来）", () => {
		expect(factsOf({ outcome: { gsErrors: 152 } }).by("verdict")!.v).toMatch(/152 GS errors/);
		expect(factsOf({ outcome: { reachedHorizon: false, simulatedDays: 90 } }).by("verdict")!.tone).toBe("warn");
	});

	it("交付量未记录 → 「—」，不是 0（没发生 ≠ 零）", () => {
		expect(factsOf({ outcome: {} }).by("delivered")!.v).toBe("—");
	});

	it("存档没写出来时说清原因，而不是显示一个不存在的路径", () => {
		const { by } = factsOf({ outcome: {}, savegame: { exists: false, path: "/x/y.sav" } });
		expect(by("save")!.v).toBe("not written yet");
		expect(by("save")!.title).toMatch(/saves when it ends/);
	});

	it("没有 savegame 字段（旧数据）→ 不出现这一项，而不是假装没存档", () => {
		expect(factsOf({ outcome: {} }).by("save")).toBeUndefined();
	});
});

/** 模板必须真的把 runFacts 渲染出来（"算了但没渲染"是本页最常见的失败形状）。 */
describe("sessions 模板：索引事实被渲染", () => {
	it("列表项里有 runFacts 的渲染点", () => {
		const html = readFileSync(join(PUBLIC_DIR, "pages/sessions.html"), "utf8");
		expect(html).toMatch(/x-for="f in runFacts\(s\)"/);
	});
});

/**
 * TRAINING 面板（P0-3）：一屏回答「变强了吗 / 为什么这局不算」。
 * 口径（D61）：可比局 < 2 → 「不可判定」；缺失 ≠ 0；排除**按原因分别计数**（D56）。
 */
describe("trainingSeries：变强了吗 / 为什么这局不算", () => {
	const base = { id: "a", startedAt: 1000, deliveredRun: 100, excluded: null };

	it("按 startedAt 排序；可比局进趋势，排除局不进且带具名原因", () => {
		const { model } = load();
		const s = model.trainingSeries([
			{ ...base, id: "b", startedAt: 2000, deliveredRun: 300, excluded: null },
			{ ...base, id: "a", deliveredRun: 100, excluded: "stopped (paused)" },
		]);
		expect(s.runs.map((r) => r.key)).toEqual(["a", "b"]);
		expect(s.runs[0]!.comparable).toBe(false);
		expect(s.runs[0]!.reason).toBe("stopped (paused)");
		expect(s.summary.comparable).toBe(1);
		expect(s.summary.excludedCounts).toEqual({ "stopped (paused)": 1 });
	});

	it("可比且有计量的局 < 2 → 结论是「不可判定」（不画假趋势）", () => {
		const { model } = load();
		const s = model.trainingSeries([{ ...base, deliveredRun: 100 }]);
		expect(s.verdict).toMatch(/not determinable/);
		const s2 = model.trainingSeries([]);
		expect(s2.verdict).toMatch(/not determinable/);
	});

	it("deliveredRun 缺失/非法 → null（缺失 ≠ 0），且不进趋势", () => {
		const { model } = load();
		const s = model.trainingSeries([
			{ id: "x", startedAt: 1, deliveredRun: null, excluded: null },
			{ id: "y", startedAt: 2, deliveredRun: "n/a", excluded: null },
			base,
			{ ...base, id: "z", startedAt: 3 },
		]);
		expect(s.runs.find((r) => r.key === "x")!.deliveredRun).toBeNull();
		expect(s.runs.find((r) => r.key === "y")!.deliveredRun).toBeNull();
		// 3 个可比局里只有 2 个有计量 → 有 2 个点才可判定
		expect(s.verdict).toMatch(/shown across 2 comparable runs/);
	});

	it("服务端没标 excluded 的行 → 记为 not marked（不冒充可比）", () => {
		const { model } = load();
		const s = model.trainingSeries([{ id: "u", startedAt: 1, deliveredRun: 5 }]);
		expect(s.runs[0]!.comparable).toBe(false);
		expect(s.runs[0]!.reason).toBe("not marked");
	});
});

describe("trainingChartSvg：区分度必须在图上", () => {
	it("可比局是实心点 + 折线；排除局是空心点且不在折线上", () => {
		const { model } = load();
		const s = model.trainingSeries([
			{ id: "a", startedAt: 1, deliveredRun: 100, excluded: null },
			{ id: "b", startedAt: 2, deliveredRun: 200, excluded: "world frozen" },
			{ id: "c", startedAt: 3, deliveredRun: 300, excluded: null },
		]);
		const svg = model.trainingChartSvg(s, 640, 160);
		expect(svg).toContain("<svg");
		expect(svg).toContain("polyline"); // 可比局连线
		expect(svg.match(/<circle/g)).toHaveLength(3);
		// 排除局空心（circle 上 fill="none" + 虚线描边；polyline 也带 fill="none"，别混）
		expect(svg.match(/<circle[^>]*fill="none"/g)).toHaveLength(1);
	});

	it("没有可比点时只画坐标轴（不画假折线）", () => {
		const { model } = load();
		const s = model.trainingSeries([{ id: "a", startedAt: 1, deliveredRun: 10, excluded: "demo (not a real LLM)" }]);
		const svg = model.trainingChartSvg(s);
		expect(svg).not.toContain("polyline");
		expect(svg).toContain("<svg");
	});
});

describe("sessions 模板：训练面板被渲染（算了但没渲染是本页最常见失败）", () => {
	it("有 TRAINING 区 + series 的渲染点 + verdict 文本", () => {
		const html = readFileSync(join(PUBLIC_DIR, "pages/sessions.html"), "utf8");
		expect(html).toMatch(/TRAINING/);
		expect(html).toContain("trainingChartSvg(");
		expect(html).toContain("trainingSeries(");
		// 排除原因必须逐条列出，不许合并成一个数字（D56）
		expect(html).toContain("excludedCounts");
	});
});
