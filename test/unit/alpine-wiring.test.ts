/**
 * Static guard: every Alpine **method call** (and compared state field) in a
 * page template must exist in that page's Alpine component(s).
 *
 * 为什么要这条守卫（2026-11-17，真实的返工）：
 * `compare.html` 里写了 `x-for="row in normalizedRunRows()"` 和
 * `x-show="normalizedMode === 'means'"`，但 `compare.js` 这个 Alpine 组件
 * **既没有 `normalizedRunRows()` 方法、也没有 `normalizedMode` 状态** ⇒
 * 页面在真实浏览器里报错（表达式求值失败 ⇒ 面板空/报错），而
 * `test/unit/compare-view.test.ts` **全绿** —— 因为它直接调用
 * `window.CompareView.normalizedRunRows`，**绕过了 Alpine 组件这一层**。
 *
 * ⇒ 单测覆盖的是 view module（纯函数），**覆盖不到组件接线**；
 * 这一层只能靠静态检查 ⇒ 所以要有这条守卫。
 *
 * 规则：
 * 1. 模板里 `foo(` ⇒ 组件（或它展开的 view module）里必须有 `foo`。
 * 2. 模板里 `foo === '...'`（比较一个状态字段）⇒ 组件里必须有 `foo:`。
 * 3. 模板自己的作用域（`x-for` 的循环变量）与字符串字面量里的英文单词**不算**。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * page → the components that page mounts (`x-data="..."`) and the view
 * modules those components spread in.
 *
 * `sessions.html` mounts **two** components (the run list and the memory
 * panel), `configure.html`'s component spreads **two** view modules ⇒ the
 * "available names" of a page are the union of all of them.
 */
const PAGES: { page: string; component: string; views: string[] }[] = [
	{
		page: "src/web/public/pages/compare.html",
		component: "src/web/public/assets/js/compare.js",
		views: ["src/web/public/assets/js/compare-view.js"],
	},
	{
		page: "src/web/public/pages/sessions.html",
		component: "src/web/public/assets/js/sessions.js",
		views: [
			"src/web/public/assets/js/sessions-view.js",
			"src/web/public/assets/js/evolution.js",
			"src/web/public/assets/js/evolution-view.js",
		],
	},
	{
		page: "src/web/public/pages/live.html",
		component: "src/web/public/assets/js/live.js",
		views: [
			"src/web/public/assets/js/live-view.js",
			"src/web/public/assets/js/timeline-view.js",
			"src/web/public/assets/js/stage-view-ui.js",
		],
	},
	{
		page: "src/web/public/pages/configure.html",
		component: "src/web/public/assets/js/providers.js",
		views: [
			"src/web/public/assets/js/providers-view.js",
			"src/web/public/assets/js/configure-view.js",
		],
	},
];

/** Alpine's own helpers — not the component's business. */
const BUILTINS = new Set(["$nextTick", "$dispatch", "$refs", "$el", "$watch", "$root", "$data", "$id"]);

/** The values of the Alpine attributes (the expressions). */
function alpineExpressions(html: string): string[] {
	const out: string[] = [];
	const attrRe = /(?:x-[a-z-]+|@[a-z:-]+|:[\w-]+)="([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = attrRe.exec(html))) out.push(m[1]!);
	return out;
}

/**
 * The loop variables of `x-for` — they live in the template's scope, not in
 * the component's ⇒ the guard must not ask the component to define them.
 */
function loopVariables(html: string): Set<string> {
	const names = new Set<string>();
	const re = /x-for="[^"]*?\b([A-Za-z_][\w]*)\s+in\s/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html))) names.add(m[1]!);
	return names;
}

/** Drop the string literals — English words in them are not calls. */
function stripStrings(expr: string): string {
	return expr
		.replace(/'[^']*'/g, "''")
		.replace(/"[^"]*"/g, '""')
		// Template literals: keep the `${...}` interpolations (they can call
		// methods), drop the English text around them.
		.replace(/`([^`]*)`/g, (_m, inner: string) => "`" + inner.replace(/[^${}]+/g, " ") + "`");
}

/** Method-call names (skip property accesses, globals and builtins). */
function calledMethods(exprs: string[]): Set<string> {
	const names = new Set<string>();
	for (const raw of exprs) {
		const expr = stripStrings(raw);
		const re = /(?<![\w$.])([a-zA-Z_][\w]*)\s*\(/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(expr))) {
			const name = m[1]!;
			if (BUILTINS.has(name)) continue;
			if (name === "in") continue; // the x-for keyword
			names.add(name);
		}
	}
	return names;
}

/** State fields the template compares against (`foo === 'x'`). */
function comparedFields(exprs: string[], loops: Set<string>): Set<string> {
	const names = new Set<string>();
	for (const raw of exprs) {
		const expr = stripStrings(raw);
		const re = /(?<![\w$.])([a-zA-Z_][\w]*)\s*(?:===|!==)/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(expr))) {
			const name = m[1]!;
			if (loops.has(name)) continue; // a template-scope loop variable
			names.add(name);
		}
	}
	return names;
}

describe("Alpine 接线守卫（模板用的东西必须真的在组件里）", () => {
	for (const { page, component, views } of PAGES) {
		const sources = () => [component, ...views].map((f) => readFileSync(f, "utf8")).join("\n");
		const defined = (name: string, sourcesText: string) => new RegExp(`\\b${name}\\s*[:(]`).test(sourcesText);

		it(`${page} 的模板方法都在组件里`, () => {
			const html = readFileSync(page, "utf8");
			const text = sources();
			const missing = [...calledMethods(alpineExpressions(html))].filter((n) => !defined(n, text));
			expect(missing, `${page} calls methods nobody defines: ${missing.join(", ")}`).toEqual([]);
		});

		it(`${page} 的模板状态字段都在组件里`, () => {
			const html = readFileSync(page, "utf8");
			const text = sources();
			const missing = [...comparedFields(alpineExpressions(html), loopVariables(html))].filter(
				(n) => !defined(n, text),
			);
			expect(missing, `${page} compares fields nobody defines: ${missing.join(", ")}`).toEqual([]);
		});
	}

	it("Compare 组件展开 view model（模板要什么方法，先在 view module 里存在）", () => {
		const js = readFileSync("src/web/public/assets/js/compare.js", "utf8");
		expect(js).toMatch(/const model = window\.CompareView\.create\(\)/);
		expect(js).toMatch(/\.\.\.model/);
	});

	it("Compare 组件有归一化表的模式状态（Issue #113 的 Compare 接线）", () => {
		const js = readFileSync("src/web/public/assets/js/compare.js", "utf8");
		expect(js).toMatch(/normalizedMode\s*:\s*"means"/);
		const viewJs = readFileSync("src/web/public/assets/js/compare-view.js", "utf8");
		expect(viewJs).toMatch(/normalizedRunRows\(\)\s*\{/);
		expect(viewJs).toMatch(/normalizedRunRows,/);
	});
});
