/**
 * Unit tests — container-local scrolling.
 *
 * 职责: 锁定"更新一个列表只滚它自己"这一行为。
 *
 * 为什么单独立项（2026-09-11 用户报告）: Agent steps 每追加一条就调用
 *   `el.scrollIntoView({block:"nearest"})`。这个 API 会滚动**所有可滚动祖先，
 *   包括文档本身**，于是一个局部列表的更新把整个页面顶走 —— 用户在读别处时
 *   页面反复自己往下跳。修复是改为直接设置容器的 `scrollTop`。
 *
 * 禁止: 在页面脚本里用 `scrollIntoView` 做"跟随最新"（见 web-assets.test.ts 的静态护栏）。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { PUBLIC_DIR } from "../../src/web/server.js";

const SRC = readFileSync(join(PUBLIC_DIR, "assets/js/common.js"), "utf8");

interface Ui {
	scrollToEnd: (el: unknown) => boolean;
	keepVisible: (container: unknown, child: unknown) => boolean;
}

function ui(): Ui {
	const sandbox: Record<string, unknown> = {
		document: { getElementById: () => null, createElement: () => ({}), body: {} },
		console, Intl, Date, Number, String, Math, JSON, Object, Array, Set, Map, Promise, Error,
		localStorage: { getItem: () => null, setItem: () => {} },
	};
	sandbox.window = sandbox;
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	return (sandbox.window as { UI: Ui }).UI;
}

/** A scrollable container stand-in. */
function box(scrollHeight: number, clientHeight: number, scrollTop = 0) {
	return { scrollHeight, clientHeight, scrollTop };
}

/**
 * A scrollable box whose on-screen rect is consistent with its scroll state:
 * the visible band is [top, top + clientHeight].
 */
function scroller(scrollTop: number, clientHeight: number, top = 100) {
	const el = {
		scrollHeight: 1000,
		clientHeight,
		scrollTop,
		getBoundingClientRect: () => ({ top, bottom: top + clientHeight }),
	};
	return el;
}

/** A child occupying [top, bottom] on screen. */
function child(top: number, bottom: number) {
	return { getBoundingClientRect: () => ({ top, bottom }) };
}

describe("scrollToEnd", () => {
	it("scrolls the element to its end", () => {
		const u = ui();
		const el = box(1000, 300);
		expect(u.scrollToEnd(el)).toBe(true);
		expect(el.scrollTop).toBe(1000);
	});

	it("does nothing when the content already fits", () => {
		// Avoids a pointless reflow on every render.
		const u = ui();
		const el = box(200, 300);
		expect(u.scrollToEnd(el)).toBe(false);
		expect(el.scrollTop).toBe(0);
	});

	it("survives a missing element", () => {
		const u = ui();
		expect(u.scrollToEnd(null)).toBe(false);
		expect(u.scrollToEnd(undefined)).toBe(false);
	});

	it("never touches anything above the element", () => {
		// The whole point: a page-level scroll container must not move.
		const u = ui();
		const page = box(5000, 800, 1200);
		const list = box(2000, 400);
		// The helper has no reference to `page`, so it cannot move — asserted by
		// construction, and by this explicit check.
		u.scrollToEnd(list);
		expect(page.scrollTop).toBe(1200);
		expect(list.scrollTop).toBe(2000);
	});
});

describe("keepVisible", () => {
	it("scrolls up only when the child is above the view", () => {
		const u = ui();
		const c = scroller(300, 200); // visible band is screen-y 100..300
		expect(u.keepVisible(c, child(50, 90))).toBe(true);
		expect(c.scrollTop).toBe(250); // 300 - (100-50)
	});

	it("scrolls down only when the child is below the view", () => {
		const u = ui();
		const c = scroller(300, 200);
		expect(u.keepVisible(c, child(320, 360))).toBe(true);
		expect(c.scrollTop).toBe(360); // 300 + (360-300)
	});

	it("does nothing when the child is already visible", () => {
		const u = ui();
		const c = scroller(300, 200);
		expect(u.keepVisible(c, child(150, 190))).toBe(false);
		expect(c.scrollTop).toBe(300);
	});

	it("survives missing elements", () => {
		const u = ui();
		expect(u.keepVisible(null, null)).toBe(false);
		expect(u.keepVisible(scroller(0, 100), null)).toBe(false);
	});
});
