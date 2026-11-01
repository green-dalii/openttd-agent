/**
 * Unit tests — the metric ledger must not lose runs (Issue #58).
 *
 * 职责: 锁住两件事：
 *   1) **session id 每局唯一** —— 同一秒 + 同 seed 的两局（两个模型并行）曾经拿到
 *      同一个 id，账本"同 id 取最新"⇒ **一行静默消失**（基准最坏的 bug：样本悄悄变少）。
 *   2) **账本要报告碰撞** —— 真有重复 id 时，读账本必须**说出来**，而不是悄悄丢。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionId } from "../../src/agent/session-store.js";
import { readMetrics, readMetricsWithCollisions } from "../../src/evolution/store.js";
import type { GameMetric } from "../../src/evolution/metrics.js";

function dir(): string {
	return mkdtempSync(join(tmpdir(), "ledger-collide-"));
}

function metric(id: string, over: Partial<GameMetric> = {}): GameMetric {
	return {
		id,
		seed: 7,
		mode: "agent",
		status: "completed",
		startedAt: 1_000,
		durationMs: 1_000,
		appVersion: "t",
		llmKind: "real",
		llmModel: "model-a",
		constructionDone: true,
		money: 0,
		income: 0,
		delivered: 1,
		deliveredRun: 1,
		deliveredRunComplete: true,
		gsErrors: 0,
		toolBudgetBlocks: 0,
		worldFrozenMs: null,
		simulatedDays: 10,
		horizonDays: 300,
		reachedHorizon: false,
		scenario: null,
		scenarioReason: null,
		deliveredAtReady: 0,
		vehicles: 0,
		stations: 0,
		decisions: 1,
		toolCalls: 1,
		toolFailures: 0,
		totalTokens: 100,
		costTotal: 0,
		...over,
	} as GameMetric;
}

describe("session id uniqueness (Issue #58)", () => {
	it("gives two runs started in the same second on the same seed different ids", () => {
		const at = new Date("2026-10-31T21:49:49Z");
		const a = newSessionId(4242, at);
		const b = newSessionId(4242, at);
		expect(a).not.toBe(b);
	});

	it("keeps the id sortable and readable (stamp, seed, nonce)", () => {
		const id = newSessionId(4242, new Date("2026-10-31T21:49:49Z"), "a3f1");
		expect(id).toContain("seed4242");
		expect(id.endsWith("-a3f1")).toBe(true);
	});

	it("keeps the id filesystem-safe (no path separators, no spaces)", () => {
		const id = newSessionId(7, new Date("2026-01-02T03:04:05Z"));
		expect(id).toMatch(/^[0-9a-z-]+$/i);
	});
});

describe("the ledger reports collisions instead of dropping rows", () => {
	it("counts the rows a duplicate id swallowed", () => {
		const d = dir();
		mkdirSync(join(d, "evolution"), { recursive: true });
		const same = "20261031-214949-seed4242";
		writeFileSync(
			join(d, "evolution", "metrics.jsonl"),
			[
				JSON.stringify(metric(same, { llmModel: "model-a" })),
				JSON.stringify(metric(same, { llmModel: "model-b", startedAt: 2_000 })),
				JSON.stringify(metric("other", { llmModel: "model-c" })),
			].join("\n") + "\n",
			"utf8",
		);
		const { rows, collisions } = readMetricsWithCollisions(d);
		// Two runs shared an id: one survives, and the loss is *reported*.
		expect(rows).toHaveLength(2);
		expect(collisions).toHaveLength(1);
		expect(collisions[0]!.id).toBe(same);
		expect(collisions[0]!.dropped).toBe(1);
	});

	it("reports nothing when every id is unique", () => {
		const d = dir();
		mkdirSync(join(d, "evolution"), { recursive: true });
		writeFileSync(
			join(d, "evolution", "metrics.jsonl"),
			[JSON.stringify(metric("a")), JSON.stringify(metric("b"))].join("\n") + "\n",
			"utf8",
		);
		const { rows, collisions } = readMetricsWithCollisions(d);
		expect(rows).toHaveLength(2);
		expect(collisions).toEqual([]);
	});

	it("keeps readMetrics working (the plain reader still returns the rows)", () => {
		const d = dir();
		mkdirSync(join(d, "evolution"), { recursive: true });
		writeFileSync(join(d, "evolution", "metrics.jsonl"), JSON.stringify(metric("a")) + "\n", "utf8");
		expect(readMetrics(d)).toHaveLength(1);
	});
});
