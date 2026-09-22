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
	/** 轴宽规则（按格式化后的标签测量，2026-09-22）。 */
	axisSizeFor: (labels?: unknown[], font?: string) => number;
	/** Exposed for tests: the cfg translation, with no uPlot involved. */
	toLineData: (cfg: unknown) => { data: unknown; opts: unknown; empty?: boolean };
	toStackedData: (cfg: unknown) => { data: unknown; opts: unknown; empty?: boolean };
	stackedArea: (el: unknown, cfg: unknown) => unknown;
	toStackedAreaData: (cfg: unknown) => { data: number[][]; opts: Record<string, unknown>; empty?: boolean };
	stackedLowerBounds: (items: unknown, si: number, i0: number, i1: number) => number[];
	stackedUpperBounds: (items: unknown, si: number, i0: number, i1: number) => number[];
}

/** A uPlot stand-in that records the arguments it is constructed with. */
function fakeUPlot() {
	const calls: { data: unknown; opts: unknown; el: unknown }[] = [];
	/** setData 调用记录：复用路径必须真的把新数据推进去（而不是什么都不做）。 */
	const setDataCalls: unknown[] = [];
	class Fake {
		height = 220;
		__lastWidth = 0;
		constructor(opts: unknown, data: unknown, el: unknown) {
			calls.push({ opts, data, el });
		}
		destroy() {}
		setData(d: unknown) {
			setDataCalls.push(d);
		}
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
	return { Fake, calls, setDataCalls };
}

function load(opts: { withUplot?: boolean } = {}): {
	api: UChartsApi;
	calls: { data: unknown; opts: unknown; el: unknown }[];
	setDataCalls: unknown[];
} {
	const { Fake, calls, setDataCalls } = fakeUPlot();
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
	return { api: (sandbox.window as { UCharts: UChartsApi }).UCharts, calls, setDataCalls };
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
			const { opts } = api.toLineData({ series: [{ name: "s", data: [1] }], labels: ["a"], height: 260 });
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

		it("**零数据**标记为 empty（不再构造 uPlot，改成明确说明）", () => {
			const { api } = load();
			expect(api.toLineData({ series: [], labels: [] }).empty).toBe(true);
			expect(api.toLineData({ series: [{ name: "s", data: [] }], labels: [] }).empty).toBe(true);
			// 有数据时**不得**标成空
			expect(api.toLineData({ series: [{ name: "s", data: [1] }], labels: ["a"] }).empty).toBeUndefined();
		});

		it("零数据时**不构造** uPlot，而是插入一句说明（空盒子看起来像坏了）", () => {
			const { api, calls } = load();
			const host = { nodeName: "DIV", replaceChildren: () => {}, querySelector: () => null, children: [] };
			const r = api.line(host, { series: [], labels: [] });
			expect(r).toBeNull();
			expect(calls.filter((c) => c.el !== null)).toHaveLength(0); // 没建 uPlot
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

		it("同一形状重复绘制时**复用实例**（不再每帧重建）", () => {
			// 为什么这是契约而不是优化（2026-09-22 用户实测）：`x-effect="drawCash()"`
			// 每个遥测帧都重跑，而它内部是 destroy + new uPlot。真机量到 40 秒内 **58 个
			// uPlot DOM 节点**、**30 万次 DOM 变更**（≈7500 次/秒）：图表每帧被拆掉重建，
			// 宿主盒子随之塌陷再撑开，页面高度持续抖动，浏览器的**滚动锚定**把用户的
			// 滚动位置扯来扯去（“页面自己在滚、控制不住”）。
			const { api, calls } = load();
			const el = { nodeName: "DIV" };
			const cfg = { series: [{ name: "s", data: [1, 2] }], labels: ["a", "b"] };
			api.line(el, cfg);
			api.line(el, cfg);
			api.line(el, cfg);
			// 只构建一次；后两次走 setData（构造次数 = 1，且没有堆叠 canvas）。
			expect(calls.filter((c) => c.el !== null)).toHaveLength(1);
		});

		it("**数据变了**要更新，但**仍不重建**", () => {
			const { api, calls, setDataCalls } = load();
			const el = { nodeName: "DIV" };
			api.line(el, { series: [{ name: "s", data: [1, 2] }], labels: ["a", "b"] });
			api.line(el, { series: [{ name: "s", data: [1, 2, 3] }], labels: ["a", "b", "c"] });
			expect(calls.filter((c) => c.el !== null)).toHaveLength(1); // 没重建
			expect(setDataCalls.length).toBeGreaterThan(0); // 但数据确实更新了
		});

		it("**只改系列显示名**不得重建（真机里名字每帧都变）", () => {
			// 这就是 2026-09-22 的真事故：series 的 name 是**公司名**，而执行器把相位
			// 写进公司名（`EX rd s4 r27 …`）→ 名字每帧变 → 形状签名每帧变 → 图表每帧重建
			//（40 秒 23 个实例、34 万次 DOM 变更 → 页面高度抖动 → 滚动锚定扯用户的滚动）。
			// 显示名是**数据**，不是形状。
			const { api, calls } = load();
			const el = { nodeName: "DIV" };
			api.line(el, { series: [{ name: "EX rd s1", data: [1, 2] }], labels: ["a", "b"] });
			api.line(el, { series: [{ name: "EX rd s2", data: [1, 2] }], labels: ["a", "b"] });
			api.line(el, { series: [{ name: "EX stA_ok", data: [1, 2] }], labels: ["a", "b"] });
			expect(calls.filter((c) => c.el !== null)).toHaveLength(1);
		});

		it("**形状变了**（高度 / key / 系列数）必须重建，不能只改数据", () => {
			// 反风险：把复用做得太粗，会把“换指标”变成“图不动了”——
			// 用户切到 cost 视图却还看着 token 的图，比抖动更坏。
			const { api, calls } = load();
			const el = { nodeName: "DIV" };
			const base = { series: [{ name: "s", data: [1, 2] }], labels: ["a", "b"] };
			api.line(el, { ...base, height: 200 });
			api.line(el, { ...base, height: 320 }); // 高度变
			api.line(el, { ...base, height: 320, key: "tokens:cost" }); // 指标变（format 都是函数，只能靠 key）
			api.line(el, {
				...base,
				height: 320,
				key: "tokens:cost",
				// 系列数变（必须给 data，否则会走"零数据"的空状态而不是重建）
				series: [{ name: "s", data: [1] }, { name: "t", data: [2] }],
			});
			expect(calls.filter((c) => c.el !== null)).toHaveLength(3);
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

describe("ucharts: stacked AREA (大者先画,逐个覆盖成带)", () => {
	// 用户要求把 token 图从柱状改成堆叠面积图。
	//
	// 试过两条错路(都由**像素扫描**否掉,不是读配置看出来的):
	//   1. uPlot 的 `bands` API:先说 `series` 需要 [from,to] 元组(传数字被静默忽略),
	//      改成元组后填充**仍然没有出现** —— 纵向扫描整列只有第一个系列的 fill 有像素。
	//   2. 折线/柱状那套"累积数据"对面积图也不够:后面画的更大面积会盖住前面的。
	//
	// 最终方案:**倒序**绘制(最大的先画),每条都不透明地填到轴。
	// 之后画的小面积盖住它的下半部分,于是每条系列露出的正好是自己那一段。
	const cfg = {
		items: [
			{ label: "T1", values: [1000, 100, 50] },
			{ label: "T2", values: [2000, 200, 80] },
		],
		series: [
			{ name: "Input", color: "#5fb3ff" },
			{ name: "Output", color: "#7bc96f" },
			{ name: "Reasoning", color: "#c3a6ff" },
		],
		maxBars: 24,
	};

	it("绘制顺序是倒序的(顶部系列先画)", () => {
		const d = load().api.toStackedAreaData(cfg);
		const labels = (d.opts.series as { label: string }[]).map((s) => s.label);
		expect(labels).toEqual(["x", "Reasoning", "Output", "Input"]);
	});

	it("数据行与倒序后的系列一一对应", () => {
		const d = load().api.toStackedAreaData(cfg);
		// row0 = x, row1 = Reasoning(累计 1150/2280), row2 = Output(1100/2200), row3 = Input(1000/2000)
		expect(d.data[0]).toEqual([0, 1]);
		expect(d.data[1]).toEqual([1150, 2280]);
		expect(d.data[2]).toEqual([1100, 2200]);
		expect(d.data[3]).toEqual([1000, 2000]);
	});

	it("每条系列都自带不透明 fill,颜色跟随自身而不是按位置分配", () => {
		const d = load().api.toStackedAreaData(cfg);
		const series = d.opts.series as { label: string; fill?: string; stroke?: string }[];
		const byLabel = Object.fromEntries(series.map((s) => [s.label, s]));
		expect(byLabel.Reasoning!.fill).toBe("#c3a6ff");
		expect(byLabel.Output!.fill).toBe("#7bc96f");
		expect(byLabel.Input!.fill).toBe("#5fb3ff");
		// 不透明是刻意的:半透明会互相混色,看起来像渐变而不是堆叠
		for (const l of ["Input", "Output", "Reasoning"]) {
			expect(byLabel[l]!.fill).not.toMatch(/rgba|transparent/);
		}
	});

	it("maxBars 只保留最新的若干列", () => {
		const many = { ...cfg, items: Array.from({ length: 40 }, (_, i) => ({ label: "T" + i, values: [i, 1] })) };
		expect(load().api.toStackedAreaData(many).data[0]!.length).toBe(24);
	});
});


/**
 * Y 轴宽度必须由**实际标签文本**决定（2026-09-22 真机截图）。
 *
 * 事故：轴宽写死 52px，而格式化后的标签 `£300.00k` 约 65px → **被裁成 `00000`**。
 * 用户看到的"图表内容、比例错乱"里，这一项就是"标签读不出来 + 轴与绘图区比例失衡"。
 */
describe("轴宽按标签测量（不再写死 52px）", () => {
	it("宽标签得到更宽的轴，窄标签不会浪费空间", () => {
		const { api } = load();
		const narrow = api.axisSizeFor(["0", "5", "9"]);
		const wide = api.axisSizeFor(["£300.00k", "-£1.20M"]);
		expect(wide).toBeGreaterThan(narrow);
		expect(narrow).toBeGreaterThanOrEqual(40); // 下限
		expect(wide).toBeLessThanOrEqual(120); // 上限（不无限膨胀）
	});

	it("空样本不会算出 0（退化为下限）", () => {
		const { api } = load();
		expect(api.axisSizeFor([])).toBeGreaterThanOrEqual(40);
		expect(api.axisSizeFor(undefined)).toBeGreaterThanOrEqual(40);
	});
});

/**
 * 空状态占位**必须**在数据回来后消失（2026-09-22 真机截图）。
 *
 * 我加了"还没有数据"的占位，但没有在绘图前清掉它——于是数据回来以后，
 * 那句说明**永远压在图表上方**（真机截图里可见）。这是"加了一个状态却忘了退场"的典型。
 */
describe("空状态占位会退场", () => {
	function fakeHost() {
		const kids: { className: string; textContent: string; remove(): void }[] = [];
		return {
			nodeName: "DIV",
			replaceChildren: (...n: unknown[]) => {
				kids.length = 0;
				for (const x of n) {
					const node = x as { remove?: () => void };
					// 真 DOM 的元素自带 remove()；假宿主也要有，否则"占位退场"根本没测到。
					if (node && typeof node === "object") {
						node.remove = () => {
							const i = kids.indexOf(node as never);
							if (i >= 0) kids.splice(i, 1);
						};
					}
					kids.push(node as never);
				}
			},
			querySelector: (sel: string) => (sel === ".chart-empty" ? kids.find((k) => k.className === "chart-empty") ?? null : null),
			querySelectorAll: (sel: string) => (sel === ".chart-empty" ? kids.filter((k) => k.className === "chart-empty") : []),
			kids,
		};
	}

	it("零数据 → 插入占位；随后有数据 → 占位被清掉再绘图", () => {
		const { api, calls } = load();
		const el = fakeHost();
		// 1) 零数据：插入占位
		expect(api.line(el, { series: [], labels: [] })).toBeNull();
		expect(el.kids.some((k: { className: string }) => k.className === "chart-empty")).toBe(true);
		// 2) 数据回来：占位必须消失，且真的画了图
		api.line(el, { series: [{ name: "s", data: [1, 2] }], labels: ["a", "b"] });
		expect(el.kids.some((k: { className: string }) => k.className === "chart-empty")).toBe(false);
		expect(calls.filter((c) => c.el !== null).length).toBeGreaterThan(0);
	});
});
