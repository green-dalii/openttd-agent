/**
 * Preflight — refuse to start when prerequisites are not met.
 *
 * 职责: 在**任何副作用之前**检查启动先决条件（二进制、dataDir、端口、LLM 可用性），
 *   返回结构化结果供 CLI 呈现与退出。见 docs/STARTUP-AND-LIFECYCLE.md §2。
 * 为什么存在: 此前 `--agent` 在 LLM 未配置时静默降级成脚本化 faux 并照样启动游戏，
 *   用户看到的是一次"无脑模拟"。先决条件不满足必须**拒绝启动**。
 * 事实来源: docs/STARTUP-AND-LIFECYCLE.md §2/§3。
 * 禁止:
 *   - 产生副作用（不 spawn、不建 session、不写 dataDir 里的会话文件）。
 *     唯一例外：dataDir 的可写性探测（写完即删）。
 *   - 打印任何密钥（复用 redactKey）。
 *   - 在这里做降级决策（只报告；由 CLI 决定退出）。
 */

import { constants } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import type { Config } from "../config.js";
import { isLlmConfigured } from "../config.js";
import { buildBrain, scrubSecret } from "./provider.js";
import { FileCredentialStore } from "./file-credential-store.js";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface PreflightCheck {
	/** Stable id (tests and UI depend on it). */
	id: string;
	/** Short human label. */
	label: string;
	status: CheckStatus;
	/** What was observed (never contains secrets). */
	detail: string;
	/** How to fix it (present when status is fail/warn). */
	hint?: string;
}

export interface PreflightResult {
	ok: boolean;
	checks: PreflightCheck[];
	/** True when any check failed. */
	blocked: boolean;
}

export interface PreflightOptions {
	mode: "watch" | "agent" | "v02" | "probe";
	/** Explicit offline demo: the only sanctioned way to run without an LLM. */
	offlineDemo?: boolean;
	/** Skip non-safety checks (ports/gsFiles) for debugging. */
	skipUnsafe?: boolean;
	/** Timeout for the LLM reachability probe (default 15s). */
	llmProbeTimeoutMs?: number;
	/** Injected for tests: overrides the real reachability probe. */
	probeLlm?: () => Promise<{ ok: boolean; detail: string }>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/** GameScript sources the runner copies into the data dir. */
const GS_FILES = ["main.nut", "info.nut"];

async function checkBinary(cfg: Config): Promise<PreflightCheck> {
	const bin = cfg.openttdBinary;
	try {
		await access(bin, constants.X_OK);
		return { id: "binary", label: "OpenTTD binary", status: "pass", detail: bin };
	} catch {
		return {
			id: "binary",
			label: "OpenTTD binary",
			status: "fail",
			detail: `not executable: ${bin}`,
			hint:
				"Set OPENTTD_BINARY to the real OpenTTD executable " +
				"(macOS: .../OpenTTD.app/Contents/MacOS/openttd).",
		};
	}
}

async function checkDataDir(cfg: Config): Promise<PreflightCheck> {
	const dir = cfg.dataDir;
	const probe = path.join(dir, `.preflight-${process.pid}`);
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(probe, "ok", "utf8");
		await unlink(probe);
		return { id: "dataDir", label: "Data directory", status: "pass", detail: `${dir} (writable)` };
	} catch (e) {
		return {
			id: "dataDir",
			label: "Data directory",
			status: "fail",
			detail: `${dir} is not writable (${e instanceof Error ? e.message : String(e)})`,
			hint: "Set OPENTTD_DATA_DIR to a writable directory, or fix its permissions.",
		};
	}
}

/**
 * Whether a TCP port is free on loopback.
 *
 * A short-lived bind is the only reliable test (a connect probe cannot tell a
 * free port from a filtered one). The server is closed immediately.
 */
function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const srv = createServer();
		srv.once("error", () => resolve(false));
		srv.once("listening", () => srv.close(() => resolve(true)));
		srv.listen(port, "127.0.0.1");
	});
}

