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
import { visibleTexts, needsTranslation } from "./helpers/i18n-static.js";
import { OUTCOME_CLASSES } from "../../src/evolution/outcome.js";
import { PROBLEM_CODES } from "../../src/agent/problems.js";
import { PAIRED_METRICS } from "../../src/evolution/bench-stats.js";
import { DELIVERED_MEASURE_ID, SPLIT_MEASURE_ID } from "../../src/evolution/scorecard.js";

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
		// 只留字母与数字再比：源码里一句常常是**几个字面量拼起来**的（中间隔着
		// `+ "..."`），拼起来的整句不会逐字出现在源里；把标点与代码符号也去掉，
		// 才能跨过字面量的边界去比对。
		const stripped = src.replace(/[^A-Za-z0-9]+/g, "");
		const zh = catalog().zh ?? {};
		const stale = Object.keys(zh).filter((k) => {
			if (src.includes(k)) return false;
			// 带占位的键（"{0} summaries recorded"）不会逐字出现在源里 ——
			// 它是**模式**：查它的字面部分还在不在源里。
			const parts = k.split(/\{[0-9]+\}/).filter((p) => p !== "");
			if (parts.length === 0) return true;
			return !parts.every((part) => stripped.includes(part.replace(/[^A-Za-z0-9]+/g, "")));
		});
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

	it("只收录界面自己的文案：服务端的**规范文案**不在表里", () => {
		const zh = catalog().zh ?? {};
		// 服务端只有一份规范文案（B5）：结局类的 hint、问题码的 hint 都在服务端，
		// 前端再抄一份就是第二份 ⇒ 它们按 **id** 翻（见 PR C），不按文案翻。
		// （**类名**可以与页面自己的用词重合 —— 例如页面上也有一个叫
		//   "Token cap" 的旋钮，那是页面的文案，不是服务端的文案。）
		const serverSide = [
			"the run delivered cargo and passengers - a real result",
			"construction finished but nothing was delivered - look at the route and the vehicles",
			"the run ended before any construction finished - the agent never got a line up",
			"the model never got to act: every call was rejected - wrong arguments, or no budget left",
			"the run was stopped from inside (set_pause) - not a learning result",
			"the environment stopped advancing, not the agent - not a learning result",
			"the run hit the time limit before the horizon - a shorter answer, not a worse one",
			"the run hit the token limit before the horizon - raise the limit to let it finish",
			"the run hit the cost limit before the horizon - raise the limit to let it finish",
			"not enough readings to name the outcome - not the same as 'nothing happened'",
			"no_credential",
		];
		for (const text of serverSide) {
			expect(Object.keys(zh), `服务端文案不该在前端表里：${text}`).not.toContain(text);
		}
	});
});

/**
 * 服务端词汇的覆盖度（Issue #88 第三批）。
 *
 * 结局十类、问题码、度量口径、逐轴指标：**服务端只有一份规范文案**（B5），
 * 前端按 **id** 翻 ⇒ 新增一个 id 而忘了翻 ⇒ 中文界面里那一处**默默回落成
 * 服务端的英文原文**（不报错）。
 *
 * ⇒ 词表的覆盖度由**服务端的清单**校验：服务端能产出哪个 id，这里就得有
 * 哪个 id 的词条。
 */
describe("服务端词汇按 id 翻（terms.js）", () => {
	function terms(): Record<string, string> {
		const src = read(join(ASSETS, "terms.js"));
		const start = src.indexOf("window.I18nTerms");
		if (start < 0) throw new Error("terms.js 没有 window.I18nTerms");
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
		if (end < 0) throw new Error("terms.js 的对象没有闭合");
		const json = src
			.slice(src.indexOf("{", start), end)
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/,(\s*[}\]])/g, "$1");
		return JSON.parse(json) as Record<string, string>;
	}

	it("结局十类都有词条（类名与含义）", () => {
		const t = terms();
		const missing: string[] = [];
		for (const code of OUTCOME_CLASSES) {
			for (const id of [`outcome.${code}`, `outcome.${code}.hint`]) {
				if (!t[id]) missing.push(id);
			}
		}
		expect(missing, `这些结局 id 没有中文词条：${missing.join(", ")}`).toEqual([]);
	});

	it("问题码都有词条", () => {
		const t = terms();
		const missing = PROBLEM_CODES.filter((code) => !t[`problem.${code}`]);
		expect(missing, `这些问题码没有中文词条：${missing.join(", ")}`).toEqual([]);
	});

	it("度量口径都有词条", () => {
		const t = terms();
		const missing = [DELIVERED_MEASURE_ID, SPLIT_MEASURE_ID].filter((id) => !t[`measure.${id}`]);
		expect(missing, `这些度量口径没有中文词条：${missing.join(", ")}`).toEqual([]);
	});

	it("逐轴指标的措辞都有词条", () => {
		const t = terms();
		const missing: string[] = [];
		for (const m of PAIRED_METRICS) {
			for (const id of [`metric.${m.id}.label`, `metric.${m.id}.unit`]) {
				if (!(id in t)) missing.push(id);
			}
		}
		expect(missing, `这些逐轴指标没有中文词条：${missing.join(", ")}`).toEqual([]);
	});

	it("词条不为空（服务端的措辞不为空时，译文也不能为空）", () => {
		const t = terms();
		const empty: string[] = [];
		for (const m of PAIRED_METRICS) {
			// 有些指标**本来就没有单位**（失败率）⇒ 那一条的译文也允许为空。
			if (m.unit.trim() !== "" && String(t[`metric.${m.id}.unit`] ?? "").trim() === "") {
				empty.push(`metric.${m.id}.unit`);
			}
			if (String(t[`metric.${m.id}.label`] ?? "").trim() === "") empty.push(`metric.${m.id}.label`);
		}
		for (const [k, v] of Object.entries(t)) {
			if (k.startsWith("metric.")) continue;
			if (v.trim() === "") empty.push(k);
		}
		expect(empty, `这些词条是空的：${empty.join(", ")}`).toEqual([]);
	});

});
describe("四页静态文案的中文覆盖", () => {
	const zh = (): Record<string, string> => catalog().zh ?? {};

	it("页面上每一句可见文案都有中文译文", () => {
		const missing: string[] = [];
		for (const file of readdirSync(PAGES)) {
			if (!file.endsWith(".html")) continue;
			const html = read(join(PAGES, file));
			for (const { text, line } of visibleTexts(html)) {
				if (!needsTranslation(text)) continue; // 纯符号 / 数字
				if (zh()[text]) continue;
				missing.push(`${file}:${line} ${JSON.stringify(text)}`);
			}
		}
		expect(missing, `这些文案在中文界面里会默默变回英文：\n${missing.join("\n")}`).toEqual([]);
	});

	it("页面的源文本是英文（源里混进中文 ⇒ 英文界面会出现半句中文）", () => {
		const chinese: string[] = [];
		for (const file of readdirSync(PAGES)) {
			if (!file.endsWith(".html")) continue;
			const html = read(join(PAGES, file));
			for (const { text, line } of visibleTexts(html)) {
				if (/[一-龥]/.test(text)) chinese.push(`${file}:${line} ${JSON.stringify(text)}`);
			}
		}
		expect(chinese, `源文本里有中文：\n${chinese.join("\n")}`).toEqual([]);
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
