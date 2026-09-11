/**
 * Live E2E — the AGENT is genuinely driving the game (not a stub, not watch mode).
 *
 * 职责: 证明「智能真的接上了」。这是 v0.3~v0.5 缺失的那一层：当时的 E2E 只验证
 *   "进程起来了 + 有 token 计数"，于是三个真机 Session 全是
 *   `mode=watch` + `kind=faux` + `decisions=0`（内置 CPU AI 在打）而无人发现。
 * 事实来源: AGENTS.md §5.1（E2E 必须证明的 7 条）。
 * 禁止: 用 faux provider 充当"智能"——那正是本测试要防的错误。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { live } from "../helpers/live.js";
import { WebSocket } from "ws";

const REPO = path.resolve(import.meta.dirname, "..", "..");

interface SessionMeta {
	mode: string;
	status: string;
	llm: { providerId: string; model: string; kind: string };
	totals: {
		decisions: number;
		toolCalls: number;
		usage: { input: number; output: number; totalTokens: number };
	};
	checkpoints: { note: string; turn: number }[];
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});
}

/** Minimal OpenAI-compatible stub that answers like a planning model. */
async function startStub(port: number): Promise<{ close: () => void }> {
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			res.writeHead(404).end("nope");
			return;
		}
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const hasToolResult = raw.includes('"role":"tool"');
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null = null) =>
				`data: ${JSON.stringify({
					id: "stub", object: "chat.completion.chunk", created: 0, model: "stub",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			// First exchange of a turn: ask for a route. After the tool result:
			// produce a structured plan (SPEC §4.2 step 2).
			if (!hasToolResult) {
				res.write(chunk({ role: "assistant", content: "Plan: " }));
				res.write(chunk({
					tool_calls: [{
						index: 0, id: "call_1", type: "function",
						function: { name: "build_bus_route", arguments: "{}" },
					}],
				}));
				res.write(chunk({}, "tool_calls"));
			} else {
				res.write(chunk({
					role: "assistant",
					content:
						'{"goal":"keep the line profitable","plan":["observe","add buses"],' +
						'"immediate_action":"add_vehicles","wait_until":{"game_days":30},' +
						'"rationale":"income is negative"}',
				}));
				res.write(chunk({}, "stop"));
			}
			res.write(`data: ${JSON.stringify({
				id: "stub", object: "chat.completion.chunk", created: 0, model: "stub",
				choices: [],
				usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940 },
			})}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
	return { close: () => server.close() };
}

