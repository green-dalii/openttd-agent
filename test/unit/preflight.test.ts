/**
 * Unit tests — startup preflight (docs/STARTUP-AND-LIFECYCLE.md §2).
 *
 * 职责: 锁定「先决条件不满足就不许启动」的判定与**副作用前的顺序**。
 *   纯测试：临时目录 + 注入的探测函数，不 spawn 游戏、不联网。
 * 禁止: 在此发起真实网络请求（LLM 探测用注入的 stub）。
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { runPreflight, formatPreflight } from "../../src/agent/preflight.js";
import { scrubSecret } from "../../src/agent/provider.js";
import { applyLlmSettingsFile } from "../../src/agent/llm-settings.js";
import { loadConfig } from "../../src/config.js";

function tmp(): string {
	return mkdtempSync(path.join(tmpdir(), "preflight-"));
}

/**
 * A config whose binary points at a real executable (node itself), passed
 * through the same merge the CLI uses (llm.json -> env overrides).
 */
function cfgFor(dir: string, over: Record<string, string> = {}) {
	return applyLlmSettingsFile(
		loadConfig({ OPENTTD_DATA_DIR: dir, OPENTTD_BINARY: process.execPath, ...over }),
	);
}

/**
 * 真机局运行期间**不要跑 gate**（MEMORY D5）。
 *
 * 这条规则我今天违反了三次，每次的代价都是"5 个看不懂的 preflight 失败 +
 * 一次差点误判为回归"。preflight 的端口检查会看到游戏占用的 3977/3979 →
 * 「端口被占」用例通过、「不需要 LLM」等用例失败——**看起来像代码坏了，其实是环境**。
 *
 * 所以把它变成一条**明确的、带指令的消息**：检测到游戏端口被占用就跳过这组用例并说明原因。
 * 跳过（而不是失败）是诚实的：那些断言在"端口被占"的前提下本来就不成立。
 */
const GAME_PORTS = [3977, 3979];

function gameRunIsLive(): boolean {
	try {
		const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
		return GAME_PORTS.some((p) => new RegExp(`:${p}\\b`).test(out));
	} catch {
		return false; // lsof 不可用就当没有在跑（不能因此阻断门禁）
	}
}

const live = gameRunIsLive();
if (live) {
	// 这是**给人看的环境提示**，不是调试残留：门禁失败时必须一眼看出是环境而不是代码。
	// eslint-disable-next-line no-console
	console.warn(
		"\n[gate] 检测到 OpenTTD 端口（3977/3979）被占用：真机局正在运行。\n" +
			"       跳过 preflight 用例——这不是代码缺陷（MEMORY D5）。\n" +
			"       要跑完整门禁：先 `pkill -f \"cli/run.ts\"` + `pkill -f \"OpenTTD.app/Contents/MacOS/openttd\"`。\n",
	);
}

