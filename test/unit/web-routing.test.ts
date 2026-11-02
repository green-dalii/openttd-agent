/**
 * Unit tests — page routing (URL <-> file) and what a missing page answers.
 *
 * 为什么单独一个文件：2026-11 用户报"导航点'比较'/'配置'全是 not found"。
 * 真因不是页面没做，而是**跑着的进程比磁盘上的文件旧**：路由表写在进程内存里，
 * 页面文件却是新加的 ⇒ 老进程不认新 URL ⇒ 浏览器只看到一句 "not found"，
 * 看起来像"功能没开发"。
 *
 * 这个文件守住三件事：
 *   1. 路由**由文件名派生** ⇒ 加页面 = 加文件，不会出现"文件在、路由没有"；
 *   2. 导航里的每个链接都真的能解析（静态守卫，不需要浏览器）；
 *   3. 不是页面的 URL 返回**页面清单**，而不是光秃秃的 "not found"。
 */

import { describe, expect, it } from "vitest";
import http from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PAGE_ALIASES,
	PAGE_REDIRECTS,
	PUBLIC_DIR,
	WebServer,
	pageRoutes,
} from "../../src/web/server.js";

const NAV_ITEMS = ["/", "/compare", "/sessions", "/configure"];

describe("web: page routing", () => {
	it("derives a route from every page file (no page is unreachable)", () => {
		const routes = pageRoutes();
		expect(Object.keys(routes).sort()).toEqual([...NAV_ITEMS].sort());
		expect(routes["/"]).toBe("pages/live.html");
		expect(routes["/compare"]).toBe("pages/compare.html");
		expect(routes["/sessions"]).toBe("pages/sessions.html");
		expect(routes["/configure"]).toBe("pages/configure.html");
	});

	it("picks up a page file that appears while the server runs", () => {
		const dir = mkdtempSync(join(tmpdir(), "ota-pages-"));
		try {
			expect(Object.keys(pageRoutes(dir))).toEqual(["/"]);
			writeFileSync(join(dir, "newpage.html"), "<!doctype html><title>New</title>");
			expect(Object.keys(pageRoutes(dir))).toEqual(["/", "/newpage"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("serves every page the nav offers", async () => {
		const server = new WebServer({ port: 0 });
		await server.start();
		const port = server.actualPort;
		try {
			for (const url of NAV_ITEMS) {
				const res = await fetch(`http://127.0.0.1:${port}${url}`);
				const body = await res.text();
				expect(res.status, url).toBe(200);
				expect(body, url).toContain("<html");
				expect(body.toLowerCase(), url).not.toContain("not found");
			}
		} finally {
			await server.stop();
		}
	});

	it("answers a URL that is not a page with the page list, not a bare 'not found'", async () => {
		const server = new WebServer({ port: 0 });
		await server.start();
		const port = server.actualPort;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/no-such-page`);
			const body = await res.text();
			expect(res.status).toBe(404);
			expect(body).toContain("/compare");
			expect(body).toContain("/sessions");
			expect(body).toContain("/configure");
			// The operator must be able to tell "wrong URL" from "old process".
			expect(body).toMatch(/restart/i);
		} finally {
			await server.stop();
		}
	});

	it("keeps the old /providers URL working (redirect, not a second copy)", async () => {
		const server = new WebServer({ port: 0 });
		await server.start();
		const port = server.actualPort;
		try {
			const res = await fetch(`http://127.0.0.1:${port}/providers`, { redirect: "manual" });
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/configure");
		} finally {
			await server.stop();
		}
	});

	it("resolves the nav links the shared chrome renders", async () => {
		// The chrome is generated in one place (common.js renderNav). Parse it so a
		// link to a page that does not exist fails here, not in the browser.
		const common = readFileSync(
			join(process.cwd(), "src/web/public/assets/js/common.js"),
			"utf8",
		);
		const block = common.match(/function renderNav[\s\S]*?\n}/);
		expect(block, "renderNav not found").toBeTruthy();
		const hrefs = [...(block![0].matchAll(/\["(\/[^"]*)",\s*"[^"]*"\]/g))].map((m) => m[1]!);
		expect(hrefs.length).toBeGreaterThan(1);
		const routes = pageRoutes();
		for (const href of hrefs) {
			expect(Object.keys(routes), `nav link ${href}`).toContain(href);
		}
	});

	it("every internal link in every page resolves (route, alias, redirect or file)", () => {
		const dir = join(PUBLIC_DIR, "pages");
		const routes = pageRoutes();
		for (const file of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
			const html = readFileSync(join(dir, file), "utf8");
			const refs = [...html.matchAll(/href="(\/[^"#]*)"/g)].map((m) => m[1]!);
			for (const ref of refs) {
				if (ref.startsWith("/api/")) continue;
				const known =
					Object.keys(routes).includes(ref) ||
					Object.keys(PAGE_ALIASES).includes(ref) ||
					Object.keys(PAGE_REDIRECTS).includes(ref) ||
					existsSync(join(PUBLIC_DIR, ref));
				expect(known, `${file} -> ${ref}`).toBe(true);
			}
		}
	});

	it("does not leave an unreachable http listener behind", async () => {
		// (the server must be stoppable; a dangling listener would keep vitest alive)
		const server = new WebServer({ port: 0 });
		await server.start();
		await new Promise<void>((resolve, reject) => {
			http
				.get(`http://127.0.0.1:${server.actualPort}/`, (r) => {
					r.resume();
					r.on("end", () => resolve());
				})
				.on("error", reject);
		});
		await server.stop();
	});
});