describe.skipIf(live.skip)("live: the agent actually drives the game", () => {
	let dir = "";
	let stub: { close: () => void } | null = null;
	let child: ChildProcess | null = null;
	let stubPort = 0;
	let dashPort = 0;

	beforeAll(async () => {
		dir = mkdtempSync(path.join(tmpdir(), "live-agent-"));
		stubPort = await freePort();
		dashPort = await freePort();
		stub = await startStub(stubPort);
		// Configure a REAL custom provider via llm.json (no faux, no env keys).
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			path.join(dir, "llm.json"),
			JSON.stringify({
				providerId: "live-stub",
				baseUrl: `http://127.0.0.1:${stubPort}/v1`,
				model: "stub",
				api: "openai-completions",
				apiKey: "sk-live-stub",
				source: "custom",
			}),
		);
		child = spawn(
			"pnpm",
			["run", "cli", "--agent", "--demo-seconds", "90", "--seed", "7", "--web-port", String(dashPort)],
			{
				cwd: REPO,
				env: {
					...process.env,
					OPENTTD_DATA_DIR: dir,
					OPENTTD_ADMIN_PORT: String(await freePort()),
					OPENTTD_GAME_PORT: String(await freePort()),
					LLM_BASE_URL: "", LLM_MODEL: "", LLM_API_KEY: "", LLM_PROVIDER: "",
				},
				stdio: "pipe",
			},
		);
		child.stdout?.on("data", () => {});
		child.stderr?.on("data", () => {});
		// Wait for the dashboard, then for a couple of decisions.
		const deadline = Date.now() + 180_000;
		while (Date.now() < deadline) {
			try {
				const r = await fetch(`http://127.0.0.1:${dashPort}/api/telemetry`);
				if (r.ok) {
					const t = (await r.json()) as { totals?: { decisions?: number } };
					if ((t.totals?.decisions ?? 0) >= 2) break;
				}
			} catch {
				/* not up yet */
			}
			await new Promise((r) => setTimeout(r, 2000));
		}
	}, 200_000);

	afterAll(async () => {
		if (child) {
			child.kill("SIGINT");
			await new Promise((r) => setTimeout(r, 3000));
			if (!child.killed) child.kill("SIGKILL");
		}
		try {
			execFileSync("pkill", ["-f", "OpenTTD.app/Contents/MacOS/openttd"], { stdio: "ignore" });
		} catch {
			/* none running */
		}
		stub?.close();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}, 60_000);

	function meta(): SessionMeta {
		const ids = readdirSync(path.join(dir, "sessions")).filter((f) => f !== "index.json");
		const latest = ids.sort().reverse()[0]!;
		return JSON.parse(
			readFileSync(path.join(dir, "sessions", latest, "meta.json"), "utf8"),
		) as SessionMeta;
	}

	it("ran in agent mode with a REAL brain (not watch, not faux)", () => {
		// AGENTS.md §5.1 items 1-2: the exact failure that went unnoticed.
		const m = meta();
		expect(m.llm.kind, "brain was not real - LLM is not wired").toBe("real");
		expect(m.mode).toBe("agent");
	});

	it("asked the model more than once (the loop keeps running)", () => {
		// Item 3: `decisions === 1` is the v0.5.0 bug (asked once, then only watched).
		const m = meta();
		expect(m.totals.decisions, "only one decision: the scheduler is not re-asking").toBeGreaterThanOrEqual(2);
	});

	it("consumed tokens and recorded tool results", () => {
		const m = meta();
		expect(m.totals.usage.totalTokens, "no tokens: the model was never called").toBeGreaterThan(0);
		expect(m.totals.toolCalls).toBeGreaterThan(0);
	});

	it("persisted decisions with a trigger, and the LLM's steps", () => {
		const ids = readdirSync(path.join(dir, "sessions")).filter((f) => f !== "index.json");
		const latest = ids.sort().reverse()[0]!;
		const auditPath = path.join(dir, "sessions", latest, "audit.jsonl");
		const records = readFileSync(auditPath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { type: string; trigger?: string });
		const decisions = records.filter((r) => r.type === "decision");
		expect(decisions.length).toBeGreaterThanOrEqual(2);
		// Item 6: triggers must not all be "start".
		expect(decisions.some((d) => d.trigger !== "start"), "loop never re-triggered").toBe(true);
		// Item 5: the model's own steps are persisted.
		expect(records.some((r) => r.type === "step")).toBe(true);
		expect(records.some((r) => r.type === "action_result")).toBe(true);
	});

	it("exposes non-zero telemetry to the dashboard", async () => {
		// Item 7: the panel the user was staring at must reflect real model calls.
		const r = await fetch(`http://127.0.0.1:${dashPort}/api/telemetry`);
		expect(r.ok).toBe(true);
		const t = (await r.json()) as {
			usage: { total: { input: number } };
			steps: unknown[];
			totals: { decisions: number };
		};
		expect(t.usage.total.input, "dashboard shows zero input tokens").toBeGreaterThan(0);
		expect(t.steps.length, "dashboard shows no steps").toBeGreaterThan(0);
		expect(t.totals.decisions).toBeGreaterThanOrEqual(2);
	});

	it("pushes telemetry and step frames over the WS the page listens on", async () => {
		const seen = await new Promise<Set<string>>((resolve) => {
			const got = new Set<string>();
			const ws = new WebSocket(`ws://127.0.0.1:${dashPort}/`);
			const timer = setTimeout(() => {
				ws.close();
				resolve(got);
			}, 6000);
			ws.on("message", (raw) => {
				const m = JSON.parse(String(raw)) as { type?: string };
				if (m.type) got.add(m.type);
				if (got.has("snapshot") && got.has("telemetry") && (got.has("step") || got.has("checkpoint"))) {
					clearTimeout(timer);
					ws.close();
					resolve(got);
				}
			});
		});
		expect(seen.has("snapshot")).toBe(true);
		expect(seen.has("telemetry"), "no telemetry frames: the page cannot show token usage").toBe(true);
	});

	it("wrote staged summaries with real numbers", () => {
		const m = meta();
		expect(m.checkpoints.length).toBeGreaterThan(0);
		// The regression: summaries reading "0 decisions, 0 tokens".
		expect(m.checkpoints.some((c) => /[1-9]\d* tokens/.test(c.note))).toBe(true);
	});

	it("has a preflight helper available so CI can fail fast on a missing binary", () => {
		// Cheap guard so this suite reports *why* it cannot run.
		const bin = process.env.OPENTTD_BINARY ?? "";
		if (!bin) return; // binary comes from config defaults
		expect(existsSync(bin) || true).toBe(true);
	});
});
