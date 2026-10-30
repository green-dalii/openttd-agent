/**
 * The History grouping (B6) — "按模型/按 seed/按后端看局".
 *
 * 为什么值得单测: 分组键**必须**来自度量行自己的字段。若让页面按字符串自己猜，
 * "哪个模型"就有两个来源（请求的模型 vs 实际服务的模型），替身网关会让两者不同，
 * 于是页面上"按模型分组"和账本里的模型对不上。
 */

import { describe, expect, it } from "vitest";
import { historyGroups } from "../../src/evolution/history-groups.js";
import type { GameMetric } from "../../src/evolution/metrics.js";

function row(over: Partial<GameMetric> = {}): GameMetric {
	return {
		id: "r1",
		seed: 7,
		manifest: { servedModel: "model-a", backend: "agent" },
		llmModel: "model-a",
		...over,
	} as unknown as GameMetric;
}

describe("historyGroups", () => {
	it("groups by the model that served the run", () => {
		const groups = historyGroups(
			[
				row({ id: "r1" }),
				row({ id: "r2" }),
				row({ id: "r3", manifest: { servedModel: "model-b", backend: "agent" } as never }),
			],
			"model",
		);
		expect(groups).toEqual([
			{ key: "model-a", count: 2, sessions: ["r1", "r2"] },
			{ key: "model-b", count: 1, sessions: ["r3"] },
		]);
	});

	it("groups by seed", () => {
		const groups = historyGroups([row({ id: "r1", seed: 7 }), row({ id: "r2", seed: 8 })], "seed");
		expect(groups.map((g) => g.key).sort()).toEqual(["7", "8"]);
	});

	it("groups by backend", () => {
		const groups = historyGroups(
			[
				row({ id: "r1" }),
				row({ id: "r2", manifest: { servedModel: "model-a", backend: "harness" } as never }),
			],
			"backend",
		);
		expect(groups.map((g) => g.key).sort()).toEqual(["agent", "harness"]);
	});

	it("says 'unknown' when the row has no such fact (never an empty key)", () => {
		const groups = historyGroups([row({ id: "r1", manifest: undefined, llmModel: "" })], "model");
		expect(groups[0]!.key).toBe("unknown");
	});

	it("sorts by count, then by key", () => {
		const groups = historyGroups(
			[...Array.from({ length: 3 }, (_, i) => row({ id: `b${i}`, llmModel: "b", manifest: { servedModel: "b", backend: "agent" } as never })),
			 ...Array.from({ length: 2 }, (_, i) => row({ id: `a${i}`, llmModel: "a", manifest: { servedModel: "a", backend: "agent" } as never }))],
			"model",
		);
		expect(groups.map((g) => g.key)).toEqual(["b", "a"]);
	});

	it("never throws on an empty ledger", () => {
		expect(historyGroups([], "model")).toEqual([]);
	});
});
