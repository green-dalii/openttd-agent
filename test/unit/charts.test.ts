/**
 * Unit tests — chart module (no browser, no canvas, no DOM).
 *
 * 职责: 在 node:vm 沙箱里加载 `assets/js/charts.js`，验证**纯计算**部分
 *   （刻度/定义域/比例尺/环图弧段/数字压缩）与「加载期不碰 DOM」这一关键约束。
 * 为什么能这样测: charts.js 只暴露 window.Charts，且加载期不读 document/
 *   devicePixelRatio（只能在绘制函数内读）—— 见 docs/DASHBOARD-UI.md §4。
 * 禁止: 在此引入 jsdom/canvas 依赖（保持零依赖；绘制路径由真机 E2E 覆盖）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/charts.js"), "utf8");

interface ChartUtil {
	niceTicks: (min: number, max: number, count?: number) => number[];
	niceDomain: (min: number, max: number, opts?: { includeZero?: boolean }) => number[];
	scaleLinear: (domain: number[], range: number[]) => (v: number) => number;
	donutSlices: (
		values: number[],
		opts?: { slices?: { label?: string; color?: string }[]; startAngle?: number },
	) => { frac: number; startAngle: number; endAngle: number; color: string; label: string }[];
	fmtCompact: (v: unknown) => string;
	niceNum: (range: number, round: boolean) => number;
	fractionsOf: (values: number[]) => number[];
	stackTotals: (
		items: { values: number[] }[],
		seriesCount: number,
	) => { totals: number[]; total: number; maxStack: number };
	zeroBasedDomain: (max: number, count?: number) => number[];
}

interface FakeCanvasLike {
	clientWidth: number;
	width: number;
	height: number;
	style: Record<string, string>;
	getAttribute: (n: string) => string | null;
	getContext: () => unknown;
	addEventListener: () => void;
	getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
}

interface LineCfg {
	series: { name?: string; data: number[]; color?: string }[];
	labels?: string[];
	format?: (v: number) => string;
	area?: boolean;
	yZero?: boolean;
	height?: number;
}

interface StackedCfg {
	items: { label: string; values: number[]; sub?: string }[];
	series: { name: string; color?: string }[];
	format?: (v: number) => string;
	height?: number;
	maxBars?: number;
}

interface ChartsGlobal {
	line: (canvas: FakeCanvasLike, cfg: LineCfg) => void;
	stackedBars: (canvas: FakeCanvasLike, cfg: StackedCfg) => void;
	bars: unknown;
	donut: unknown;
	sparkline: unknown;
	destroy: unknown;
	util: ChartUtil;
}

/** Minimal 2D-context stub: records call counts, returns nothing meaningful. */
function fakeCtx(): {
	calls: Record<string, number>;
	fills: { minY: number; maxY: number }[];
} & Record<string, unknown> {
	const calls: Record<string, number> = {};
	const noop = (name: string) => () => {
		calls[name] = (calls[name] || 0) + 1;
	};
	// Path recorder: lets tests assert drawn geometry (e.g. "bar reaches floor").
	const fills: { minY: number; maxY: number }[] = [];
	let pathY: number[] = [];
	const ctx: Record<string, unknown> = { calls, fills };
	for (const m of [
		"setTransform", "clearRect", "fillRect", "stroke", "arc", "fillText",
		"save", "restore", "setLineDash", "strokeRect",
	]) {
		ctx[m] = noop(m);
	}
	// Track the y extent of each filled path.
	ctx.beginPath = () => {
		pathY = [];
		calls.beginPath = (calls.beginPath || 0) + 1;
	};
	const recordY = (name: string) => (...args: unknown[]) => {
		const y = args.length >= 2 ? Number(args[1]) : Number(args[0]);
		if (Number.isFinite(y)) pathY.push(y);
		calls[name] = (calls[name] || 0) + 1;
	};
	ctx.moveTo = recordY("moveTo");
	ctx.lineTo = recordY("lineTo");
	ctx.quadraticCurveTo = (...args: unknown[]) => {
		// (cx, cy, x, y): the endpoint and control point both lie on the path
		for (const v of [Number(args[1]), Number(args[3])]) {
			if (Number.isFinite(v)) pathY.push(v);
		}
		calls.quadraticCurveTo = (calls.quadraticCurveTo || 0) + 1;
	};
	ctx.closePath = noop("closePath");
	ctx.fill = () => {
		if (pathY.length) fills.push({ minY: Math.min(...pathY), maxY: Math.max(...pathY) });
		calls.fill = (calls.fill || 0) + 1;
	};
	ctx.measureText = () => ({ width: 10 });
	ctx.createLinearGradient = () => ({ addColorStop: () => {} });
	ctx.getImageData = () => ({ data: new Uint8ClampedArray(0) });
	return ctx as {
		calls: Record<string, number>;
		fills: { minY: number; maxY: number }[];
	} & Record<string, unknown>;
}

