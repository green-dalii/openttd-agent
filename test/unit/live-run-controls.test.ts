/**
 * Unit tests — Live page run controls, through the real user path.
 *
 * 职责: 点击真实按钮 → 断言**发出/没发出**什么请求、UI 如何反馈。
 * 这个文件存在的唯一理由是一个真实事故（2026-09-11）:
 *
 *   `pnpm run cli --serve` 下点 "start agent" 报
 *   `Request failed: ReferenceError: Cannot access 'body' before initialization`，
 *   浏览器控制台**干净**。原因: live.js 的 post() 里
 *   `const body = await r.json()` 遮蔽了同名参数 `body`，
 *   `JSON.stringify(body)` 在参数求值阶段落进 TDZ 抛错 ——
 *   **在 fetch 之前就抛了，所以一个字节都没发出去**，
 *   异常又被 catch 成 toast。
 *
 *   语法检查（node --check）、静态符号检查、curl 直打 API 全部通过，
 *   因为它们都没走"用户点击"这条路径。本文件补上这条路。
 *
 * 禁止: 断言具体 DOM 结构（会与样式改动耦合）；只断言"发了什么请求 + 如何反馈"。
 */

import { describe, expect, it } from "vitest";
import { loadFrontend } from "./helpers/frontend-harness.js";

const SCRIPTS = ["assets/js/common.js", "assets/js/charts.js", "assets/js/live.js"];

/** Serve mode: /api/run exists and is idle. */
function serveMode(status: Record<string, unknown> = { state: "idle", mode: "agent" }) {
	return loadFrontend({
		page: "live.html",
		scripts: SCRIPTS,
		respond: [
			{ match: "/api/run/start", json: { state: "starting", mode: "agent" } },
			{ match: "/api/run/stop", json: { state: "idle" } },
			{ match: "/api/run/pause", json: { state: "paused" } },
			{ match: "/api/run/resume", json: { state: "running" } },
			{ match: "/api/run", json: status },
		],
	});
}

/** Watch-only mode: /api/run answers 404, so the controls stay hidden. */
function noServeMode() {
	return loadFrontend({
		page: "live.html",
		scripts: SCRIPTS,
		respond: [{ match: "/api/run", status: 404, json: { error: "run control disabled" } }],
	});
}

describe("Live run controls (real click path)", () => {
	it("start agent actually sends POST /api/run/start", async () => {
		const h = serveMode();
		await h.flush();
		await h.click("run-start-agent");

		expect(h.errorToast()).toBeNull();
		const calls = h.callsTo("/api/run/start", "POST");
		expect(calls).toHaveLength(1);
		expect(JSON.parse(calls[0]!.body ?? "{}")).toEqual({ mode: "agent" });
	});

	it("start watch sends the watch mode", async () => {
		const h = serveMode();
		await h.flush();
		await h.click("run-start-watch");
		expect(h.callsTo("/api/run/start", "POST")[0]?.body).toBe(JSON.stringify({ mode: "watch" }));
	});

	it("no click on any control ever reports a swallowed ReferenceError", async () => {
		// The regression guard: this is the exact failure the user hit. Any TDZ /
		// shadowing error in the request path lands here as an err toast.
		const h = serveMode();
		await h.flush();
		for (const id of ["run-start-agent", "run-start-watch", "run-pause"]) {
			await h.click(id);
		}
		const errs = h.toasts.filter((t) => t.kind === "err").map((t) => t.msg);
		expect(errs.filter((m) => /ReferenceError|before initialization/.test(m))).toEqual([]);
	});

	it("pause posts to /api/run/pause when running, resume when paused", async () => {
		const running = serveMode({ state: "running" });
		await running.flush();
		await running.click("run-pause");
		expect(running.callsTo("/api/run/pause", "POST")).toHaveLength(1);

		const paused = serveMode({ state: "paused" });
		await paused.flush();
		await paused.click("run-pause");
		expect(paused.callsTo("/api/run/resume", "POST")).toHaveLength(1);
	});

	it("surfaces a 409 from start instead of failing silently", async () => {
		const h = loadFrontend({
			page: "live.html",
			scripts: SCRIPTS,
			respond: [
				{ match: "/api/run/start", status: 409, json: { error: "a run is already active" } },
				{ match: "/api/run", json: { state: "running", mode: "agent" } },
			],
		});
		await h.flush();
		await h.click("run-start-agent");
		expect(h.errorToast()).toContain("already active");
	});

	it("hides the control bar when there is no /api/run (watch-only run)", async () => {
		const h = noServeMode();
		await h.flush();
		expect(h.el("run-controls").hidden).toBe(true);
	});

	it("exposes the control bar in serve mode", async () => {
		const h = serveMode();
		await h.flush();
		expect(h.el("run-controls").hidden).toBe(false);
	});
});