// D5：真机局在跑时这组断言不成立（端口被占是环境条件，不是回归）。
const d = live ? describe.skip : describe;
d("preflight (live-run guard applied)", () => {
	it("fails on a missing OpenTTD binary and says how to fix it", async () => {
		const dir = tmp();
		try {
			const cfg = cfgFor(dir, { OPENTTD_BINARY: path.join(dir, "nope-openttd") });
			const r = await runPreflight(cfg, { mode: "watch" });
			expect(r.ok).toBe(false);
			const binary = r.checks.find((c) => c.id === "binary")!;
			expect(binary.status).toBe("fail");
			expect(binary.hint).toMatch(/OPENTTD_BINARY/);
			expect(formatPreflight(r)).toMatch(/ERROR|✗/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails when the binary is not executable", async () => {
		const dir = tmp();
		try {
			const bin = path.join(dir, "not-exec");
			writeFileSync(bin, "#!/bin/sh\n");
			chmodSync(bin, 0o644);
			const r = await runPreflight(cfgFor(dir, { OPENTTD_BINARY: bin }), { mode: "watch" });
			expect(r.checks.find((c) => c.id === "binary")!.status).toBe("fail");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates and verifies the data dir is writable", async () => {
		const dir = path.join(tmp(), "nested", "data");
		const base = path.dirname(dir);
		try {
			const r = await runPreflight(cfgFor(dir), { mode: "watch" });
			expect(r.checks.find((c) => c.id === "dataDir")!.status).toBe("pass");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("fails when a required port is already taken", async () => {
		const dir = tmp();
		const blocker = createServer();
		await new Promise<void>((res) => blocker.listen(0, "127.0.0.1", () => res()));
		const taken = (blocker.address() as { port: number }).port;
		try {
			const r = await runPreflight(
				cfgFor(dir, { OPENTTD_ADMIN_PORT: String(taken), OPENTTD_GAME_PORT: String(taken + 1) }),
				{ mode: "watch" },
			);
			const ports = r.checks.find((c) => c.id === "ports")!;
			expect(ports.status).toBe("fail");
			expect(ports.detail).toContain(String(taken));
			expect(ports.hint).toMatch(/OPENTTD_ADMIN_PORT|process/i);
		} finally {
			await new Promise<void>((res) => blocker.close(() => res()));
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("requires a configured LLM in agent mode (this is the whole point)", async () => {
		const dir = tmp();
		try {
			// Nothing configured: no provider, no model, no env key.
			const r = await runPreflight(cfgFor(dir), { mode: "agent" });
			expect(r.ok).toBe(false);
			const llm = r.checks.find((c) => c.id === "llmConfigured")!;
			expect(llm.status).toBe("fail");
			expect(llm.hint).toMatch(/Providers|LLM_PROVIDER|--offline-demo/);
			// and it must be blunt that no simulation will start
			expect(formatPreflight(r)).toMatch(/refus|abort|not start|ERROR/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lets an explicit offline demo bypass the LLM requirement", async () => {
		const dir = tmp();
		try {
			const r = await runPreflight(cfgFor(dir), { mode: "agent", offlineDemo: true });
			const llm = r.checks.find((c) => c.id === "llmConfigured")!;
			expect(llm.status).toBe("warn"); // allowed, but called out
			expect(r.ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does NOT require an LLM in watch mode (pure observation)", async () => {
		const dir = tmp();
		try {
			const r = await runPreflight(cfgFor(dir), { mode: "watch" });
			expect(r.checks.some((c) => c.id === "llmConfigured")).toBe(false);
			expect(r.ok).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("probes the real brain and reports an unreachable endpoint as a failure", async () => {
		const dir = tmp();
		try {
			// A custom endpoint on a closed port: configured but not reachable.
			writeFileSync(
				path.join(dir, "llm.json"),
				JSON.stringify({
					providerId: "dead",
					baseUrl: "http://127.0.0.1:1/v1",
					model: "x",
					api: "openai-completions",
					source: "custom",
				}),
			);
			const r = await runPreflight(cfgFor(dir), { mode: "agent", llmProbeTimeoutMs: 1500 });
			expect(r.ok).toBe(false);
			const reach = r.checks.find((c) => c.id === "llmReachable")!;
			expect(reach.status).toBe("fail");
			// The message must never contain a key.
			expect(reach.detail + (reach.hint ?? "")).not.toMatch(/sk-/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never leaks a key into the rendered report", async () => {
		const dir = tmp();
		try {
			const cfg = applyLlmSettingsFile(
				loadConfig({
					OPENTTD_DATA_DIR: dir,
					OPENTTD_BINARY: process.execPath,
					LLM_BASE_URL: "http://127.0.0.1:1/v1",
					LLM_MODEL: "x",
					LLM_API_KEY: "sk-super-secret-value",
				}),
			);
			const r = await runPreflight(cfg, { mode: "agent", llmProbeTimeoutMs: 1200 });
			expect(formatPreflight(r)).not.toContain("sk-super-secret-value");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips non-safety checks with skipUnsafe but still blocks on the binary", async () => {
		const dir = tmp();
		try {
			const cfg = cfgFor(dir, { OPENTTD_BINARY: path.join(dir, "missing") });
			const r = await runPreflight(cfg, { mode: "watch", skipUnsafe: true });
			// binary is safety-critical => still checked and still failing
			expect(r.checks.find((c) => c.id === "binary")!.status).toBe("fail");
			expect(r.ok).toBe(false);
			// ports is not => skipped
			expect(r.checks.find((c) => c.id === "ports")!.status).toBe("skip");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("warns (not fails) when GameScript files are missing", async () => {
		const dir = tmp();
		try {
			const r = await runPreflight(cfgFor(dir), { mode: "watch" });
			const gs = r.checks.find((c) => c.id === "gsFiles")!;
			expect(["warn", "pass"]).toContain(gs.status);
			expect(r.ok).toBe(true); // a warning must never block a start
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs checks in a deterministic order with the binary first", async () => {
		const dir = tmp();
		try {
			const r = await runPreflight(cfgFor(dir), { mode: "agent" });
			expect(r.checks[0]!.id).toBe("binary");
			// fast, cheap checks precede the network probe
			const ids = r.checks.map((c) => c.id);
			expect(ids.indexOf("llmConfigured")).toBeLessThan(ids.indexOf("llmReachable"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never creates a session or spawns anything when it fails", async () => {
		const dir = tmp();
		try {
			// No binary, no LLM: the failure must be the ONLY outcome.
			const r = await runPreflight(
				loadConfig({ OPENTTD_DATA_DIR: dir, OPENTTD_BINARY: "/nonexistent" }),
				{ mode: "agent" },
			);
			expect(r.ok).toBe(false);
			// sessions/ is created by SessionStore, never by preflight
			expect(existsSync(path.join(dir, "sessions"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("key safety (scrubSecret)", () => {
	it("eliminates a secret echoed back in provider error text", () => {
		// Providers sometimes include the credential in their error body; it must
		// never reach a terminal or a log.
		const msg = "401 unauthorized: key sk-abcdef123456 rejected";
		expect(scrubSecret(msg, "sk-abcdef123456")).toBe("401 unauthorized: key <redacted> rejected");
		// nothing to scrub => unchanged
		expect(scrubSecret(msg, "")).toBe(msg);
		// too short to be a real secret: left alone rather than mangling the text
		expect(scrubSecret("error abc", "abc")).toBe("error abc");
		// every occurrence is removed, not just the first
		expect(scrubSecret("a sk-zzzzzz b sk-zzzzzz", "sk-zzzzzz")).toBe("a <redacted> b <redacted>");
	});
});