/** Minimal canvas stub. clientWidth models the CSS layout width. */
function fakeCanvas(clientWidth: number, ctx: unknown): FakeCanvasLike {
	return {
		clientWidth,
		width: 300, // the default backing store we must overwrite
		height: 150,
		style: {} as Record<string, string>,
		getAttribute: () => null,
		getContext: () => ctx,
		addEventListener: () => {},
		getBoundingClientRect: () => ({ left: 0, top: 0, width: clientWidth, height: 150 }),
	};
}

/** Load charts.js in a bare sandbox (no document => proves load-time purity). */
function load(): { charts: ChartsGlobal; sandbox: Record<string, unknown> } {
	const sandbox: Record<string, unknown> = { window: {}, devicePixelRatio: 1 };
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return { charts: (sandbox.window as { Charts: ChartsGlobal }).Charts, sandbox };
}

describe("charts module", () => {
	it("loads in a sandbox with no document and exposes the frozen API", () => {
		const { charts } = load();
		expect(typeof charts.line).toBe("function");
		expect(typeof charts.bars).toBe("function");
		expect(typeof charts.donut).toBe("function");
		expect(typeof charts.sparkline).toBe("function");
		expect(typeof charts.destroy).toBe("function");
		for (const k of ["niceTicks", "niceDomain", "donutSlices", "fmtCompact", "scaleLinear"]) {
			expect(typeof charts.util[k as keyof ChartUtil], `util.${k}`).toBe("function");
		}
	});

	it("compacts numbers for KPI/tile display", () => {
		const { util } = load().charts;
		expect(util.fmtCompact(0)).toBe("0");
		expect(util.fmtCompact(999)).toBe("999");
		expect(util.fmtCompact(1500)).toBe("1.5k");
		expect(util.fmtCompact(1500000)).toBe("1.5M");
		expect(util.fmtCompact(-2000000)).toBe("-2M");
		// Non-finite input must render a placeholder, never "NaN".
		expect(util.fmtCompact(NaN)).toBe("—");
		expect(util.fmtCompact("nonsense")).toBe("—");
	});

	it("produces ascending round ticks that cover the range", () => {
		const { util } = load().charts;
		const ticks = util.niceTicks(0, 97, 5);
		expect(ticks.length).toBeGreaterThanOrEqual(3);
		expect(ticks[0]).toBeLessThanOrEqual(0);
		expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(97);
		for (let i = 1; i < ticks.length; i++) {
			expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
			expect(Number.isFinite(ticks[i]!)).toBe(true);
		}
	});

	it("never returns empty or NaN ticks, even for a degenerate range", () => {
		const { util } = load().charts;
		for (const [a, b] of [[5, 5], [0, 0], [-3, -3], [1, -1]] as const) {
			const ticks = util.niceTicks(a, b);
			expect(ticks.length, `niceTicks(${a},${b})`).toBeGreaterThan(0);
			expect(ticks.every((t) => Number.isFinite(t)), `niceTicks(${a},${b}) finite`).toBe(true);
		}
		// Non-numeric input degrades to [] rather than throwing.
		expect(util.niceTicks(NaN, 10)).toEqual([]);
	});

	it("expands a domain outwards and can force-include zero", () => {
		const { util } = load().charts;
		const [lo, hi] = util.niceDomain(120, 480);
		expect(lo).toBeLessThanOrEqual(120);
		expect(hi).toBeGreaterThanOrEqual(480);

		const [z0, z1] = util.niceDomain(50, 90, { includeZero: true });
		expect(z0).toBeLessThanOrEqual(0);
		expect(z1).toBeGreaterThanOrEqual(90);
	});

	it("maps a domain onto a range at both ends and the midpoint", () => {
		const { util } = load().charts;
		const y = util.scaleLinear([0, 100], [200, 0]); // inverted, like a y-axis
		expect(y(0)).toBe(200);
		expect(y(100)).toBe(0);
		expect(y(50)).toBe(100);
		// Degenerate domain must not produce NaN.
		const flat = util.scaleLinear([7, 7], [0, 10]);
		expect(Number.isFinite(flat(7))).toBe(true);
	});

	it("turns values into donut arcs whose fractions sum to the full circle", () => {
		const { util } = load().charts;
		const slices = util.donutSlices([1, 3], { slices: [{ label: "a", color: "#111111" }, { label: "b", color: "#222222" }] });
		expect(slices).toHaveLength(2);
		expect(slices[0]!.frac).toBeCloseTo(0.25, 6);
		expect(slices[1]!.frac).toBeCloseTo(0.75, 6);
		expect(slices[0]!.label).toBe("a");
		expect(slices[1]!.color).toBe("#222222");
		const total = slices.reduce((a, s) => a + s.frac, 0);
		expect(total).toBeCloseTo(1, 6);
		// Contiguous arcs: each starts where the previous ended.
		expect(slices[1]!.startAngle).toBeCloseTo(slices[0]!.endAngle, 9);
		expect(slices[1]!.endAngle - slices[0]!.startAngle).toBeCloseTo(Math.PI * 2, 9);
	});

	it("sizes the canvas even when a chart has no data yet", () => {
		// Regression: the empty state used to skip fit(), leaving the default
		// 300x200 backing store. With `canvas{width:100%}` and no CSS height that
		// rendered a 3:2 box (449px tall) which jumped in height the moment real
		// data arrived. The empty state must set the same box as a populated one.
		const ctx = fakeCtx();
		const canvas = fakeCanvas(674, ctx);
		load().charts.line(canvas, { series: [], height: 200 });
		expect(canvas.width).toBe(674); // clientWidth * dpr(1)
		expect(canvas.height).toBe(200);
		expect(canvas.style.height).toBe("200px");
		// And it must not throw, nor draw a series (no ctx call at all).
		expect(ctx.calls.stroke ?? 0).toBe(0);
		expect(ctx.calls.lineTo ?? 0).toBe(0);
	});

	it("draws grid, axis labels and a series line for populated data", () => {
		const ctx = fakeCtx();
		const canvas = fakeCanvas(600, ctx);
		load().charts.line(canvas, {
			series: [{ name: "cash", data: [0, 10, 5, 20] }],
			labels: ["a", "b", "c", "d"],
			height: 200,
		});
		expect(canvas.width).toBe(600);
		expect(ctx.calls.stroke).toBeGreaterThan(3); // grid + series
		expect(ctx.calls.fillText).toBeGreaterThan(3); // y ticks (+ x end labels)
		expect(ctx.calls.lineTo).toBeGreaterThan(2); // the polyline
	});

	it("stacks series per item and reports totals + the tallest stack", () => {
		const { util } = load().charts;
		const r = util.stackTotals(
			[
				{ values: [100, 20, 5] },
				{ values: [250, 10, 1] },
				{ values: [0, 0, 0] },
			],
			3,
		);
		expect(r.totals).toEqual([125, 261, 0]);
		expect(r.total).toBe(386);
		expect(r.maxStack).toBe(261);
	});

	it("ignores extra values beyond the declared series count", () => {
		const { util } = load().charts;
		const r = util.stackTotals([{ values: [10, 10, 10] }], 2);
		expect(r.totals).toEqual([20]); // the 3rd value has no series colour
		expect(r.maxStack).toBe(20);
	});

	it("handles empty and malformed stack input without NaN", () => {
		const { util } = load().charts;
		expect(util.stackTotals([], 3)).toEqual({ totals: [], total: 0, maxStack: 0 });
		const r = util.stackTotals([{ values: [] }, { values: [NaN, 5] }], 2);
		expect(r.totals[0]).toBe(0);
		expect(Number.isFinite(r.totals[1]!)).toBe(true);
		expect(Number.isFinite(r.maxStack)).toBe(true);
	});

	it("gives bar charts a zero-based domain (bars must start at 0)", () => {
		// Regression: niceDomain() pads ~4% below the minimum, so a non-negative
		// series got an axis running to -200 and left a dead band under every bar
		// (measured: bars started ~30px above the baseline).
		const { util } = load().charts;
		const [lo, hi] = util.zeroBasedDomain(923);
		expect(lo).toBe(0);
		expect(hi).toBeGreaterThanOrEqual(923);
		// and it must not collapse on degenerate input
		expect(util.zeroBasedDomain(0)).toEqual([0, 1]);
		expect(util.zeroBasedDomain(-5)).toEqual([0, 1]);
		expect(Number.isFinite(util.zeroBasedDomain(NaN)[1]!)).toBe(true);
	});

	it("draws bars from the baseline (no dead band under them)", () => {
		const ctx = fakeCtx();
		const canvas = fakeCanvas(600, ctx);
		load().charts.stackedBars(canvas, {
			items: [{ label: "t1", values: [100] }],
			series: [{ name: "x", color: "#5fb3ff" }],
			height: 220,
		});
		// The bar must reach the plot floor: padT(12) + innerH(220-12-26) = 194.
		// With the old padded domain it stopped ~30px short of this.
		expect(ctx.fills.length).toBeGreaterThan(0);
		expect(Math.round(ctx.fills[0]!.maxY)).toBeGreaterThanOrEqual(190);
	});

	it("draws stacked columns for composition over time", () => {
		// This is the fix for the token panel: a line chart collapsed the series
		// onto the same pixels (measured 3px apart), while stacking shows both the
		// total per turn and its split.
		const ctx = fakeCtx();
		const canvas = fakeCanvas(600, ctx);
		load().charts.stackedBars(canvas, {
			items: [
				{ label: "t1", values: [830, 40, 10] },
				{ label: "t2", values: [1200, 30, 8] },
			],
			series: [
				{ name: "Input", color: "#5fb3ff" },
				{ name: "Output", color: "#7bc96f" },
				{ name: "Reasoning", color: "#c3a6ff" },
			],
			height: 200,
		});
		expect(canvas.width).toBe(600);
		expect(canvas.height).toBe(200);
		expect(ctx.calls.fill ?? 0).toBeGreaterThanOrEqual(6); // 2 bars x 3 segments
		expect(ctx.calls.fillText ?? 0).toBeGreaterThan(3); // y ticks + labels
	});

	it("still sizes the canvas when there is nothing to stack", () => {
		const ctx = fakeCtx();
		const canvas = fakeCanvas(674, ctx);
		load().charts.stackedBars(canvas, { items: [], series: [], height: 200 });
		expect(canvas.width).toBe(674);
		expect(canvas.height).toBe(200);
	});

	it("handles an all-zero donut without NaN", () => {
		const { util } = load().charts;
		const slices = util.donutSlices([0, 0]);
		expect(slices).toHaveLength(2);
		for (const s of slices) {
			expect(s.frac).toBe(0);
			expect(Number.isFinite(s.startAngle)).toBe(true);
			expect(Number.isFinite(s.endAngle)).toBe(true);
		}
		expect(util.fractionsOf([])).toEqual([]);
		expect(util.fractionsOf([0, 0])).toEqual([0, 0]);
	});
});
