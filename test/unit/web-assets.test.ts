/**
 * Unit tests — front-end asset sanity (no browser, no network).
 *
 * 职责: `src/web/public/` 里的页面/样式/脚本**不经过任何构建链**，因此
 *   `tsc`/eslint 看不到它们。本文件用 Node 侧可做的静态检查兜住最容易犯、
 *   且后果最严重的错误（浏览器白屏）：JS 语法错误、页面引用了不存在的资源、
 *   页面脚本缺少配套的 HTML、公共符号未定义。
 * 事实来源: docs/DASHBOARD-API.md §1（目录契约 + PAGES 路由表）。
 * 禁止: 在此启动浏览器/HTTP 服务（那属于 web-api.test.ts）。
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PAGES, PUBLIC_DIR } from "../../src/web/server.js";

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
			const html = readFileSync(join(PUBLIC_DIR, page), "utf8");
			const refs = [...html.matchAll(/(?:href|src)="\/([^"]+)"/g)].map((m) => m[1]!);
			expect(refs.length, `${page} has no asset refs`).toBeGreaterThan(0);
			for (const ref of refs) {
				expect(existsSync(join(PUBLIC_DIR, ref)), `${page} -> /${ref}`).toBe(true);
			}
		}
	});

	it("every page route maps to an existing HTML file with a matching script", () => {
		for (const [url, file] of Object.entries(PAGES)) {
			expect(existsSync(join(PUBLIC_DIR, file)), `${url} -> ${file}`).toBe(true);
			const pageDir = file.split("/")[0];
			expect(pageDir).toBe("pages");
			const html = readFileSync(join(PUBLIC_DIR, file), "utf8");
			// Each page loads the shared helpers plus its own script.
			expect(html, file).toContain("/assets/js/common.js");
			expect(html, file).toContain("/assets/css/style.css");
		}
	});

	it("has no orphan page scripts (every script is referenced by a page)", () => {
		const referenced = new Set<string>();
		for (const page of HTML_FILES()) {
			const html = readFileSync(join(PUBLIC_DIR, page), "utf8");
			for (const m of html.matchAll(/src="\/assets\/js\/([^"]+)"/g)) referenced.add(`assets/js/${m[1]}`);
		}
		const orphans = JS_FILES().filter((f) => !referenced.has(f) && !f.endsWith("common.js"));
		expect(orphans, `unreferenced scripts: ${orphans.join(", ")}`).toEqual([]);
	});

	it("page scripts only use helpers that common.js actually exposes", () => {
		const common = readFileSync(join(PUBLIC_DIR, "assets/js/common.js"), "utf8");
		const exposed = new Set(
			[...(common.match(/window\.UI\s*=\s*\{([\s\S]*?)\};/) ?? [])[1]
				?.split(",")
				.map((s) => s.trim().split(":")[0]!.trim())
				.filter(Boolean) ?? []] as string[],
		);
		expect(exposed.size).toBeGreaterThan(5);
		for (const file of JS_FILES().filter((f) => !f.endsWith("common.js"))) {
			const src = readFileSync(join(PUBLIC_DIR, file), "utf8");
			for (const m of src.matchAll(/\bU\.([A-Za-z_$][\w$]*)/g)) {
				expect(exposed.has(m[1]!), `${file} uses U.${m[1]} which common.js does not export`).toBe(true);
			}
		}
	});

	it("keeps the public root free of loose files (layout contract)", () => {
		expect(listFiles().filter((f) => !f.includes("/"))).toEqual([]);
	});
});
