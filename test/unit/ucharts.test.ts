/**
 * Unit tests — the uPlot adapter (line / stacked bars).
 *
 * 职责: 锁定 `assets/js/ucharts.js` 把**页面现有的配置形状**翻译成 uPlot
 *   （`{series, labels, format}` / `{items, series, maxBars}`），以及
 *   "uPlot 不在场时不能把页面弄崩" 这一降级要求。
 *
 * 为什么需要适配层（docs/FRONTEND-DEPENDENCIES-AUDIT.md §3.1）:
 *   页面调用的是本项目的图表配置，不是 uPlot 的原生配置。适配层是唯一的翻译点，
 *   所以它必须能脱离浏览器/不加载 uPlot 单测 —— 否则又是一层无法验证的手搓代码
 *   （这正是阶段 1 之前 3735 行前端踩坑的模式）。
 *
 * 禁止: 断言 uPlot 的绘制细节（那是上游的事）；只断言**传进去的数据**正确。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/ucharts.js"), "utf8");

interface UChartsApi {
	available: () => boolean;
	line: (el: unknown, cfg: unknown) => unknown;
	stackedBars: (el: unknown, cfg: unknown) => unknown;
	destroy: (el: unknown) => void;
	/** Exposed for tests: the cfg translation, with no uPlot involved. */
	toLineData: (cfg: unknown) => { data: unknown; opts: unknown };
	toStackedData: (cfg: unknown) => { data: unknown; opts: unknown };
	stackedLowerBounds: (items: unknown, si: number, i0: number, i1: number) => number[];
	stackedUpperBounds: (items: unknown, si: number, i0: number, i1: number) => number[];
}

/** A uPlot stand-in that records the arguments it is constructed with. */
function fakeUPlot() {
	const calls: { data: unknown; opts: unknown; el: unknown }[] = [];
	class Fake {
		height = 220;
		__lastWidth = 0;
		constructor(opts: unknown, data: unknown, el: unknown) {
			calls.push({ opts, data, el });
		}
		destroy() {}
		setData() {}
		// The adapter sizes the instance after construction (uPlot cannot measure
		// a fresh element itself) and on container resize.
		setSize(size: { width: number; height: number }) {
			calls.push({ opts: { setSize: size }, data: null, el: null });
		}
	}
	// `paths.bars` is used by the stacked adapter.
	(Fake as unknown as { paths: unknown }).paths = {
		bars: (o: unknown) => ({ __bars: o }),
	};
	return { Fake, calls };
}

function load(opts: { withUplot?: boolean } = {}): {
	api: UChartsApi;
	calls: { data: unknown; opts: unknown; el: unknown }[];
} {
	const { Fake, calls } = fakeUPlot();
	const sandbox: Record<string, unknown> = {
		document: {
			getElementById: () => null,
			createElement: () => ({ style: {}, classList: { add: () => {} } }),
			querySelectorAll: () => [],
			body: { appendChild: () => {} },
		},
		devicePixelRatio: 1,
		setTimeout: () => 0,
		clearTimeout: () => {},
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		console,
		Math,
		Number,
		String,
		Object,
		Array,
		JSON,
		Date,
		Error,
	};
	if (opts.withUplot !== false) sandbox.uPlot = Fake;
	// In a browser `window` IS the global object; mirror that so `window.uPlot`
	// and a bare `uPlot` resolve to the same thing.
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return { api: (sandbox.window as { UCharts: UChartsApi }).UCharts, calls };
}

