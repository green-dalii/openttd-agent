/**
 * L2 查询工具（Issue #13 的第二项）：`inspect_vehicle` / `inspect_town`。
 *
 * 职责: 守住三件事 —— ① **答案进工具结果**（模型问完就能用）；② 拿不到答案时
 *   **明说拿不到**（超时/通道坏了 ≠ "没有这辆车"）；③ 工具**只读**（不改变世界）。
 * 为什么: 观测面是**周期采样**，它说"世界此刻长什么样"，不说"**我那辆车**在干什么"。
 */

import { describe, expect, it, vi } from "vitest";
import { createTools, inspectTownTool, inspectVehicleTool } from "../../src/agent/tools/index.js";
import type { AgentDeps } from "../../src/agent/types.js";

function deps(over: Partial<AgentDeps> = {}): AgentDeps {
	return {
		sink: {
			gameScript: vi.fn(),
			rcon: vi.fn(),
		},
		state: { snapshot: () => ({}) } as never,
		...over,
	} as unknown as AgentDeps;
}

/** The tool result's text (what the model actually reads). */
async function run(tool: unknown, params: unknown): Promise<string> {
	const res = await (tool as { execute: (id: string, params: unknown) => Promise<{ content: { type: string; text: string }[] }> }).execute("id-1", params);
	return res.content.map((c) => c.text).join("\n");
}

describe("L2 查询：inspect_vehicle", () => {
	it("答案进工具结果（模型问完就能用）", async () => {
		const gameScriptAwait = vi.fn().mockResolvedValue({
			kind: "answer",
			id: 1,
			ok: true,
			data: { vehicle: 8, name: "Bus 8", age_days: 12, cargo: 3 },
		});
		const text = await run(inspectVehicleTool(deps({ sink: { gameScript: vi.fn(), rcon: vi.fn(), gameScriptAwait } } as never)), {
			vehicle: 8,
		});
		expect(text).toContain("Bus 8");
		expect(text).toContain("age_days");
		// 命令里带着问的对象。
		expect(gameScriptAwait).toHaveBeenCalled();
		const sent = String(gameScriptAwait.mock.calls[0]![0]);
		expect(sent).toContain('"cmd":"inspect_vehicle"');
		expect(sent).toContain('"vehicle":8');
	});

	it("**没等到回答**时明说没得到（不说「没有这辆车」）", async () => {
		const gameScriptAwait = vi.fn().mockResolvedValue(null);
		const text = await run(inspectVehicleTool(deps({ sink: { gameScript: vi.fn(), rcon: vi.fn(), gameScriptAwait } } as never)), {
			vehicle: 8,
		});
		expect(text).toContain("no answer from the game");
		expect(text).not.toContain("no such vehicle");
	});

	it("游戏说「没有这辆车」时照抄它的话（不自己编）", async () => {
		const gameScriptAwait = vi.fn().mockResolvedValue({ kind: "answer", id: 1, ok: false, reason: "no such vehicle" });
		const text = await run(inspectVehicleTool(deps({ sink: { gameScript: vi.fn(), rcon: vi.fn(), gameScriptAwait } } as never)), {
			vehicle: 999,
		});
		expect(text).toContain("no such vehicle");
	});

	it("通道不存在时明说不可用（不是「没查到」）", async () => {
		const text = await run(inspectVehicleTool(deps()), { vehicle: 8 });
		expect(text).toContain("not available");
	});
});

describe("L2 查询：inspect_town", () => {
	it("答案进工具结果", async () => {
		const gameScriptAwait = vi.fn().mockResolvedValue({
			kind: "answer",
			id: 1,
			ok: true,
			data: { town: 23, name: "Chedingworth", population: 4120 },
		});
		const text = await run(inspectTownTool(deps({ sink: { gameScript: vi.fn(), rcon: vi.fn(), gameScriptAwait } } as never)), {
			town: 23,
		});
		expect(text).toContain("Chedingworth");
		expect(text).toContain("population");
	});
});

describe("L2 查询：工具表", () => {
	it("两个查询工具都在工具表里（否则模型看不见它们）", () => {
		const names = createTools(deps()).map((t) => t.name);
		expect(names).toContain("inspect_vehicle");
		expect(names).toContain("inspect_town");
	});

	it("查询工具**只读**：不发任何动作命令", async () => {
		const gameScript = vi.fn();
		const gameScriptAwait = vi.fn().mockResolvedValue({ kind: "answer", ok: true, data: {} });
		await run(inspectVehicleTool(deps({ sink: { gameScript, rcon: vi.fn(), gameScriptAwait } } as never)), { vehicle: 1 });
		expect(gameScript).not.toHaveBeenCalled();
	});
});
