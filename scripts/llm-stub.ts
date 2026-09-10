/* eslint-disable no-console */
/**
 * LLM stub — a minimal OpenAI-compatible server for offline development.
 *
 * 职责: 在本机暴露 /v1/chat/completions，按脚本返回"工具调用 → 文本"两步响应，
 *   用于在**没有真实 LLM key** 时端到端验证 agent 接线（真实 HTTP，非 faux）。
 *   这是 dev tool，不是产品路径；真实 provider 由 dashboard/CLI 配置。
 * 用法:
 *   pnpm exec tsx scripts/llm-stub.ts [port]
 *   LLM_BASE_URL=http://127.0.0.1:8787/v1 LLM_MODEL=stub LLM_API_KEY=stub \
 *     pnpm run cli --agent --demo-seconds 120
 * 禁止: 用于生产；响应内容不含任何真实模型能力。
 */

import http from "node:http";

const port = Number(process.argv[2] ?? 8787);

function sse(res: http.ServerResponse, delta: unknown, finish: string | null = null): void {
	res.write(
		`data: ${JSON.stringify({
			id: "stub",
			object: "chat.completion.chunk",
			created: 0,
			model: "stub-model",
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`,
	);
}

const server = http.createServer((req, res) => {
	if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
		res.writeHead(404).end("not found");
		return;
	}
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		// Turn 2 is identified by the tool result being present in the request.
		const hasToolResult = raw.includes('"role":"tool"');
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (!hasToolResult) {
			// Turn 1: request a bus route (planner picks towns).
			sse(res, { role: "assistant", content: "" });
			sse(res, {
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "build_bus_route", arguments: "{}" },
					},
				],
			});
			sse(res, {}, "tool_calls");
		} else {
			// Turn 2: nothing further to do.
			sse(res, { role: "assistant", content: "Route requested; awaiting construction." });
			sse(res, {}, "stop");
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

server.listen(port, "127.0.0.1", () => {
	console.log(`[llm-stub] listening on http://127.0.0.1:${port}/v1 (OpenAI-compatible)`);
});
