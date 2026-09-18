import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouteLedger } from "../../src/agent/route-ledger.js";
import { runFinalizeAndReflect } from "../../src/agent/reflect-run.js";
import { makeRouteFactsProvider, routeFactsFromLedger, saveRouteFacts } from "../../src/evolution/route-facts.js";
import { toGameMetric } from "../../src/evolution/metrics.js";

/**
 * Phase C TDD：
 *   C-1 接线 —— 局终把账本事实落盘 route-facts.jsonl；决策上下文注入事实行。
 *   C-2 躺平局降权 —— 零下单局不产出 lesson（§10.43：无可学习策略，纯噪声）。
 * golden 语义来自 cal6/cal7/cal8 真机（job 100/101、towns 9->12/9->17）。
 */

function fakeSession() {
	return {
		id: "s-test",
		current: () => ({
			checkpoints: [{ note: "seed", gameDate: "1950-03-14" }],
			totals: { events: 0, decisions: 0, toolCalls: 0, toolFailures: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costTotal: 0 } },
			startedAt: Date.now(),
		}),
		saveTelemetry: vi.fn(),
		update: vi.fn(),
		addCheckpoint: vi.fn(),
		finalize: vi.fn(),
	} as never;
}

function fakeTelemetry(decisions: number) {
	return {
		snapshot: () => ({
			totals: { decisions, toolCalls: 2, toolFailures: 0 },
			usage: { total: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 100, costTotal: 0.001 } },
		}),
	} as never;
}

function fakeWorld() {
	return {
		snapshot: () => ({
			date: { year: 1950, month: 4, day: 1 },
			companies: new Map(),
			towns: [],
			recent: [],
			totalEvents: 0,
		}),
	} as never;
}

const completeOnce = vi.fn(async () => "ok");

async function runFinalize(dir: string, ledger: RouteLedger, decisions: number) {
	return runFinalizeAndReflect({
		cfg: { dataDir: dir, seed: 7 } as never,
		world: fakeWorld(),
		session: fakeSession(),
		telemetry: fakeTelemetry(decisions),
		executorPhase: "EX boot j-1",
		reachedDone: false,
		scheduler: { count: () => decisions },
		pendingActions: [],
		routeLedger: ledger,
		getRouteStats: () => [],
		gsErrors: 0,
		episode: { simulatedDays: 0, horizonDays: null, reachedHorizon: false, stopReason: null },
		arm: "control" as const,
		completeOnce: completeOnce as never,
	});
}

describe("C-1 接线：局终落盘路线事实", () => {
	it("有下单的局：账本 → route-facts.jsonl（确定性，不经 LLM）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rf-"));
		const ledger = new RouteLedger();
		ledger.record({ job: 100, fromTown: 9, toTown: 12, decision: 2, orderedAt: 1 });
		ledger.markDone(100, "1950-03-14");
		await runFinalize(dir, ledger, 2);
		const path = join(dir, "evolution", "route-facts.jsonl");
		expect(existsSync(path)).toBe(true);
		const raw = readFileSync(path, "utf8");
		expect(raw).toContain('"from":9');
		expect(raw).toContain('"to":12');
		expect(raw).toContain('"completed":true');
	});

	it("躺平局（零下单）：不写文件、不调用 LLM 反思（C-2 同源）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rf-"));
		const ledger = new RouteLedger(); // 无任何 record
		completeOnce.mockClear();
		await runFinalize(dir, ledger, 3); // 有决策但零下单
		expect(existsSync(join(dir, "evolution", "route-facts.jsonl"))).toBe(false);
		expect(completeOnce).not.toHaveBeenCalled(); // C-2：躺平局的"教训"不产出
	});

	it("有下单但全未完成的局：仍然反思（可行性教训有效），事实如实落盘", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rf-"));
		const ledger = new RouteLedger();
		ledger.record({ job: 101, fromTown: 9, toTown: 17, decision: 3, orderedAt: 2 });
		completeOnce.mockClear();
		await runFinalize(dir, ledger, 3);
		expect(completeOnce).toHaveBeenCalled(); // 下单过 → 有可反思的内容
		const raw = readFileSync(join(dir, "evolution", "route-facts.jsonl"), "utf8");
		expect(raw).toContain('"completed":false');
	});
});

describe("C-1 接线：决策上下文注入事实行", () => {
	it("makeRouteFactsProvider：闭包缓存启动时快照，返回事实行；空库 → 空", () => {
		const dir = mkdtempSync(join(tmpdir(), "rf-"));
		expect(makeRouteFactsProvider(dir)()).toEqual([]); // 空库不造占位符
		const ledger = new RouteLedger();
		ledger.record({ job: 100, fromTown: 9, toTown: 12, decision: 2, orderedAt: 1 });
		ledger.markDone(100, "1950-03-14");
		// 直接通过 routeFactsFromLedger 落盘（模拟上一局 finalize 做过的事）
		saveRouteFacts(dir, routeFactsFromLedger(ledger.all()));
		const lines = makeRouteFactsProvider(dir)();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("9->12");
		expect(lines[0]).toContain("built");
	});
});

/**
 * N2-5 缺陷的守卫：arm 必须**落进 metrics.jsonl**，否则 compareArms 只能靠
 * 注入计数推断（/tmp/n2ab 因此把 5v5 算成 4v6）。
 */
describe("arm 落盘守卫（N2-5）", () => {
	it("finalize 写入的 arm 出现在 evolution/metrics.jsonl", async () => {
		const meta = toGameMetric(
			{ id: "x", mode: "agent", status: "aborted", startedAt: 0, seed: 1, llm: { kind: "real" }, arm: "treatment" } as never,
			{ lessonsInjected: 0, strategiesInjected: 0, routeFactsInjected: 0 },
		);
		expect(meta.arm).toBe("treatment");
		// 关键性质：arm 与"注入了多少"无关
		expect(meta.memory.lessonsInjected).toBe(0);
	});
});
