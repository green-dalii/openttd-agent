/**
 * Harness tool adapter (D6a/M3).
 *
 * 为什么值得测：harness 的参数顺序与裸 Agent **不同**（第 3 个参数是 onUpdate，
 * 不是 signal）。转发错位不会报错 —— 回调进了 signal 位就被静默丢弃，而工具
 * 仍会正常返回。测试锁的是"位置"，不是"看起来跑了"。
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { toHarnessTools } from "../../src/agent/harness-tools.js";

function tool(name: string, execute: AgentTool<TSchema, unknown>["execute"]): AgentTool<TSchema, unknown> {
	return { name, label: name, description: name, parameters: {} as TSchema, execute };
}

describe("toHarnessTools", () => {
	it("keeps every identity field the harness reads", () => {
		const [t] = toHarnessTools<undefined, unknown>([
			tool("observe", async () => ({ content: [], details: {} })),
		]);
		expect(t?.name).toBe("observe");
		expect(t?.label).toBe("observe");
		expect(t?.description).toBe("observe");
	});

	it("passes params through and returns the agent-shaped result unchanged", async () => {
		const result = { content: [], details: { ok: true } };
		const execute = vi.fn(async () => result);
		const [t] = toHarnessTools<undefined, unknown>([tool("build", execute)]);
		const got = await t!.execute("call-1", { a: 1 } as never, (() => {}) as never, undefined, {} as never, {} as never);
		expect(execute).toHaveBeenCalledWith("call-1", { a: 1 }, undefined, expect.any(Function));
		expect(got).toBe(result);
	});

	it("forwards the progress callback in the harness's third slot", async () => {
		// A dropped onUpdate means the dashboard never sees partial tool output.
		let seen: unknown;
		const execute = vi.fn(async (_id: string, _params: never, _signal?: undefined, onUpdate?: unknown) => {
			seen = onUpdate;
			return { content: [], details: {} };
		});
		const [t] = toHarnessTools<undefined, unknown>([tool("slow", execute as never)]);
		const onUpdate = () => {};
		await t!.execute("c", {} as never, onUpdate as never, undefined, {} as never, {} as never);
		expect(seen).toBe(onUpdate);
	});

	it("propagates a thrown tool error instead of encoding it as success", async () => {
		const [t] = toHarnessTools<undefined, unknown>([
			tool("boom", async () => {
				throw new Error("nope");
			}),
		]);
		await expect(
			t!.execute("c", {} as never, (() => {}) as never, undefined, {} as never, {} as never),
		).rejects.toThrow(
			"nope",
		);
	});
});
