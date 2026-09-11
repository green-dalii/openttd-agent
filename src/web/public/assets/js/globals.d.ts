/**
 * Ambient declarations for the front-end globals.
 *
 * 职责: 让 `tsc --checkJs`（见 `tsconfig.frontend.json`）能检查
 *   `src/web/public/assets/js/*.js`。这些脚本不经过构建链，只靠
 *   `window.UI` / `window.Charts` 通信，此前**完全不被任何类型系统覆盖**。
 *
 * 为什么需要（2026-09-11 事故）: `stackedBars` 的 hover 回调读了
 *   `draw()` 作用域里的 `st`，真实后果是"鼠标悬停 Token Usage 图表时
 *   tooltip 不出来"。这类**未定义标识符**（TS2304）在没有类型检查时
 *   只能靠运行时发现。有了本文件，tsc 会在提交前报出来。
 *
 * 设计取舍:
 *   - 方法签名一律宽松（`any`）：目的是查**名字写错/作用域错误**，
 *     不是给手写 JS 补一套严格类型（那会逼着改运行时代码）。
 *   - 显式列出真实成员而非 `[key: string]: unknown` 索引签名：
 *     索引签名会让 `U.fmtInt2(...)` 静默通过，等于没查。
 * 禁止: 在此写业务逻辑；不要为了迁就类型去改运行时行为。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Element handle returned by `U.$`. Permissive: pages touch many properties. */
type UiElement = any;

interface UiModule {
	// dom
	$(id: string): UiElement;
	esc(v: any): string;
	// format
	fmtInt(v: any): string;
	fmtMoney(v: any): string;
	fmtTok(v: any): string;
	fmtCost(v: any): string;
	fmtDuration(v: any): string;
	fmtAgo(v: any): string;
	fmtClock(v: any): string;
	fmtPct(v: any, decimals?: any): string;
	fmtGameDate(v: any): string;
	deltaClass(v: any): string;
	deltaChip(v: any): string;
	// events
	categoryOf(e: any): string;
	categoryClass(c: any): string;
	categoryLabel(c: any): string;
	categoryCounts(events: any): { counts: Record<string, number>; total: number; order: string[] };
	eventMatches(e: any, query: any): boolean;
	briefOf(e: any): string;
	// widgets
	toast(msg: any, kind?: any, ttlMs?: any): void;
	confirmDialog(o: any): Promise<boolean>;
	combobox(root: any, opts: any): any;
	segmented(root: any, opts: any): any;
	kpi(o: any): string;
	paintSparks(root: any, perTile?: any): void;
	/**
	 * Container-local scrolling: never touch an ancestor (the document included),
	 * which `Element.scrollIntoView` does. See the helpers in common.js.
	 */
	scrollToEnd(el: any): boolean;
	keepVisible(container: any, child: any): boolean;
	// prefs
	getPref(key: string, fallback?: any): any;
	setPref(key: string, value: any): void;
	// charts helpers
	PALETTE: string[];
	pickColor(i: number): string;
	utilTotals(items: any): number;
	// infra
	connectWs(handlers: any): any;
	renderNav(active: string): string;
	/**
	 * Added later by alpine-bridge.js, so it is optional: common.js defines the
	 * object without it and pages that load the bridge get it.
	 */
	renderNavInto?(id: string, active: string): void;
}

interface ChartsUtil {
	niceTicks(min: number, max: number, count?: number): number[];
	niceDomain(min: number, max: number, opts?: any): number[];
	scaleLinear(domain: number[], range: number[]): (v: number) => number;
	donutSlices(values: number[], opts?: any): any[];
	fmtCompact(v: any): string;
	niceNum(range: number, round: boolean): number;
	fractionsOf(values: number[]): number[];
	stackTotals(items: any, seriesCount: number): any;
	zeroBasedDomain(max: number, count?: number): number[];
}

interface ChartsModule {
	line(canvas: any, cfg: any): void;
	bars(canvas: any, cfg: any): void;
	stackedBars(canvas: any, cfg: any): void;
	donut(canvas: any, cfg: any): void;
	sparkline(canvas: any, data: number[], cfg?: any): void;
	stageMap(canvas: any, view: any): void;
	destroy(canvas: any): void;
	util: ChartsUtil;
}

interface Window {
	UI: UiModule;
	Charts: ChartsModule;
	[key: string]: any;
}
