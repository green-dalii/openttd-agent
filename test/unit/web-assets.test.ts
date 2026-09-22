/**
 * Unit tests — front-end asset sanity (no browser, no network).
 *
 * 职责: `src/web/public/` 里的页面/样式/脚本**不经过任何构建链**，因此
 *   `tsc`/eslint 看不到它们。本文件用 Node 侧可做的静态检查兜住最容易犯、
 *   且后果最严重的错误（浏览器白屏）：JS 语法错误、页面引用了不存在的资源、
 *   页面脚本缺少配套的 HTML、公共符号未定义、隐私规则被破坏。
 * 事实来源: docs/DASHBOARD-UI.md §2/§3/§5（组件与页面契约）、
 *   docs/DASHBOARD-API.md §1（目录契约 + PAGES 路由表）。
 * 禁止: 在此启动浏览器（真机 E2E 属于 web-api.test.ts / live 测试）。
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PAGES, PAGE_ALIASES, PUBLIC_DIR } from "../../src/web/server.js";

function listFiles(prefix = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(PUBLIC_DIR, prefix), { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...listFiles(rel));
		else out.push(rel);
	}
	return out;
}

const JS_FILES = () => listFiles("assets/js").filter((f) => f.endsWith(".js"));
const HTML_FILES = () => listFiles("pages").filter((f) => f.endsWith(".html"));
const read = (rel: string) => readFileSync(join(PUBLIC_DIR, rel), "utf8");

/** Identifiers a script publishes on `window.<Global> = {...}` (any indent). */
function exportedNames(src: string): Set<string> {
	const body = /window\.[A-Za-z_$][\w$]*\s*=\s*\{([\s\S]*?)\n[ \t]*\};/.exec(src)?.[1] ?? "";
	const names = new Set<string>();
	for (const raw of body.split(/[,\n]/)) {
		const name = raw.trim().split(":")[0]!.trim();
		if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
	}
	return names;
}

