import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	routeFactsFromLedger,
	saveRouteFacts,
	loadRouteFacts,
	formatRouteFactsForInjection,
} from "../../src/evolution/route-facts.js";

/**
 * Phase C-1 TDD: 结构化记忆 —— 路线事实不经 LLM 直入库（SPEC §10.43 修法 1）。
 *
 * 为什么存在：§10.42/§10.43 实测 M3 记忆臂无收益的第一层原因是
 * "lesson 无含金量"——反思把账本里已有的精确数据压成过程散文。
 * 本模块把 pair→tiles/cost/outcome **确定性**入库，LLM 不参与。
 * golden 语义来自真机（cal6/cal7/cal8 的 ack/done/RESULT）。
 */

describe("routeFactsFromLedger —— 账本行 → 结构化事实", () => {
	it("完成的线：记录 pair、决策号、完成标记", () => {
		const facts = routeFactsFromLedger([
			{
				order: { job: 100, fromTown: 9, toTown: 12, decision: 2, orderedAt: 1000 },
				outcome: { completed: true, doneDate: "1950-03-14" },
			},
		]);
		expect(facts).toHaveLength(1);
		expect(facts[0]).toMatchObject({
			from: 9,
			to: 12,
			decision: 2,
			completed: true,
			doneDate: "1950-03-14",
		});
	});

	it("未完成的线如实保留 completed:false（不得美化）", () => {
		const facts = routeFactsFromLedger([
			{
				order: { job: 101, fromTown: 9, toTown: 17, decision: 3, orderedAt: 2000 },
				outcome: { completed: false },
			},
		]);
		expect(facts[0]).toMatchObject({ from: 9, to: 17, completed: false });
		expect(facts[0]!.doneDate).toBeUndefined();
	});

	it("空账本 → 空事实（不造数据）", () => {
		expect(routeFactsFromLedger([])).toEqual([]);
	});
});

describe("save/load —— JSONL 持久化（跨局累积）", () => {
	it("保存后可读回，且同 pair 同结局不重复", () => {
		const dir = `/tmp/route-facts-test-${Date.now()}`;
		const facts = [
			{ from: 9, to: 12, decision: 2, completed: true, doneDate: "1950-03-14" },
		];
		saveRouteFacts(dir, facts);
		saveRouteFacts(dir, facts); // 同一对再次入库
		const loaded = loadRouteFacts(dir);
		expect(loaded).toHaveLength(1); // 去重
		expect(loaded[0]!.savedAt).toBeGreaterThan(0); // savedAt 由实现盖章
	});

	it("同 pair 不同结局共存（上次建成、这次没建成，都是事实）", () => {
		const dir = `/tmp/route-facts-test2-${Date.now()}`;
		saveRouteFacts(dir, [
			{ from: 9, to: 12, decision: 2, completed: true },
		]);
		saveRouteFacts(dir, [
			{ from: 9, to: 12, decision: 5, completed: false },
		]);
		const loaded = loadRouteFacts(dir);
		expect(loaded).toHaveLength(2);
	});
});

describe("formatRouteFactsForInjection —— 注入格式（事实，不是建议）", () => {
	it("完成的线：陈述 pair/完成/日期，不给建议", () => {
		const lines = formatRouteFactsForInjection([
			{ from: 9, to: 12, decision: 2, completed: true, doneDate: "1950-03-14", savedAt: 1 },
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("9->12");
		expect(lines[0]).toContain("built");
		expect(lines[0]).toContain("1950-03-14");
		// 红线：不得出现"prefer/should/better"类策略词
		expect(lines[0]).not.toMatch(/prefer|should|better|choose/i);
	});

	it("未完成的线：如实说未观测到完成", () => {
		const lines = formatRouteFactsForInjection([
			{ from: 9, to: 17, decision: 3, completed: false, savedAt: 2 },
		]);
		expect(lines[0]).toContain("9->17");
		expect(lines[0]).toMatch(/no completion observed|not completed/i);
	});

	it("空事实 → 空数组（不注入占位符）", () => {
		expect(formatRouteFactsForInjection([])).toEqual([]);
	});
});
describe("C-1 门控：--no-memory 必须同时关闭 route facts（m3f 实测缺陷）", () => {
	it("enabled=false → 空 provider（控制臂不得被注入事实）", async () => {
		const { routeFactsProviderFor } = await import("../../src/evolution/route-facts.js");
		const dir = mkdtempSync(join(tmpdir(), "rf-"));
		const { RouteLedger: RL } = await import("../../src/agent/route-ledger.js");
		const ledger = new RL();
		ledger.record({ job: 100, fromTown: 9, toTown: 12, decision: 1, orderedAt: 1 });
		saveRouteFacts(dir, routeFactsFromLedger(ledger.all()));
		expect(routeFactsProviderFor(dir, false)()).toEqual([]); // 控制臂
		expect(routeFactsProviderFor(dir, true)().length).toBe(1); // 处理臂
	});
});
