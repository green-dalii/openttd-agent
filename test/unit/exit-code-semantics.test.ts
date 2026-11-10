/**
 * 退出码的语义：**止损不是失败**。
 *
 * 为什么（ROADMAP「止损型 run 一律 exit 1 的语义分档」）：一局因为 token/花费
 * 上限、视界、墙钟、agent 自己暂停而**收场**时，数据是齐的 ⇒ 那是一次**正常的
 * 结果** ⇒ 退出码 0。否则每一局预算用尽的正常运行都会在 CI 里报红，而"红了"
 * 就没人看了 ⇒ 真失败被淹没。
 *
 * 退出码只回答"**harness 跑完了这一局吗**"：真失败走别的路径（GS 没起来、
 * 游戏崩了、runner 抛错）⇒ 那些仍然是 1。
 *
 * 这一局的**结果**在 manifest 的 outcome 里（结局十类，B5）⇒ CI 该读那个。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFinalizeAndReflect } from "../../src/agent/reflect-run.js";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";

function fakeSession() {
	const checkpoints: unknown[] = [];
	const audit: unknown[] = [];
	return {
		id: "s-1",
		current: () => ({
			totals: { usage: { totalTokens: 15, costTotal: 0 }, decisions: 3, toolCalls: 0, toolFailures: 0 },
			startedAt: Date.now(),
			checkpoints,
		}),
		saveTelemetry: () => {},
		update: () => {},
		addCheckpoint: (c: unknown) => checkpoints.push(c),
		finalize: () => {},
		appendAudit: (a: unknown) => audit.push(a),
		checkpoints,
		audit,
	};
}

function fakeWorld() {
	return {
		snapshot: () => ({
			date: { year: 1950, month: 1, day: 1, raw: 1 },
			companies: new Map(),
			totalEvents: 3,
		}),
	};
}

function fakeTelemetry(decisions: number) {
	return {
		snapshot: () => ({
			usage: { total: { input: 10, output: 5, reasoning: 0, totalTokens: 15, costTotal: 0 } },
			totals: { decisions, toolCalls: 0, toolFailures: 0 },
			brain: { kind: "faux" },
		}),
	};
}

async function finalize(reachedDone: boolean, stopReason: "horizon" | "wall_cap" | null): Promise<number> {
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage("nothing to record")]);
	return runFinalizeAndReflect({
		cfg: { dataDir: mkdtempSync(join(tmpdir(), "exit-")), seed: 7 } as never,
		world: fakeWorld() as never,
		session: fakeSession() as never,
		telemetry: fakeTelemetry(3) as never,
		executorPhase: "EX boot j-1",
		reachedDone,
		scheduler: { count: () => 3 },
		pendingActions: [],
		routeLedger: { all: () => [], lines: () => [] } as never,
		getRouteStats: () => [],
		gsErrors: 0,
		toolBudgetBlocks: 0,
		scenario: "freeform",
		episode: { simulatedDays: 100, horizonDays: 100, reachedHorizon: stopReason === "horizon", stopReason },
		arm: "control" as const,
		reflectLlm: { streamFn: faux.streamSimple, model: faux.getModel() },
	});
}

describe("退出码：止损不是失败", () => {
	it("施工没做完（预算用尽）⇒ 0（数据齐了，就是一次结果）", async () => {
		expect(await finalize(false, null)).toBe(0);
	});

	it("视界到了 ⇒ 0", async () => {
		expect(await finalize(true, "horizon")).toBe(0);
	});

	it("墙钟上限到了 ⇒ 0", async () => {
		expect(await finalize(false, "wall_cap")).toBe(0);
	});
});
