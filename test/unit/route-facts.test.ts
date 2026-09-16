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

/**
 * N2-3（SPEC §10.53 后续）：事实必须带**结果**，否则记忆只能记住"做没做"，
 * 记不住"值不值"——三轮 A/B 的结论正是"记忆记住了过程，没记住结果"。
 */
describe("routeFactsFromLedger —— 经济事实（N2-3）", () => {
	const line = (job: number, from: number, to: number) => ({
		order: { job, fromTown: from, toTown: to, decision: 1, orderedAt: 1000 },
		outcome: { completed: true, doneDate: "1950-03-14" },
	});
	const stats = (job: number, vehicles: number, profit: number, waiting: number, gameDate = 400) =>
		[new Map([[job, { job, vehicles, profit, waiting, gameDate }]])][0];

	it("按 job 关联：事实带上车辆数/等待/利润（原始数字，不是散文）", () => {
		const facts = routeFactsFromLedger([line(1, 9, 12)], stats(1, 6, -308, 146));
		expect(facts[0]).toMatchObject({ from: 9, to: 12, vehicles: 6, waiting: 146, profit: -308 });
	});

	it("没有该 job 的读数：事实照记，只是没有经济字段（不丢事实）", () => {
		const facts = routeFactsFromLedger([line(7, 9, 12)], stats(1, 6, -308, 146));
		expect(facts[0]).toMatchObject({ from: 9, to: 12, completed: true });
		expect(facts[0]!.vehicles).toBeUndefined();
	});

	it("不给 stats（旧调用方）：行为与 C-1 完全一致（向后兼容）", () => {
		const facts = routeFactsFromLedger([line(1, 9, 12)]);
		expect(facts[0]).toMatchObject({ from: 9, to: 12, completed: true });
	});

	it("幂等键含经济：同样的线但读数不同 → 新的一行（新观测不许被旧观测吞掉）", () => {
		const dir = mkdtempSync(join(tmpdir(), "route-facts-econ-"));
		const a = routeFactsFromLedger([line(1, 9, 12)], stats(1, 6, -308, 146));
		const b = routeFactsFromLedger([line(1, 9, 12)], stats(1, 6, 5000, 0));
		saveRouteFacts(dir, a);
		saveRouteFacts(dir, b);
		saveRouteFacts(dir, b); // 同观测重复保存 → 去重
		const loaded = loadRouteFacts(dir);
		expect(loaded).toHaveLength(2);
		expect(loaded.map((f) => f.profit).sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual([-308, 5000]);
	});

	it("注入文本含经济事实，且仍无任何建议词", () => {
		const facts = routeFactsFromLedger([line(1, 9, 12)], stats(1, 6, -308, 146));
		const text = formatRouteFactsForInjection([{ ...facts[0]!, savedAt: 1 }]).join(" ");
		expect(text).toMatch(/6 vehicles/);
		expect(text).toMatch(/146 passengers waiting/);
		expect(text).toMatch(/-308|308/);
		const low = text.toLowerCase();
		for (const w of ["should", "recommend", "better", "prefer", "avoid", "optimal", "instead"]) {
			expect(low).not.toContain(w);
		}
	});
});