describe("front-end assets", () => {
	it("every script parses as valid JavaScript", () => {
		// A syntax error here means a blank page in the browser; tsc never sees it.
		for (const file of JS_FILES()) {
			let failed = false;
			try {
				execFileSync(process.execPath, ["--check", join(PUBLIC_DIR, file)], { stdio: "pipe" });
			} catch {
				failed = true;
			}
			expect(failed, `${file} is not valid JavaScript`).toBe(false);
		}
	});

	it("every href/src in every page resolves to a real file", () => {
		for (const page of HTML_FILES()) {
			const html = read(page);
			const refs = [...html.matchAll(/(?:href|src)="\/([^"]+)"/g)].map((m) => m[1]!);
			expect(refs.length, `${page} has no asset refs`).toBeGreaterThan(0);
			for (const ref of refs) {
				// In-app links point at a ROUTE, not a file: `/providers` is served by
				// PAGES, so only asset refs must exist on disk.
				if (Object.keys(PAGES).includes(`/${ref}`)) continue;
				expect(existsSync(join(PUBLIC_DIR, ref)), `${page} -> /${ref}`).toBe(true);
			}
		}
	});

	it("every page route (and alias) maps to an existing HTML file", () => {
		for (const [url, file] of Object.entries(PAGES)) {
			expect(existsSync(join(PUBLIC_DIR, file)), `${url} -> ${file}`).toBe(true);
			expect(file.split("/")[0], url).toBe("pages");
			const html = read(file);
			// Shared helpers + theme are required on every page.
			expect(html, file).toContain("/assets/js/common.js");
			expect(html, file).toContain("/assets/css/style.css");
		}
		for (const [alias, target] of Object.entries(PAGE_ALIASES)) {
			expect(PAGES[target], `alias ${alias} -> ${target}`).toBeDefined();
		}
	});

	it("has no orphan page scripts (every script is referenced)", () => {
		const referenced = new Set<string>();
		for (const page of HTML_FILES()) {
			for (const m of read(page).matchAll(/src="\/assets\/js\/([^"]+)"/g)) {
				referenced.add(`assets/js/${m[1]}`);
			}
		}
		const shared = ["assets/js/common.js", "assets/js/charts.js"];
		const orphans = JS_FILES().filter((f) => !referenced.has(f) && !shared.includes(f));
		expect(orphans, `unreferenced scripts: ${orphans.join(", ")}`).toEqual([]);
	});

	it("page scripts only use helpers that common.js / charts.js actually expose", () => {
		const exposed = exportedNames(read("assets/js/common.js"));
		expect(exposed.size).toBeGreaterThan(20);

		const chartApi = exportedNames(read("assets/js/charts.js"));
		for (const name of ["line", "bars", "donut", "sparkline", "destroy", "util"]) {
			expect(chartApi.has(name), `charts.js must expose ${name}`).toBe(true);
		}

		for (const file of JS_FILES().filter((f) => !f.endsWith("common.js") && !f.endsWith("charts.js"))) {
			const src = read(file);
			for (const m of src.matchAll(/\bU\.([A-Za-z_$][\w$]*)/g)) {
				expect(exposed.has(m[1]!), `${file} uses U.${m[1]} which common.js does not export`).toBe(true);
			}
			for (const m of src.matchAll(/\bC\.([A-Za-z_$][\w$]*)/g)) {
				expect(chartApi.has(m[1]!), `${file} uses C.${m[1]} which charts.js does not export`).toBe(true);
			}
		}
	});

	it("every id a page script looks up exists in its own HTML page", () => {
		// $("x") against a missing element is a runtime null-deref that tsc cannot see.
		for (const page of HTML_FILES()) {
			const html = read(page);
			const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
			const script = page.replace(/\.html$/, ".js").replace("pages/", "assets/js/");
			const scripts = [script].filter((s) => JS_FILES().includes(s));
			for (const s of scripts) {
				const src = read(s);
				for (const m of src.matchAll(/\b(?:U\.)?\$\("([^"]+)"\)/g)) {
					expect(ids.has(m[1]!), `${s} looks up #${m[1]} which ${page} does not define`).toBe(true);
				}
				// Element aliases (`const elFoo = $("foo")`) are the same hazard one
				// level removed: a refactor that drops the element from the HTML
				// leaves a crash in a code path no unit test executes.
				for (const m of src.matchAll(/const\s+(el[A-Za-z0-9_]*)\s*=\s*\$\("([^"]+)"\)/g)) {
					expect(ids.has(m[2]!), `${s}: ${m[1]} = $("${m[2]}") but ${page} has no #${m[2]}`).toBe(true);
				}
			}
		}
	});

	it("keeps the public root free of loose files (layout contract)", () => {
		expect(listFiles().filter((f) => !f.includes("/"))).toEqual([]);
	});

	it("renders every session status the backend can produce", () => {
		// `interrupted` (a hard-killed run) must be a distinct, explained badge -
		// it used to fall through to a generic "warn" with no tooltip.
		// The map lives in the sessions view model now that the page renders
		// declaratively, so the rule is asserted where it actually lives.
		const src = read("assets/js/sessions-view.js");
		for (const st of ["running", "completed", "aborted", "error", "interrupted"]) {
			expect(src, `no badge for status "${st}"`).toContain(`${st}:`);
		}
		// Each entry must carry both a class and an explanation.
		const block = src.slice(src.indexOf("const STATUS_INFO"), src.indexOf("function create"));
		expect((block.match(/cls:/g) ?? []).length).toBeGreaterThanOrEqual(5);
		expect((block.match(/title:/g) ?? []).length).toBeGreaterThanOrEqual(5);
	});

	it("never uses a <canvas> as a uPlot host", () => {
		// Regression (Phase 2, 2026-09-11): the cash/token charts were hosted by
		// <canvas> elements. uPlot builds its chart from injected DOM, so the chart
		// ended up as canvas *fallback* content - never painted - and the canvas was
		// stretched to ~1108px by its intrinsic ratio. The page showed a large empty
		// box with no error anywhere, and the original verification missed it because
		// it measured the injected canvas (which did have pixels) instead of asking
		// whether anything was visible.
		const charts = ["chart", "t-chart"];
		for (const page of HTML_FILES()) {
			const html = read(page);
			for (const id of charts) {
				const m = new RegExp(`<(\\w+)[^>]*id="${id}"`).exec(html);
				if (!m) continue;
				expect(m[1]!.toLowerCase(), `${page}: #${id} must be a <div> for uPlot, not <${m[1]}>`)
					.toBe("div");
			}
		}
	});

	it("never uses scrollIntoView to follow a list", () => {
		// Regression (2026-09-11, reported by the user): the Agent steps list called
		// `el.scrollIntoView()` on every appended step. That API scrolls EVERY
		// scrollable ancestor including the document, so a local list update yanked
		// the whole page and the reader kept losing their place. Use the
		// container-local helpers instead (UI.scrollToEnd / UI.keepVisible).
		for (const file of JS_FILES()) {
			const src = read(file);
			for (const line of src.split("\n")) {
				const t = line.trim();
				// Skip comments: the helpers document *why* scrollIntoView is banned.
				if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
				const code = line.split("//")[0]!;
				expect(
					/\.scrollIntoView\s*\(/.test(code),
					`${file}: scrollIntoView escapes the component and moves the page - ` +
						`use UI.scrollToEnd / UI.keepVisible\n  ${line.trim()}`,
				).toBe(false);
			}
		}
	});

	it("marks the scripted demo brain as not a real LLM", () => {
		// A faux run must never be mistakable for a real one in the UI.
		// The wording lives in the Live view model now that the page renders
		// declaratively, so the rule is asserted where it lives.
		const src = read("assets/js/live-view.js");
		expect(src).toMatch(/not a real LLM|scripted demo/i);
		// And the console check in web-server.test.ts scans pages; keep the wording
		// in exactly one place so it cannot drift.
		expect(src).toContain("brainLabel");
	});

	it("keeps secrets out of the front end and out of local storage", () => {
		// common.js is the only file allowed to touch storage (via setPref), and it
		// must not learn about credential fields to do it.
		for (const file of JS_FILES()) {
			const src = read(file);
			if (file !== "assets/js/common.js") {
				expect(src, `${file} writes to localStorage directly`).not.toMatch(/localStorage/);
			}
			// No file may persist a credential VALUE in preferences (docs §6).
			for (const m of src.matchAll(/setPref\(([^)]*)\)/g)) {
				const args = m[1]!;
				expect(args, `${file} stores a key value in preferences`).not.toMatch(
					/Key\.value|apiKey|credentials/i,
				);
			}
			expect(src, `${file} renders a key into HTML`).not.toMatch(
				/innerHTML\s*=\s*[^;]*\.(apiKey|key)\b/,
			);
		}
	});

	describe("script dependency closure", () => {
		// A page script that needs a global will silently do nothing if the script
		// defining it is missing - no error, just a blank area. That happened three
		// times (canvas host for uPlot, missing vendor script on the Evolution page,
		// missing x-ref for the comboboxes), so it is asserted structurally now.

		/** Pages that load a given script. */
		function pagesLoading(script: string): { name: string; html: string }[] {
			return HTML_FILES().map((f) => ({
				name: f,
				html: readFileSync(join(PUBLIC_DIR, f), "utf8"),
			})).filter((p) => p.html.includes(script));
		}

		it("every page loading ucharts.js also loads the uPlot vendor bundle", () => {
			const offenders = pagesLoading("ucharts.js").filter(
				(p) => !p.html.includes("uplot/uPlot.iife.min.js"),
			);
			expect(
				offenders.map((p) => p.name),
				"these pages load ucharts.js but never load window.uPlot, so charts silently render nothing",
			).toEqual([]);
		});

		it("every page loading ucharts.js also loads the uPlot stylesheet", () => {
			const offenders = pagesLoading("ucharts.js").filter(
				(p) => !p.html.includes("uplot/uPlot.min.css"),
			);
			expect(offenders.map((p) => p.name)).toEqual([]);
		});

		it("every page loading charts.js also loads common.js (it depends on window.UI)", () => {
			const offenders = pagesLoading("charts.js").filter((p) => !p.html.includes("js/common.js"));
			expect(offenders.map((p) => p.name)).toEqual([]);
		});

		it("every Altair page loading Alpine also loads the bridge", () => {
			const offenders = pagesLoading("alpine.min.js").filter(
				(p) => !p.html.includes("alpine-bridge.js"),
			);
			expect(offenders.map((p) => p.name)).toEqual([]);
		});
	});
});
/**
 * 快照盒子的**正方形不变量**（2026-09-22 真机事故）。
 *
 * 小地图的覆盖标记是 `<svg viewBox="0 0 100 100" preserveAspectRatio="none">`
 * ——**拉伸填满盒子**；底图是 `background-size: N% auto`（按宽度缩放）。
 * 两者都假定盒子是**正方形**。我为了断"宽度→高度"的闭环给它加了
 * `max-height: 260px`，盒子变成长方形 → 底图被裁、标记被拉伸 → **标记与地图错位**，
 * 用户看到的正是"图表内容、比例错乱"。
 *
 * 这条守卫锁住不变量本身：想要限制快照尺寸，请限制**列宽**（见 .stage-snaps），
 * 不要给盒子加高度上限。
 */
