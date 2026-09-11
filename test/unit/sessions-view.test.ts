/**
 * Unit tests — the Sessions page as an Alpine component.
 *
 * 职责: 在 `node:vm` 里加载**真实的页面组件模块**，断言其状态推导与格式化，
 *   不依赖浏览器、不依赖 Alpine 运行时。
 *
 * 为什么这样测（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.4 阶段 4）:
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
				renderNavInto: () => {},
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
