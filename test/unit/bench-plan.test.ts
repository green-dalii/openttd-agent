/**
 * Unit tests — the benchmark matrix planner (D5a).
 *
 * 职责: 锁定"评测矩阵怎么被切成一格一局"的三条硬规则——
 *   ① 每格**独立 data dir**（记忆不能跨格污染，否则比的是记忆传播）；
 *   ② 世界必须**逐字相同**（同 seed / 同场景 / 同 horizon，否则不可比）；
 *   ③ 功效不足时**跑前拒绝**（P2-3 的预登记闸，不是事后解释）。
 * 事实来源: docs/SCAFFOLD-CONTRACT.md §3（分数卡与评测面）；Issue #9/#11。
 * 禁止: 在此读取文件系统或启动进程（纯规划）。
 */

import { describe, expect, it } from "vitest";
import { planMatrix } from "../../src/evolution/bench-plan.js";

const world = { scenario: "prebuilt" as const, horizonDays: 300, startYear: 1950, mapSize: [256, 256] as [number, number] };

describe("planMatrix（模型 × 任务 × seed × 重复）", () => {
	it("每个组合一局，且每局有自己的目录", () => {
		const plan = planMatrix({
			models: ["m-a", "m-b"],
			seeds: [11, 22],
			repeats: 2,
			world,
			root: "/tmp/bench",
		});
		expect(plan.cells).toHaveLength(2 * 2 * 2);
		const dirs = plan.cells.map((c) => c.dataDir);
		expect(new Set(dirs).size).toBe(dirs.length); // 无共享目录
		expect(dirs.every((d) => d.startsWith("/tmp/bench/"))).toBe(true);
	});

	it("目录名对模型/seed/重复可辨（可人工回看是哪一格）", () => {
		const plan = planMatrix({ models: ["gpt-x"], seeds: [7], repeats: 1, world, root: "/tmp/bench" });
		const dir = plan.cells[0]!.dataDir;
		expect(dir).toContain("gpt-x");
		expect(dir).toContain("7");
	});

	it("世界参数在每一格里逐字相同（否则比的不是模型）", () => {
		const plan = planMatrix({ models: ["a", "b"], seeds: [1], repeats: 3, world, root: "/tmp/b" });
		for (const c of plan.cells) {
			expect(c.world).toEqual(world);
		}
	});

	it("单元格带上重复序号（用于配对方差，不是用来平均掉）", () => {
		const plan = planMatrix({ models: ["a"], seeds: [5], repeats: 3, world, root: "/tmp/b" });
		expect(plan.cells.map((c) => c.repeat)).toEqual([1, 2, 3]);
	});

	it("给模型名去重并保序（重复输入不该跑两遍）", () => {
		const plan = planMatrix({ models: ["a", "b", "a"], seeds: [1], repeats: 1, world, root: "/tmp/b" });
		expect(plan.cells.map((c) => c.model)).toEqual(["a", "b"]);
	});

	it("没有模型 → 拒绝规划（宁可报错也不出一个空矩阵）", () => {
		expect(() => planMatrix({ models: [], seeds: [1], repeats: 1, world, root: "/tmp/b" })).toThrow(/model/i);
	});

	it("重复次数 < 1 → 拒绝（没有重复的评测测不出稳定性）", () => {
		expect(() => planMatrix({ models: ["a"], seeds: [1], repeats: 0, world, root: "/tmp/b" })).toThrow(/repeat/i);
	});
});

describe("planMatrix 的预登记闸（D5a × P2-3）", () => {
	it("样本量不足声明效应 → 跑前拒绝，并说明需要多少", () => {
		// 重复 1 次 × 1 seed = 1 局/模型；+20% 效应 @ CV 100% 需要 400。
		expect(() =>
			planMatrix({
				models: ["a", "b"],
				seeds: [1],
				repeats: 1,
				world,
				root: "/tmp/b",
				power: { effectSize: 0.2, cv: 1 },
			}),
		).toThrow(/400/);
	});

	it("样本量足够 → 放行", () => {
		const plan = planMatrix({
			models: ["a", "b"],
			seeds: Array.from({ length: 8 }, (_, i) => i + 1),
			repeats: 8,
			world,
			root: "/tmp/b",
			power: { effectSize: 0.5, cv: 1 }, // 需要 64/臂；8×8=64
		});
		expect(plan.cells).toHaveLength(128);
	});

	it("没给 power 声明 → 不拦（但计划里标明未预登记）", () => {
		const plan = planMatrix({ models: ["a"], seeds: [1], repeats: 1, world, root: "/tmp/b" });
		expect(plan.preRegistered).toBe(false);
	});
});