describe("快照盒子必须保持正方形（小地图叠加依赖它）", () => {
	const css = readFileSync(join(PUBLIC_DIR, "assets/css/style.css"), "utf8");
	const rule = css.match(/\.snap-img\s*\{[^}]*\}/)?.[0] ?? "";

	it("有 aspect-ratio: 1 / 1", () => {
		expect(rule, ".snap-img 规则没找到（选择器改名了？）").not.toBe("");
		expect(rule).toMatch(/aspect-ratio:\s*1\s*\/\s*1/);
	});

	it("**没有** height / max-height（有就不是正方形了）", () => {
		expect(rule, "给 .snap-img 加高度上限会让标记与地图错位").not.toMatch(/(?:^|[;\s])max-height\s*:/);
		expect(rule, "固定高度同样会破坏正方形").not.toMatch(/(?:^|[;\s])height\s*:/);
	});

	it("尺寸限制改在**列宽**上（列宽与视口无关，且不破坏正方形）", () => {
		const grid = css.match(/\.stage-snaps\s*\{[^}]*\}/)?.[0] ?? "";
		expect(grid, "列宽必须是固定区间（minmax(a, b)），不能是 1fr 自由伸展").toMatch(/minmax\(\s*\d+px\s*,\s*\d+px\s*\)/);
	});
});
