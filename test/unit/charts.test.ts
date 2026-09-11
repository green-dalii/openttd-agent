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

interface ChartsGlobal {
	line: (canvas: FakeCanvasLike, cfg: LineCfg) => void;
	bars: unknown;
	donut: unknown;
	sparkline: unknown;
	destroy: unknown;
	util: ChartUtil;
}

/** Minimal 2D-context stub: records call counts, returns nothing meaningful. */
function fakeCtx(): { calls: Record<string, number> } & Record<string, unknown> {
	const calls: Record<string, number> = {};
	const noop = (name: string) => () => {
		calls[name] = (calls[name] || 0) + 1;
	};
	const ctx: Record<string, unknown> = { calls };
	for (const m of [
		"setTransform", "clearRect", "fillRect", "beginPath", "moveTo", "lineTo",
		"stroke", "fill", "arc", "fillText", "save", "restore", "closePath",
		"setLineDash", "quadraticCurveTo", "strokeRect", "measureText",
	]) {
		ctx[m] = noop(m);
	}
	ctx.measureText = () => ({ width: 10 });
	ctx.createLinearGradient = () => ({ addColorStop: () => {} });
	ctx.getImageData = () => ({ data: new Uint8ClampedArray(0) });
	return ctx as { calls: Record<string, number> } & Record<string, unknown>;
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
