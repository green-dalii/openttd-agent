/**
 * Unit tests — the run manifest and the outcome taxonomy (D3b / S8, S9).
 *
 * 职责: 锁定两件事——① 每一局都能说清"它是什么"（模型实际是谁、脚手架是哪一份、
 * 旋钮是多少）；② 0 分的局必须带**成因**，不能只有一个数字。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §4 的 S8/S9；口径见 SPEC.md §10.119。
 * 禁止: 在此断言任何评价性文案。
 */

import { describe, expect, it } from "vitest";
import { classifyOutcome } from "../../src/evolution/outcome.js";
import { scaffoldHash } from "../../src/agent/scaffold-fingerprint.js";

function row(over: Record<string, unknown> = {}) {
	return {
		deliveredRun: 0,
		constructionDone: true,
		toolCalls: 4,
		toolFailures: 0,
		gsErrors: 0,
		reachedHorizon: true,
		blockedByPause: false,
		worldFrozen: false,
		...over,
	} as never;
}

describe("classifyOutcome（0 分也要有成因）", () => {
	it("交付了东西 → delivered", () => {
		expect(classifyOutcome(row({ deliveredRun: 120 }))).toBe("delivered");
	});

	it("建成但一单没送 → delivered_nothing（与「没建成」不同）", () => {
		expect(classifyOutcome(row({ deliveredRun: 0, constructionDone: true }))).toBe("delivered_nothing");
	});

	it("没建成线 → no_construction", () => {
		expect(classifyOutcome(row({ deliveredRun: 0, constructionDone: false }))).toBe("no_construction");
	});

	it("工具全被拒 → refused", () => {
		expect(classifyOutcome(row({ deliveredRun: 0, toolCalls: 5, toolFailures: 5 }))).toBe("refused");
	});

	it("agent 自己按了暂停 → paused_by_agent（不是“没学会”）", () => {
		expect(classifyOutcome(row({ deliveredRun: 0, blockedByPause: true }))).toBe("paused_by_agent");
	});

	it("世界冻住 → world_frozen", () => {
		expect(classifyOutcome(row({ deliveredRun: 0, worldFrozen: true }))).toBe("world_frozen");
	});

	it("墙钟到点 → wall_clock_cap", () => {
		expect(classifyOutcome(row({ deliveredRun: 0, reachedHorizon: false }))).toBe("wall_clock_cap");
	});

	it("读数缺失 → unknown（不猜）", () => {
		expect(classifyOutcome(row({ deliveredRun: null, constructionDone: null }))).toBe("unknown");
	});

	it("成因有优先级：暂停比“没建成”更具体", () => {
		expect(classifyOutcome(row({ deliveredRun: 0, constructionDone: false, blockedByPause: true }))).toBe(
			"paused_by_agent",
		);
	});
});

describe("scaffoldHash（脚手架指纹）", () => {
	const tools = [
		{ name: "observe", description: "read the world", parameters: { type: "object", properties: {} } },
		{ name: "build_bus_route", description: "build a line", parameters: { type: "object", properties: { a: { type: "number" } } } },
	];

	it("同样的提示词与工具 → 同一个指纹", () => {
		expect(scaffoldHash("prompt", tools)).toBe(scaffoldHash("prompt", tools));
	});

	it("工具集变了 → 指纹变了（否则两局可能不是同一套脚手架）", () => {
		expect(scaffoldHash("prompt", tools)).not.toBe(scaffoldHash("prompt", tools.slice(0, 1)));
	});

	it("工具描述变了 → 指纹变了", () => {
		const changed = [{ ...tools[0]!, description: "read the world (v2)" }, tools[1]!];
		expect(scaffoldHash("prompt", tools)).not.toBe(scaffoldHash("prompt", changed));
	});

	it("提示词变了 → 指纹变了", () => {
		expect(scaffoldHash("prompt", tools)).not.toBe(scaffoldHash("prompt v2", tools));
	});

	it("工具顺序变了 → 指纹也变（顺序是契约的一部分）", () => {
		expect(scaffoldHash("prompt", tools)).not.toBe(scaffoldHash("prompt", [...tools].reverse()));
	});
});