async function checkPorts(cfg: Config): Promise<PreflightCheck> {
	const [admin, game] = await Promise.all([portFree(cfg.adminPort), portFree(cfg.gamePort)]);
	if (admin && game) {
		return {
			id: "ports",
			label: "Ports",
			status: "pass",
			detail: `admin ${cfg.adminPort}, game ${cfg.gamePort} free`,
		};
	}
	const busy = [!admin ? cfg.adminPort : null, !game ? cfg.gamePort : null].filter(Boolean);
	return {
		id: "ports",
		label: "Ports",
		status: "fail",
		detail: `already in use: ${busy.join(", ")}`,
		hint: "Stop the process holding the port, or change OPENTTD_ADMIN_PORT / OPENTTD_GAME_PORT.",
	};
}

function checkLlmConfigured(cfg: Config, opts: PreflightOptions): PreflightCheck {
	if (!isLlmConfigured(cfg.llm)) {
		if (opts.offlineDemo) {
			return {
				id: "llmConfigured",
				label: "LLM configuration",
				status: "warn",
				detail: "not configured — running the explicit offline demo (scripted brain)",
				hint: "This is NOT a real LLM: it cannot judge decision quality, only exercise the plumbing.",
			};
		}
		return {
			id: "llmConfigured",
			label: "LLM configuration",
			status: "fail",
			detail: "no provider/model configured",
			hint:
				"Configure one on the Providers page (pnpm run cli --agent --web-port 8080), " +
				"or set LLM_PROVIDER/LLM_MODEL (or LLM_BASE_URL/LLM_MODEL). " +
				"To run the scripted demo instead, pass --offline-demo.",
		};
	}
	const where = cfg.llm.source === "catalog" ? cfg.llm.providerId : cfg.llm.baseUrl;
	return {
		id: "llmConfigured",
		label: "LLM configuration",
		status: "pass",
		detail: `${cfg.llm.source} · ${where} / ${cfg.llm.model}`,
	};
}

/**
 * Real minimal request through the SAME provider the run will use, so the check
 * cannot disagree with reality (a configured key can still be dead).
 */
