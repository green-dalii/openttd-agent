/**
 * 按需全量的只读工具（"数据按需全量"）：`get_industries` / `get_cargo`。
 *
 * 职责: 守住三件事 —— ① **全量**进工具结果（模型问完就能用）；
 *   ② 拿不到答案时**明说拿不到**（超时/通道坏了 ≠ "没有产业"）；
 *   ③ 工具**只读**（不改变世界），且**观测面的载荷不涨**（取样仍在前端）。
 */

import { describe, expect, it, vi } from "vitest";
import { getCargoTool, getIndustriesTool } from "../../src/agent/tools/index.js";
import { ACTION_EFFECTS } from "../../src/agent/tools/catalog.js";
import type { AgentDeps } from "../../src/agent/types.js";

function deps(gameScriptAwait?: (json: string, timeoutMs?: number) => Promise<unknown>): AgentDeps {
	return {
		sink: {
			gameScript: vi.fn(),
			rcon: vi.fn(),
			...(gameScriptAwait ? { gameScriptAwait } : {}),
		},
		state: { snapshot: () => ({}) } as never,
	} as unknown as AgentDeps;
}

async function run(tool: unknown, params: unknown = {}): Promise<string> {
	const res = await (
		tool as { execute: (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[] }> }
	).execute("id-1", params);
	return res.content.map((c) => c.text).join("\n");
}

describe("按需全量：get_industries", () => {
	it("全量产业进工具结果（不是取样）", async () => {
		const gameScriptAwait = vi.fn().mockResolvedValue({
			kind: "answer",
			id: 1,
			ok: true,
			data: {
				total: 2,
				industries: [
					{ id: 28, cargo: "COAL", name: "Lonningbury Coal Mine", produced: 120, transported: 0, stock: 5 },
					{ id: 53, cargo: "COAL", name: "Lafinghill Power Station", produced: 0, transported: 90, stock: 0 },
				],
			},
		});
		const text = await run(
			getIndustriesTool(deps(gameScriptAwait as never)),
		);
		expect(text).toContain("Lonningbury Coal Mine");
		expect(text).toContain("Lafinghill Power Station");
		expect(text).toContain("2 industries");
		const sent = String(gameScriptAwait.mock.calls[0]![0]);
		expect(sent).toContain('"cmd":"list_industries"');
	});

	it("**没等到回答**时明说没得到（不说「没有产业」）", async () => {
		const gameScriptAwait = vi.fn().mockResolvedValue(null);
		const text = await run(getIndustriesTool(deps(gameScriptAwait as never)));
		expect(text).toContain("no answer from the game");
		// 不得**断言**世界里没有产业（那是关于世界的假话；只能说"没拿到"）。
		expect(text).not.toMatch(/there (are|were) no industries/i);
	});

	it("没有回答通道时明说不可用", async () => {
		const text = await run(getIndustriesTool(deps()));
		expect(text).toContain("not available in this run");
	});
});

describe("按需全量：get_cargo", () => {
	it("**每一个**货种的读数进工具结果（含没有产量的）", async () => {
		const gameScriptAwait = vi.fn().mockResolvedValue({
			kind: "answer",
			id: 1,
			ok: true,
			data: {
				total: 2,
				readings: [
					{ label: "COAL", freight: true, produced: 120, transported: 90 },
					{ label: "PASS", freight: false, produced: 0, transported: 0 },
				],
			},
		});
		const text = await run(getCargoTool(deps(gameScriptAwait as never)));
		expect(text).toContain("COAL");
		// "没有产量"的那个货种**也在**（观测面只报有产量的 ⇒ 分不清 0 与没测到）。
		expect(text).toContain("PASS");
		const sent = String(gameScriptAwait.mock.calls[0]![0]);
		expect(sent).toContain('"cmd":"list_cargo"');
	});

	it("**没等到回答**时明说没得到", async () => {
		const gameScriptAwait = vi.fn().mockResolvedValue(null);
		const text = await run(getCargoTool(deps(gameScriptAwait as never)));
		expect(text).toContain("no answer from the game");
	});
});

describe("按需全量的工具登记表", () => {
	it("两个工具都是**只读**（不改变世界）", () => {
		expect(ACTION_EFFECTS.get_industries).toBe("read");
		expect(ACTION_EFFECTS.get_cargo).toBe("read");
	});
});
