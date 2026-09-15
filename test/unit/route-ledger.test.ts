import { describe, expect, it } from "vitest";
import { RouteLedger, jobFromPhase } from "../../src/agent/route-ledger.js";

describe("RouteLedger — 决策→结果账本（credit assignment 的缺失一环）", () => {
	// 反思此前只喂 outcome 汇总，写出的 lesson 是空洞的（SPEC §10.34）。
	// 账本把"哪个决策订了哪条线、后来 observed 到什么"接上。
	// 坐标/job 取自真实 GS ack（SPEC §10.33）。

	it("记录订购并关联决策号", () => {
		const l = new RouteLedger();
		l.record({ job: 101, fromTown: 9, toTown: 12, decision: 2, orderedAt: 1000 });
		expect(l.lines()).toEqual([
			"route job 101 (towns 9->12) was ordered at decision 2 but no completion was observed before the run ended",
		]);
	});

	it("markDone 后陈述变为 built + 日期", () => {
		const l = new RouteLedger();
		l.record({ job: 101, fromTown: 9, toTown: 12, decision: 2, orderedAt: 1000 });
		l.markDone(101, "1950-03-14");
		expect(l.lines()[0]).toMatch(/reported it built on 1950-03-14/);
	});

	it("未观测到完成的线必须如实说，不得默认成功", () => {
		// cal2 教训：静默丢弃/未完成如果被读成成功，credit assignment 从根上断
		const l = new RouteLedger();
		l.record({ job: 100, fromTown: 9, toTown: 1, decision: 1, orderedAt: 500 });
		expect(l.lines()[0]).toMatch(/no completion was observed/);
	});

	it("未知 job 的 markDone 被忽略（不伪造）", () => {
		const l = new RouteLedger();
		l.markDone(999);
		expect(l.lines()).toEqual([]);
	});

	it("按 job 升序输出（账本顺序稳定）", () => {
		const l = new RouteLedger();
		l.record({ job: 102, fromTown: 9, toTown: 17, decision: 3, orderedAt: 3000 });
		l.record({ job: 101, fromTown: 9, toTown: 12, decision: 2, orderedAt: 2000 });
		expect(l.lines().length).toBe(2);
		expect(l.lines()[0]).toContain("job 101");
	});

	it("jobFromPhase 解析执行器 done 串尾部的 j<job>", () => {
		expect(jobFromPhase("EX done stN2 r63 bus j100")).toBe(100);
		expect(jobFromPhase("EX dpt_conn j100")).toBe(100);
		expect(jobFromPhase("EX boot j-1")).toBe(-1);
		expect(jobFromPhase("EX hb road #28 s3")).toBeNull();
	});
});
