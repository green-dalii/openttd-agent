/**
 * Unit tests — Alpine 模板结构静态检查。
 *
 * 职责: 页面 HTML 用 Alpine 指令渲染，**没有任何构建期校验**。本文件锁住
 *   Alpine 对模板结构的硬性要求(根元素数量、`x-for` 的 `:key`)。
 * 事实来源: Alpine 的 `x-for` 契约 —— 模板内必须恰好一个根元素。
 * 禁止: 在此启动浏览器(真机 E2E 属于 test/live)。
 *
 * 起因(2026-09-12):用户的 Live 页满屏
 *   `Alpine Expression Error: ... reading 'children'` +
 *   `Uncaught ReferenceError: m is not defined`。
 * 根因是 `<template x-for>` 内放了两个兄弟 `<template x-if>`。
 * 我当时的 E2E 跑在 stageViews 为空的会话上,那个 `x-for` 从未渲染,
 * 所以"0 控制台错误"是假的(见 MEMORY.md A1)。本文件把这类错误提前到单测。
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	lintAlpineTemplates,
	lintTemplatesInsideSvg,
	lintXForKeys,
	lintXForNullable,
	topLevelElements,
} from "./helpers/alpine-lint.js";
import { PAGES } from "../../src/web/server.js";

/** 所有页面 HTML 的绝对路径(含 PAGES 路由表里没有的旧页面,一并检查)。 */
function allPageHtml(): Array<{ name: string; html: string }> {
	const dir = join(PAGES_DIR);
	const out: Array<{ name: string; html: string }> = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
		out.push({ name: entry.name, html: readFileSync(join(dir, entry.name), "utf8") });
	}
	return out;
}

const PAGES_DIR = join(process.cwd(), "src/web/public/pages");

describe("alpine: 页面模板结构", () => {
	const pages = allPageHtml();

	it("能找到页面文件(前提检查)", () => {
		expect(pages.length).toBeGreaterThanOrEqual(3);
		for (const p of pages) expect(p.html.length).toBeGreaterThan(200);
	});

	it("PAGES 路由表里的页面都在磁盘上", () => {
		for (const route of Object.values(PAGES)) {
			const rel = typeof route === "string" ? route : String(route);
			if (!rel.endsWith(".html")) continue;
			expect(pages.some((p) => rel.endsWith(p.name))).toBe(true);
		}
	});

	for (const page of pages) {
		it(`${page.name}: 每个 x-for / x-if 模板恰好一个根元素`, () => {
			const issues = lintAlpineTemplates(page.html);
			const detail = issues
				.map((i) => `  - 偏移 ${i.at}: <template ${i.tag}> ${i.problem}\n      指令: ${i.directive}`)
				.join("\n");
			expect(issues, `发现 ${issues.length} 处模板结构问题:\n${detail}`).toEqual([]);
		});

		it(`${page.name}: 没有 <template> 放在 <svg> 内部`, () => {
			// <template> inside <svg> is SVG-namespaced with no .content, so Alpine's
			// x-for throws "reading 'children'" and the loop variable never binds.
			const issues = lintTemplatesInsideSvg(page.html);
			const detail = issues.map((i) => `  - 偏移 ${i.at}: ${i.directive}`).join("\n");
			expect(issues, `发现 ${issues.length} 处 <svg> 内的 <template>:\n${detail}`).toEqual([]);
		});

		it(`${page.name}: 每个 x-for 都带 :key`, () => {
			const issues = lintXForKeys(page.html);
			const detail = issues.map((i) => `  - 偏移 ${i.at}: ${i.directive}`).join("\n");
			expect(issues, `缺少 :key 的 x-for:\n${detail}`).toEqual([]);
		});
	}
});

