/**
 * Unit tests — the i18n runtime and the message catalog.
 *
 * 职责: 锁住三件容易悄悄坏掉的事——
 *   1. **回落**：没有译文就显示源文本（不显示空、不显示键名）。
 *   2. **占位**：`{0}` 在译文里原样回填（数字、模型名不被吞掉）。
 *   3. **漂移**：翻译表里的每条 msgid **必须还在源里**（页面或脚本）——
 *      源文本改了而表没改 ⇒ 页面悄悄回落到英文 ⇒ 守卫必须报错。
 *
 * 另有一条：**证据不被翻译**（`<code>` / `<pre>` 里的原始 JSON 原样保留）。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PUBLIC = join(process.cwd(), "src/web/public");
const ASSETS = join(PUBLIC, "assets/js");
const PAGES = join(PUBLIC, "pages");

function read(file: string): string {
	return readFileSync(file, "utf8");
}

/** The catalog as a plain object (the file assigns to window). */
function catalog(): Record<string, Record<string, string>> {
	const src = read(join(ASSETS, "locales.js"));
	const start = src.indexOf("window.I18nMessages");
	if (start < 0) throw new Error("locales.js 没有 window.I18nMessages");
	// 从赋值处开始，按括号配平取整个对象（文件头的注释里有 {0}，不能直接切 JSON）。
	let depth = 0;
	let end = -1;
	for (let i = src.indexOf("{", start); i < src.length; i++) {
		if (src[i] === "{") depth += 1;
		else if (src[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
	}
	if (end < 0) throw new Error("locales.js 的对象没有闭合");
	const json = src
		.slice(src.indexOf("{", start), end)
		.replace(/\/\*[\s\S]*?\*\//g, ""); // 去掉分组注释（浏览器不介意，JSON.parse 介意）
	return JSON.parse(json) as Record<string, Record<string, string>>;
}

/** All source text the UI can show: the pages + the front-end scripts. */
function sourceText(): string {
	const parts: string[] = [];
	for (const f of readdirSync(PAGES)) if (f.endsWith(".html")) parts.push(read(join(PAGES, f)));
	for (const f of readdirSync(ASSETS)) if (f.endsWith(".js")) parts.push(read(join(ASSETS, f)));
	return parts.join("\n");
}

describe("i18n 消息表", () => {
	it("每条 msgid 都还在源文本里（源改了、表没改 ⇒ 页面悄悄回落到英文）", () => {
		const src = sourceText();
		const zh = catalog().zh ?? {};
		const stale = Object.keys(zh).filter((k) => !src.includes(k));
		expect(stale, `这些译文已经对不上源文本：${stale.join(" | ")}`).toEqual([]);
	});

	it("译文不是空串，也不等于原文（否则等于没翻）", () => {
		const zh = catalog().zh ?? {};
		for (const [k, v] of Object.entries(zh)) {
			expect(v.trim(), `译文为空：${k}`).not.toBe("");
			expect(v, `译文与原文相同：${k}`).not.toBe(k);
		}
	});

	it("带占位的译文占位数量与原文一致（占位被吞掉 ⇒ 数字消失）", () => {
		const zh = catalog().zh ?? {};
		for (const [k, v] of Object.entries(zh)) {
			const count = (s: string) => (s.match(/\{0\}/g) ?? []).length;
			expect(count(v), `占位数量不一致：${k}`).toBe(count(k));
		}
	});

	it("只收录界面自己的文案：服务端词汇（结局类、问题码）不在表里", () => {
		const zh = catalog().zh ?? {};
		// 服务端只有一份规范文案（B5）；前端再翻一份就是第二份。
		for (const serverSide of ["Built, delivered nothing", "Token cap", "no_credential"]) {
			expect(Object.keys(zh), `服务端文案不该在前端表里：${serverSide}`).not.toContain(serverSide);
		}
	});
});

describe("i18n 运行时（纯逻辑）", () => {
	/** The runtime's lookup rules, re-implemented against the real catalog. */
	function translate(locale: string, text: string): string {
		if (locale === "en") return text;
		const table = catalog()[locale] ?? {};
		if (Object.prototype.hasOwnProperty.call(table, text)) return table[text] ?? text;
		for (const [key, value] of Object.entries(table)) {
			if (!key.includes("{0}")) continue;
			const parts = key.split("{0}").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
			const re = new RegExp(`^${parts.join("(.+?)")}$`);
			const m = re.exec(text);
			if (!m) continue;
			let i = 0;
			return value.replace(/\{0\}/g, () => m[++i] ?? "");
		}
		return text;
	}

	it("没有译文就回落源文本（不显示空、不显示键名）", () => {
		expect(translate("zh", "a string nobody translated")).toBe("a string nobody translated");
	});

	it("英文是恒等（英文界面不需要表）", () => {
		expect(translate("en", "Run")).toBe("Run");
	});

	it("占位被原样回填（数字不会消失）", () => {
		const zh = catalog().zh ?? {};
		const withPlaceholder = Object.keys(zh).find((k) => k.includes("{0}"));
		if (!withPlaceholder) return; // 表里暂时没有带占位的句子
		const sample = withPlaceholder.replace("{0}", "42");
		const out = translate("zh", sample);
		expect(out).not.toBe(sample);
		expect(out).toContain("42");
	});

	it("运行时的接口在（页面脚本靠它切语言）", () => {
		const src = read(join(ASSETS, "i18n.js"));
		for (const api of ["setLocale", "locale", "t", "onChange", "translateTree"]) {
			expect(src, `i18n.js 缺少 ${api}`).toContain(api);
		}
		// 证据不被翻译：code/pre 必须在跳过名单里。
		expect(src).toContain("CODE");
		expect(src).toContain("PRE");
	});
});