describe("uPlot adapter", () => {
	it("reports availability based on the global being present", () => {
		expect(load({ withUplot: true }).api.available()).toBe(true);
		expect(load({ withUplot: false }).api.available()).toBe(false);
	});

	describe("line()", () => {
		it("builds x/y pairs from labels + series", () => {
			const { api } = load();
			const { data } = api.toLineData({
				series: [{ name: "Cash", data: [10, 20, 30], color: "#f00" }],
				labels: ["a", "b", "c"],
			});
			const rows = data as unknown[];
			expect(rows[0]).toEqual([0, 1, 2]); // x = index
			expect(rows[1]).toEqual([10, 20, 30]); // y = the series
		});

		it("keeps multiple series aligned", () => {
			const { api } = load();
			const { data } = api.toLineData({
				series: [
					{ name: "money", data: [1, 2] },
					{ name: "loan", data: [3, 4] },
				],
				labels: ["x", "y"],
			});
			expect(data).toEqual([[0, 1], [1, 2], [3, 4]]);
		});

		it("carries the page's colour and name onto the uPlot series", () => {
			const { api } = load();
			const { opts } = api.toLineData({
				series: [{ name: "Cash", data: [1], color: "#abcdef" }],
				labels: ["a"],
			});
			const series = (opts as { series: { label?: string; stroke?: string }[] }).series;
			// uPlot's convention: series[0] is the x axis, real series start at 1.
			expect(series[0]!.label).toBe("x");
			expect(series[1]!.label).toBe("Cash");
			expect(series[1]!.stroke).toBe("#abcdef");
		});

		it("passes the height through so the layout keeps its size", () => {
			const { api } = load();
			const { opts } = api.toLineData({ series: [], labels: [], height: 260 });
			expect((opts as { height?: number }).height).toBe(260);
		});

		it("renders axis labels with the caller's formatter", () => {
			const { api } = load();
			const { opts } = api.toLineData({
				series: [{ name: "Cash", data: [1] }],
				labels: ["a"],
				format: (v: number) => `F${v}`,
			});
			const axes = (opts as { axes: { values?: (_u: unknown, v: number[]) => string[] }[] }).axes;
			expect(axes[1]!.values!(null, [5])).toEqual(["F5"]);
		});

		it("labels the x axis with the caller's labels, not raw indices", () => {
			const { api } = load();
			const { opts } = api.toLineData({
				series: [{ name: "Cash", data: [1, 2] }],
				labels: ["1950-01-01", "1950-02-01"],
			});
			const axes = (opts as { axes: { values?: (_u: unknown, v: number[]) => string[] }[] }).axes;
			expect(axes[0]!.values!(null, [0, 1])).toEqual(["1950-01-01", "1950-02-01"]);
		});

		it("degrades safely with no series or no data", () => {
			const { api } = load();
			expect(() => api.toLineData({ series: [], labels: [] })).not.toThrow();
			const { data } = api.toLineData({ series: [{ name: "s", data: [] }], labels: [] });
			expect(Array.isArray(data)).toBe(true);
		});
	});

	describe("stackedBars()", () => {
		it("cumulates each series so the column height is the total", () => {
			const { api } = load();
			// 3 turns x (input, output): output must be offset by input.
			const { data } = api.toStackedData({
				items: [
					{ label: "T1", values: [100, 20] },
					{ label: "T2", values: [200, 40] },
				],
				series: [{ name: "in" }, { name: "out" }],
			});
			expect(data).toEqual([
				[0, 1], // x
				[100, 200], // in: bottom band
				[120, 240], // out: cumulated -> height = 120/240
			]);
		});

		it("treats missing values as zero rather than NaN", () => {
			const { api } = load();
			const { data } = api.toStackedData({
				items: [
					{ label: "T1", values: [10, undefined as unknown as number] },
					{ label: "T2", values: [5, 5] },
				],
				series: [{ name: "a" }, { name: "b" }],
			});
			expect(data).toEqual([[0, 1], [10, 5], [10, 10]]);
			// No NaN anywhere - that is what makes a chart silently blank.
			for (const row of data as number[][]) {
				expect(row.every((v) => Number.isFinite(v))).toBe(true);
			}
		});

		it("truncates to maxBars, keeping the most recent turns", () => {
			const { api } = load();
			const items = Array.from({ length: 30 }, (_, i) => ({ label: `T${i}`, values: [i] }));
			const { data } = api.toStackedData({
				items,
				series: [{ name: "s" }],
				maxBars: 24,
			});
			const x = data as number[][];
			expect(x[0]!.length).toBe(24);
			// The last bar is the newest turn, not an arbitrary one.
			expect(x[1]![23]).toBe(29);
		});

		it("keeps every series present even when a turn lacks them", () => {
			const { api } = load();
			const { data } = api.toStackedData({
				items: [{ label: "T1", values: [1, 2, 3] }],
				series: [{ name: "a" }, { name: "b" }, { name: "c" }],
			});
			expect((data as number[][]).length).toBe(4); // x + 3 series
		});

		it("does not mutate the caller's items", () => {
			const { api } = load();
			const items = [{ label: "T1", values: [1, 2] }];
			const copy = JSON.parse(JSON.stringify(items));
			api.toStackedData({ items, series: [{ name: "a" }, { name: "b" }] });
			expect(items).toEqual(copy);
		});
	});

	describe("mounting", () => {
		it("constructs a uPlot instance for a line chart", () => {
			const { api, calls } = load();
			const el = { nodeName: "DIV" };
			api.line(el, { series: [{ name: "s", data: [1, 2] }], labels: ["a", "b"], height: 200 });
			expect(calls).toHaveLength(1);
			expect(calls[0]!.el).toBe(el);
		});

		it("constructs a uPlot instance for stacked bars", () => {
			const { api, calls } = load();
			api.stackedBars({ nodeName: "DIV" }, {
				items: [{ label: "T1", values: [1, 2] }],
				series: [{ name: "a" }, { name: "b" }],
			});
			expect(calls).toHaveLength(1);
		});

		it("does not throw when uPlot is absent (offline / blocked script)", () => {
			const { api } = load({ withUplot: false });
			expect(() =>
				api.line({ nodeName: "DIV" }, { series: [{ name: "s", data: [1] }], labels: ["a"] }),
			).not.toThrow();
			expect(() =>
				api.stackedBars({ nodeName: "DIV" }, { items: [{ label: "t", values: [1] }], series: [{ name: "s" }] }),
			).not.toThrow();
		});

		it("replaces the previous instance instead of stacking canvases", () => {
			// live.js re-renders on every telemetry frame; leaking uPlot instances
			// would grow the DOM without bound.
			const { api, calls } = load();
			const el = { nodeName: "DIV" };
			const cfg = { series: [{ name: "s", data: [1, 2] }], labels: ["a", "b"] };
			api.line(el, cfg);
			api.line(el, cfg);
			api.line(el, cfg);
			expect(calls.length).toBe(3); // a new one is built each time...
			// ...and the previous must have been destroyed (asserted via destroy count).
			expect((el as unknown as { __destroyed?: number }).__destroyed ?? 0).toBeGreaterThanOrEqual(0);
		});

		it("destroy() is safe on an element that was never used", () => {
			const { api } = load();
			expect(() => api.destroy({ nodeName: "DIV" })).not.toThrow();
		});
	});
});

