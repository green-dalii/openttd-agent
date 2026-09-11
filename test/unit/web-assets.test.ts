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
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
			// shared scripts are checked against every page that loads them
			const scripts = [script].filter((s) => JS_FILES().includes(s));
			for (const s of scripts) {
				for (const m of read(s).matchAll(/\b(?:U\.)?\$\("([^"]+)"\)/g)) {
					expect(ids.has(m[1]!), `${s} looks up #${m[1]} which ${page} does not define`).toBe(true);
				}
			}
		}
	});

	it("keeps the public root free of loose files (layout contract)", () => {
		expect(listFiles().filter((f) => !f.includes("/"))).toEqual([]);
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
});
