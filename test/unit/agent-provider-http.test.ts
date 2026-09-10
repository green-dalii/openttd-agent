/**
 * Integration test — REAL HTTP provider path (local OpenAI-compatible stub).
 *
 * 目的: 证明「配置(baseUrl/key/model) → pi-ai provider → 真实 HTTP 流式请求 →
 *   LLM 工具调用 → 命令通道」这条链路可用。使用本机 stub（不访问外网），因此
 *   可在 CI/门禁中运行；这也是替代 faux provider 的"真实接线"验证。
 * 事实来源: SPEC §4；pi-ai api/openai-completions（OpenAI 兼容 SSE）。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildProvider } from "../../src/agent/provider.js";
import { createAgent } from "../../src/agent/runtime.js";
import { Telemetry } from "../../src/agent/telemetry.js";
import type { AgentDeps, CommandSink, StateReader } from "../../src/agent/types.js";

/** Scripted OpenAI-compatible SSE server: 1st call = tool call, 2nd = text. */
function startStub(): Promise<{
	port: number;
	requests: Array<{ auth?: string; body: unknown }>;
	close: () => Promise<void>;
}> {
	const requests: Array<{ auth?: string; body: unknown }> = [];
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
			res.writeHead(404).end("nope");
			return;
		}
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			let body: unknown = {};
			try {
				body = JSON.parse(raw);
			} catch {
				/* ignore */
			}
			requests.push({ auth: req.headers.authorization, body });
			const callIndex = requests.length; // 1-based
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null = null) =>
				`data: ${JSON.stringify({
					id: "stub-1",
					object: "chat.completion.chunk",
					created: 0,
					model: "stub-model",
					choices: [{ index: 0, delta, finish_reason: finish }],
				})}\n\n`;
			// OpenAI stream_options.include_usage shape (choices: [] + usage).
			const usageChunk = (prompt: number, completion: number) =>
				`data: ${JSON.stringify({
					id: "stub-1",
					object: "chat.completion.chunk",
					created: 0,
					model: "stub-model",
					choices: [],
					usage: {
						prompt_tokens: prompt,
						completion_tokens: completion,
						total_tokens: prompt + completion,
						completion_tokens_details: { reasoning_tokens: 7 },
					},
				})}\n\n`;
			if (callIndex === 1) {
				// tool call: build_bus_route({ from_town: 6, to_town: 18 })
				res.write(chunk({ role: "assistant", content: "" }));
				res.write(
					chunk({
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "build_bus_route", arguments: '{"from_town":6,' },
							},
						],
					}),
				);
				res.write(
					chunk({
						tool_calls: [{ index: 0, function: { arguments: '"to_town":18}' } }],
					}),
				);
				res.write(chunk({}, "tool_calls"));
				res.write(usageChunk(120, 30));
			} else {
				res.write(chunk({ role: "assistant", content: "Route requested." }));
				res.write(chunk({}, "stop"));
				res.write(usageChunk(200, 10));
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				port,
				requests,
				close: () =>
					new Promise<void>((r) => {
						server.close(() => r());
					}),
			});
		});
	});
}

function fakeDeps() {
	const gameScript: string[] = [];
	const sink: CommandSink = { gameScript: (j) => gameScript.push(j), rcon: () => {} };
	const state: StateReader = {
		snapshot: () => ({ date: null, companies: new Map(), recent: [], totalEvents: 0 }),
	};
	const deps: AgentDeps = { sink, state };
	return { deps, gameScript };
}

describe("real HTTP provider (openai-completions) drives a tool call", () => {
	let stub: Awaited<ReturnType<typeof startStub>>;
	beforeAll(async () => {
		stub = await startStub();
	});
	afterAll(async () => {
		await stub.close();
	});

	it("sends the request to the configured baseUrl with the API key and executes the returned tool call", async () => {
		const built = await buildProvider({
			providerId: "stub-llm",
			baseUrl: `http://127.0.0.1:${stub.port}/v1`,
			apiKey: "sk-stub-key",
			model: "stub-model",
			api: "openai-completions",
			contextWindow: 8000,
			maxTokens: 512,
		});
		const { deps, gameScript } = fakeDeps();
		const { agent } = createAgent({
			deps,
			streamFn: built.streamFn as never,
			model: built.model as never,
		});

		// Subscribe before prompting so no event is missed.
		const telemetry = new Telemetry();
		agent.subscribe((ev) => telemetry.ingestAgentEvent(ev));

		await agent.prompt("build a route");

		// The real HTTP round-trip happened (>=1 request) with our key.
		expect(stub.requests.length).toBeGreaterThanOrEqual(1);
		expect(stub.requests[0]!.auth).toBe("Bearer sk-stub-key");
		// The LLM's tool call reached the CommandSink unchanged.
		expect(gameScript).toHaveLength(1);
		expect(JSON.parse(gameScript[0]!)).toEqual({
			cmd: "build_bus_route",
			company: 0,
			townA: 6,
			townB: 18,
		});

		// Token usage from the provider reaches telemetry (dashboard accounting).
		const snap = telemetry.snapshot();
		expect(snap.totals.messages).toBeGreaterThanOrEqual(1);
		expect(snap.usage.total.input).toBeGreaterThan(0);
		expect(snap.usage.total.reasoning).toBeGreaterThan(0);
	});
});