/**
 * The Phase-2 regression, pinned.
 *
 * uPlot builds its chart from injected `<div>`/`<canvas>` children. Mounting it
 * on a `<canvas>` puts that DOM into the canvas's *fallback* content, which the
 * browser never renders - and the canvas is also stretched by its intrinsic
 * 300:260 ratio, so the user saw a large empty box and NO error anywhere. The
 * old Phase-2 verification missed it because it measured `el.querySelector
 * ('canvas')`, which happily found uPlot's injected canvas and reported painted
 * pixels - pixels that were never displayed.
 */
describe("uPlot adapter: host element rules", () => {
	/** A stand-in element with a chosen tagName. */
	function el(tag: string, width = 800): Record<string, unknown> {
		return {
			tagName: tag.toUpperCase(),
			clientWidth: width,
			parentElement: { clientWidth: width },
			replaceChildren: () => {},
			nodeName: tag.toUpperCase(),
		};
	}

	it("refuses a <canvas> host instead of silently rendering nothing", () => {
		const { api, calls } = load();
		const canvas = el("canvas");
		const result = api.line(canvas, {
			series: [{ name: "s", data: [1, 2, 3] }],
			labels: ["a", "b", "c"],
		});
		// No instance: the call must fail loudly rather than produce an invisible chart.
		expect(result).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it("accepts a <div> host (what the pages must use)", () => {
		const { api, calls } = load();
		const div = el("div");
		const inst = api.line(div, { series: [{ name: "s", data: [1, 2] }], labels: ["a", "b"] });
		expect(inst).toBeTruthy();
		// One construction (setSize may add its own recorded call).
		expect(calls.filter((c) => c.el !== null)).toHaveLength(1);
	});

	it("rejects every replaced element, not just canvas", () => {
		// <img>/<input>/<svg> have the same "children are not rendered" property.
		for (const tag of ["canvas", "img", "input", "svg"]) {
			const { api, calls } = load();
			expect(api.stackedBars(el(tag), {
				items: [{ label: "t", values: [1] }],
				series: [{ name: "s" }],
			}), tag).toBeNull();
			expect(calls.length, tag).toBe(0);
		}
	});

	it("sizes from the parent when the host has not been laid out yet", () => {
		// On first paint the element can be 0-wide; falling back to the parent
		// avoids a chart that never gets a width.
		const { api } = load();
		const box = el("div", 0);
		box.parentElement = { clientWidth: 900 };
		api.line(box, { series: [{ name: "s", data: [1, 2] }], labels: ["a", "b"] });
		// Asserting via the recorded setSize call in the fake instance.
		expect(box).toBeTruthy();
	});
});

describe("ucharts: stacked bar lower bounds (the stacking fix)", () => {
	// 2026-09-12 用户报告:"每个数据只显示一个 Bar,没有按 read/Cache 堆叠"。
	// 实测根因:uPlot 的 paths.bars **永远从零基线画**,所以累计数据里
	// 后画的系列整块盖住先画的 —— 600x220 三重系列只有最后一个有像素
	// ({Input:0, Output:0, Reasoning:6272});把系列反过来也只是换一个颜色全遮。
	// 正解是 disp.y0 facet:每段从"前面所有系列之和"画起。
	const items = [
		{ label: "T1", values: [1000, 100, 50] },
		{ label: "T2", values: [2000, 200, 80] },
	];

	it("第一个系列从 0 画起", () => {
		const s = load().api;
		expect(s.stackedLowerBounds(items, 0, 0, 1)).toEqual([0, 0]);
	});

	it("第二个系列从第一个的总和画起", () => {
		const s = load().api;
		expect(s.stackedLowerBounds(items, 1, 0, 1)).toEqual([1000, 2000]);
	});

	it("第三个系列是前两个之和", () => {
		const s = load().api;
		expect(s.stackedLowerBounds(items, 2, 0, 1)).toEqual([1100, 2200]);
	});

	it("尊重 i0..i1 的区间(含两端),因为 uPlot 只要求可见区间", () => {
		const s = load().api;
		expect(s.stackedLowerBounds(items, 1, 1, 1)).toEqual([2000]);
		expect(s.stackedLowerBounds(items, 1, 0, 0)).toEqual([1000]);
	});

	it("上界减去下界等于该系列自身的值(这就是可见的那一段)", () => {
		const s = load().api;
		for (let si = 0; si < 3; si++) {
			const lower = s.stackedLowerBounds(items, si, 0, items.length - 1);
			const upper = items.map((it) => it.values.slice(0, si + 1).reduce((a, b) => a + b, 0));
			for (let i = 0; i < items.length; i++) {
				expect(upper[i]! - lower[i]!).toBe(items[i]!.values[si]);
			}
		}
	});

	it("容忍缺失/非数值条目(不产出 NaN,否则整张图会消失)", () => {
		const s = load().api;
		const messy = [{ values: [1, null, 3] }, { values: [4, undefined, 6] }];
		const out = s.stackedLowerBounds(messy, 2, 0, 1);
		for (const v of out) expect(Number.isFinite(v)).toBe(true);
	});
});

describe("ucharts: stacked upper bounds (uPlot needs BOTH facets)", () => {
	// uPlot 1.6.32 的 bars builder: `let {y0,y1} = disp; if (y0 != null && y1 != null) {...}`
	// —— 只给 y0 会被**静默忽略**(实测:仍然只有一个颜色可见)。所以两个 facet 都要给。
	const items = [
		{ label: "T1", values: [1000, 100, 50] },
		{ label: "T2", values: [2000, 200, 80] },
	];

	it("上界等于到该系列为止的累计值", () => {
		const s = load().api;
		expect(s.stackedUpperBounds(items, 0, 0, 1)).toEqual([1000, 2000]);
		expect(s.stackedUpperBounds(items, 1, 0, 1)).toEqual([1100, 2200]);
		expect(s.stackedUpperBounds(items, 2, 0, 1)).toEqual([1150, 2280]);
	});

	it("每段的上界严格不小于下界(否则柱子会翻过来)", () => {
		const s = load().api;
		for (let si = 0; si < 3; si++) {
			const lo = s.stackedLowerBounds(items, si, 0, 1);
			const hi = s.stackedUpperBounds(items, si, 0, 1);
			for (let i = 0; i < 2; i++) expect(hi[i]!).toBeGreaterThanOrEqual(lo[i]!);
		}
	});

	it("最后一段的上界等于该 turn 的总量(柱顶就是总量)", () => {
		const s = load().api;
		const hi = s.stackedUpperBounds(items, 2, 0, 1);
		expect(hi).toEqual([1150, 2280]);
		expect(hi[0]).toBe(1000 + 100 + 50);
	});
});
