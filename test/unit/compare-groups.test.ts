/**
 * Compare 分组（Issue #13 的决定 (b)：旧矩阵单独成组，只做组内比较）。
 *
 * 职责: 守住"**同一次比较 = 同一个问题**"这条规则。两局如果脚手架不同、观测面结构
 *   不同、或者 GS 暴露的世界切片不同，它们**不是同一个问题** ⇒ 不该混在一张表里
 *   比数字。分组的键必须来自 **manifest 记录的字段**（不是页面临时拼的）。
 * 事实来源: SPEC §10.121；docs/DASHBOARD-API.md §3.9。
 */

import { describe, expect, it } from "vitest";
import { buildCompareView } from "../../src/evolution/compare-view.js";
import type { GameMetric } from "../../src/evolution/metrics.js";

/** A metric row with the manifest fields the grouping reads. */
function row(over: Partial<GameMetric> = {}): GameMetric {
	return {
		id: "s1",
		llmModel: "model-a",
		seed: 1,
		status: "completed",
		deliveredRun: 100,
		simulatedDays: 100,
		totalTokens: 1000,
		startedAt: 1000,
		manifest: {
			servedModel: "model-a",
			backend: "harness",
			scaffoldHash: "scaf-1",
			observationShapeHash: "obs-1",
			observationPolicy: "towns=all;industries=top12",
		},
		...over,
	} as unknown as GameMetric;
}

describe("Compare 的问题分组", () => {
	it("同一问题的局在一组，不同脚手架分属不同组", () => {
		const rows = [
			row({ id: "a1" }),
			row({ id: "a2", seed: 2 }),
			row({
				id: "b1",
				manifest: {
					servedModel: "model-a",
					backend: "harness",
					scaffoldHash: "scaf-2",
					observationShapeHash: "obs-1",
					observationPolicy: "towns=all;industries=top12",
				} as GameMetric["manifest"],
			}),
		];
		const payload = buildCompareView(rows, {});
		expect(payload.groups).toHaveLength(2);
		const sizes = payload.groups.map((g) => g.runs).sort((a, b) => b - a);
		expect(sizes).toEqual([2, 1]);
		// 每个组都要说清自己是什么问题（指纹原样，不做解释）。
		const scaffolds = payload.groups.map((g) => g.scaffoldHash).sort();
		expect(scaffolds).toEqual(["scaf-1", "scaf-2"]);
	});

	it("默认选**局数最多**的那一组（用户决定：旧矩阵单独成组）", () => {
		const rows = [
			row({ id: "new1" }),
			row({
				id: "old1",
				manifest: { servedModel: "model-a", backend: "harness", scaffoldHash: "scaf-old" } as GameMetric["manifest"],
			}),
			row({
				id: "old2",
				seed: 2,
				manifest: { servedModel: "model-a", backend: "harness", scaffoldHash: "scaf-old" } as GameMetric["manifest"],
			}),
		];
		const payload = buildCompareView(rows, {});
		const selected = payload.groups.find((g) => g.id === payload.selectedGroupId);
		expect(selected?.scaffoldHash).toBe("scaf-old");
		// 数字只来自选中的那一组。
		expect(payload.runs.every((r) => r.id.startsWith("old"))).toBe(true);
		// 另一组的局数必须被披露（不能静默消失）。
		expect(payload.runsOutsideGroup).toBe(1);
	});

	it("可以点名选一组", () => {
		const rows = [
			row({ id: "new1" }),
			row({
				id: "old1",
				manifest: { servedModel: "model-a", backend: "harness", scaffoldHash: "scaf-old" } as GameMetric["manifest"],
			}),
		];
		const groups = buildCompareView(rows, {}).groups;
		const old = groups.find((g) => g.scaffoldHash === "scaf-old");
		expect(old).toBeTruthy();
		const payload = buildCompareView(rows, { group: old!.id });
		expect(payload.selectedGroupId).toBe(old!.id);
		expect(payload.runs.map((r) => r.id)).toEqual(["old1"]);
		expect(payload.runsOutsideGroup).toBe(1);
	});

	it("分组键来自 manifest：没记录的字段就是 null（不是空串、不是猜测）", () => {
		const rows = [row({ id: "x1", manifest: { servedModel: "model-a" } as GameMetric["manifest"] })];
		const payload = buildCompareView(rows, {});
		expect(payload.groups).toHaveLength(1);
		expect(payload.groups[0]!.scaffoldHash).toBeNull();
		expect(payload.groups[0]!.observationShapeHash).toBeNull();
		expect(payload.groups[0]!.observationPolicy).toBeNull();
	});

	it("观测面结构或切片不同 ⇒ 也是不同的问题", () => {
		const rows = [
			row({ id: "a1" }),
			row({
				id: "a2",
				manifest: {
					servedModel: "model-a",
					backend: "harness",
					scaffoldHash: "scaf-1",
					observationShapeHash: "obs-2",
					observationPolicy: "towns=all;industries=top12",
				} as GameMetric["manifest"],
			}),
			row({
				id: "a3",
				manifest: {
					servedModel: "model-a",
					backend: "harness",
					scaffoldHash: "scaf-1",
					observationShapeHash: "obs-1",
					observationPolicy: "towns=top10;industries=top12",
				} as GameMetric["manifest"],
			}),
		];
		expect(buildCompareView(rows, {}).groups).toHaveLength(3);
	});

	it("没有局时：空组、无选中组（页面必须显示空态，而不是假装有比较）", () => {
		const payload = buildCompareView([], {});
		expect(payload.groups).toEqual([]);
		expect(payload.selectedGroupId).toBeNull();
		expect(payload.runsOutsideGroup).toBe(0);
		expect(payload.models).toEqual([]);
	});

	it("点名了不存在的组 ⇒ 落回默认组（不报错、不空白）", () => {
		const rows = [row({ id: "a1" })];
		const payload = buildCompareView(rows, { group: "nope" });
		expect(payload.selectedGroupId).toBeTruthy();
		expect(payload.runs).toHaveLength(1);
	});
});