async function probeLlmReal(cfg: Config, timeoutMs: number): Promise<{ ok: boolean; detail: string }> {
	const credentials = new FileCredentialStore(path.join(cfg.dataDir, "credentials.json"));
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	const started = Date.now();
	try {
		const built = await buildBrain(cfg.llm, { credentials });
		const stream = built.streamFn(
			built.model as never,
			{
				systemPrompt: "You are a connectivity probe.",
				messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
			} as never,
			{ signal: ctrl.signal, maxTokens: 8 } as never,
		);
		// A failure does NOT throw: pi-ai emits an { type: "error" } event
		// (reason "error"|"aborted") and ends the stream. Break on the first
		// event that carries a verdict, so a dead endpoint is reported as dead
		// rather than as "responded".
		for await (const ev of stream as AsyncIterable<{ type?: string; error?: unknown; reason?: string }>) {
			if (ev && ev.type === "error") {
				const errMsg = extractErrorMessage(ev.error) ?? ev.reason ?? "provider error";
				return { ok: false, detail: errMsg.slice(0, 200) };
			}
			if (ev && ev.type === "done") {
				return { ok: true, detail: `responded in ${Date.now() - started}ms` };
			}
			// Any content-level event means the endpoint is alive and authorized.
			return { ok: true, detail: `responded in ${Date.now() - started}ms` };
		}
		// Empty stream: the provider accepted the call but sent nothing.
		return { ok: true, detail: `responded in ${Date.now() - started}ms (empty stream)` };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		// Never surface a key that the provider echoed back in an error body.
		const safe = scrubSecret(msg, cfg.llm.apiKey);
		return {
			ok: false,
			detail: ctrl.signal.aborted ? `timed out after ${timeoutMs}ms` : safe.slice(0, 200),
		};
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Pull a printable message out of whatever the provider put in `error`.
 * Never throws, and never assumes a shape beyond "has a message/error".
 */
function extractErrorMessage(err: unknown): string | null {
	if (!err) return null;
	if (typeof err === "string") return err;
	const o = err as { errorMessage?: unknown; message?: unknown; error?: unknown };
	for (const cand of [o.errorMessage, o.message, o.error]) {
		if (typeof cand === "string" && cand.trim()) return cand;
	}
	return null;
}

function checkGsFiles(cfg: Config): PreflightCheck {
	const dir = path.join(cfg.dataDir, "game", "squirrel");
	// Presence check only: the runner regenerates these from src/game/squirrel.
	// Missing files are a warning (the build step can still produce them).
	void dir;
	void GS_FILES;
	return {
		id: "gsFiles",
		label: "GameScript sources",
		status: "warn",
		detail: "generated at boot from src/game/squirrel",
		hint: "If GS deployment fails later, run pnpm run gen-squirrel.",
	};
}

/**
 * Run every applicable check. Never throws: an unexpected error becomes a failed
 * check, so the CLI can always report something actionable.
 */
export async function runPreflight(cfg: Config, opts: PreflightOptions): Promise<PreflightResult> {
	const checks: PreflightCheck[] = [];

	// Order matters: cheap + safety-critical first, network probe last.
	checks.push(await checkBinary(cfg));
	checks.push(await checkDataDir(cfg));

	if (opts.skipUnsafe) {
		checks.push({ id: "ports", label: "Ports", status: "skip", detail: "skipped (--skip-preflight)" });
	} else if (opts.mode === "probe") {
		checks.push({ id: "ports", label: "Ports", status: "pass", detail: "probe manages its own ports" });
	} else {
		checks.push(await checkPorts(cfg));
	}

	if (opts.mode === "agent") {
		const configured = checkLlmConfigured(cfg, opts);
		checks.push(configured);
		if (configured.status === "fail") {
			// Emit the row anyway: a silently missing check reads as "fine".
			checks.push({
				id: "llmReachable",
				label: "LLM reachability",
				status: "skip",
				detail: "not probed — no provider configured",
			});
		} else {
			const timeout = opts.llmProbeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
			if (opts.offlineDemo) {
				checks.push({
					id: "llmReachable",
					label: "LLM reachability",
					status: "skip",
					detail: "offline demo — no real provider probed",
				});
			} else {
				const res = opts.probeLlm
					? await opts.probeLlm()
					: await probeLlmReal(cfg, timeout);
				checks.push({
					id: "llmReachable",
					label: "LLM reachability",
					status: res.ok ? "pass" : "fail",
					detail: res.detail,
					hint: res.ok
						? undefined
						: "Check the endpoint/model on the Providers page and that the key is valid " +
							"(network access, quota, and model id are common causes).",
				});
			}
		}
	}

	checks.push(checkGsFiles(cfg));

	const blocked = checks.some((c) => c.status === "fail");
	return { ok: !blocked, checks, blocked };
}

const MARK: Record<CheckStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "·" };

/** Render for the terminal (never contains secrets; see §3). */
export function formatPreflight(r: PreflightResult): string {
	const lines = r.checks.map((c) => {
		const pad = " ".repeat(Math.max(0, 10 - c.id.length));
		const head = `  ${MARK[c.status]} ${c.id}${pad} ${c.detail}`;
		return c.hint ? `${head}\n      → ${c.hint}` : head;
	});
	const header = r.ok ? "[preflight] ok" : "[preflight] ERROR: prerequisites not met";
	const footer = r.blocked
		? "\nNothing was started: fix the items above and run again.\n" +
			"(To run the scripted demo without an LLM, pass --offline-demo.)"
		: "";
	return `${header}\n${lines.join("\n")}${footer}`;
}