describe("alpine-lint: 检查器自身的正确性", () => {
	it("tokenizeTags 不被属性值里的 > 骗到", () => {
		const html = `<div x-if="a > b"><span>ok</span></div>`;
		const roots = topLevelElements(html);
		expect(roots).toEqual(["div"]);
	});

	it("tokenizeTags 忽略注释里的标签", () => {
		const roots = topLevelElements(`<!-- <div></div> --><p>hi</p>`);
		expect(roots).toEqual(["p"]);
	});

	it("单根模板通过", () => {
		expect(lintAlpineTemplates(`<template x-for="a in b"><li x-text="a"></li></template>`)).toEqual([]);
	});

	it("两个兄弟根被检出(就是线上的那个 bug)", () => {
		const broken = `<template x-for="m in ms" :key="m.k">
			<template x-if="m.kind === 'route'"><line></line></template>
			<template x-if="m.kind !== 'route'"><circle></circle></template>
		</template>`;
		const issues = lintAlpineTemplates(broken);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.problem).toContain("恰好一个根元素");
		expect(issues[0]!.problem).toContain("实际 2 个");
	});

	it("零个根(只有文本)也会被检出", () => {
		const issues = lintAlpineTemplates(`<template x-if="a">just text</template>`);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.problem).toContain("实际 0 个");
	});

	it("嵌套模板的根也会被检查", () => {
		const nested = `<template x-for="a in b"><template x-if="a"><i></i><i></i></template></template>`;
		const issues = lintAlpineTemplates(nested);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.problem).toContain("实际 2 个");
		// 偏移量必须指向**内层**模板(而不是外层),否则报错定位不到真凶
		expect(nested.slice(issues[0]!.at, issues[0]!.at + 20)).toContain('x-if="a"');
	});

	it("未闭合模板被检出", () => {
		const issues = lintAlpineTemplates(`<template x-if="a"><div></div>`);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.problem).toContain("找不到配对");
	});

	it("void 元素与自闭合元素各算一个根,且不吞后续节点", () => {
		expect(topLevelElements(`<img src="x"><span></span>`)).toEqual(["img", "span"]);
		expect(topLevelElements(`<br/><svg></svg>`)).toEqual(["br", "svg"]);
		expect(topLevelElements(`<circle cx="1" cy="1" r="1">{{}}</circle>`)).toEqual(["circle"]);
	});

	it("嵌套真实元素只算外层根", () => {
		expect(topLevelElements(`<div><span><b></b></span></div>`)).toEqual(["div"]);
	});

	it("检出 <svg> 内部的 <template>(就是线上那个 bug 的真因)", () => {
		const broken = `<svg class="snap-ov"><g><template x-for="m in ms"><line :x1="m.x1"></line></template></g></svg>`;
		const issues = lintTemplatesInsideSvg(broken);
		expect(issues).toHaveLength(1);
		expect(issues[0]!.problem).toContain("reading 'children'");
	});

	it("<svg> 外部的 <template> 不受影响", () => {
		expect(lintTemplatesInsideSvg(`<div><template x-for="a in b"><i></i></template></div>`)).toEqual([]);
	});

	it("配对 </svg> 之后恢复正常(不再误报)", () => {
		expect(
			lintTemplatesInsideSvg(`<svg><g></g></svg><div><template x-for="a in b"><i></i></template></div>`),
		).toEqual([]);
	});

	it("x-html 注入 SVG 是允许的替代方案", () => {
		expect(lintTemplatesInsideSvg(`<div class="snap-ov" x-html="stageOverlay(v)"></div>`)).toEqual([]);
	});

	it("lintXForKeys 检出缺失的 :key,放过带 key 的", () => {
		expect(lintXForKeys(`<template x-for="a in b"><li></li></template>`)).toHaveLength(1);
		expect(lintXForKeys(`<template x-for="a in b" :key="a.id"><li></li></template>`)).toHaveLength(0);
	});
});

/**
 * `x-for` 不得穿过可空表达式（AGENTS §5.2 / D45）。
 *
 * 真实事故：`x-for="a in actionSurface().actions"` 在目录未加载时抛
 * `Cannot read properties of null (reading 'actions')`。**单测看不到它**——前端测试
 * 脚手架（test/unit/helpers/frontend-harness.ts）**明令禁止** jsdom/headless，
 * 所以没有任何 Alpine 表达式会被求值。这道静态守卫补的正是那个缺口里**可机械判定**的部分。
 */
describe("alpine: x-for 不得穿过可空表达式", () => {
	it("真实页面里没有 `x-for=\"x in fn().field\"` 形态", () => {
		const offenders = allPageHtml().flatMap((p) =>
			lintXForNullable(p.html).map((i) => `${p.name}: ${i.directive}`),
		);
		expect(
			offenders,
			"`x-for` 会独立求值；函数在数据加载前可能返回 null → Alpine 表达式错误（用视图模型里永不为 null 的数组，例如 actionRows()）",
		).toEqual([]);
	});

	it("该守卫会失败（自测：危险形态必须被抓到，安全形态必须放行）", () => {
		expect(lintXForNullable('<template x-for="a in surface().actions">').length).toBe(1);
		expect(lintXForNullable('<template x-for="a in surface() ? surface().actions : []">').length).toBe(1);
		expect(lintXForNullable('<template x-for="a in actionRows()">').length).toBe(0);
		expect(lintXForNullable('<template x-for="s in steps">').length).toBe(0);
		expect(lintXForNullable('<template x-for="(s, i) in steps">').length).toBe(0);
	});
});
