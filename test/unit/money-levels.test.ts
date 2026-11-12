import { describe, expect, it } from "vitest";
import { compareMoneyLevels, moneyLevels } from "../../src/util/money-levels.js";

describe("资金档位（确定性探针的判据）", () => {
	it("只在钱变了时追加（钱只在施工事件那一刻变）", () => {
		const levels = moneyLevels([
			{ day: 10, money: 100000 },
			{ day: 10, money: 100000 },
			{ day: 11, money: 98000 },
			{ day: 11, money: 98000 },
			{ day: 12, money: 98000 },
			{ day: 12, money: 97000 },
		]);
		expect(levels).toEqual([100000, 98000, 97000]);
	});

	it("两局档位集合相同 ⇒ same（与顺序无关）", () => {
		const cmp = compareMoneyLevels([100000, 98000, 97000], [100000, 97000, 98000]);
		expect(cmp.same).toBe(true);
		expect(cmp.sequenceSame).toBe(false);
		expect(cmp.onlyInA).toEqual([]);
		expect(cmp.onlyInB).toEqual([]);
	});

	it("档位集合不同 ⇒ same=false 且两边差异都列出来", () => {
		const cmp = compareMoneyLevels([100000, 98000], [100000, 97000]);
		expect(cmp.same).toBe(false);
		expect(cmp.onlyInA).toEqual([98000]);
		expect(cmp.onlyInB).toEqual([97000]);
	});

	it("顺序逐项相同 ⇒ sequenceSame（比集合更严）", () => {
		const cmp = compareMoneyLevels([100000, 98000, 97000], [100000, 98000, 97000]);
		expect(cmp.same).toBe(true);
		expect(cmp.sequenceSame).toBe(true);
		expect(cmp.firstSequenceDiff).toBeNull();
	});

	it("顺序第一个不同的位置被指出", () => {
		const cmp = compareMoneyLevels([100000, 98000, 97000], [100000, 97000, 98000]);
		expect(cmp.firstSequenceDiff).toEqual({ index: 1, a: 98000, b: 97000 });
	});

	it("没有变化 ⇒ 比较**没有鉴别力**（只有一档钱 ⇒ 任何两局都『相同』）", () => {
		// 空洞的真：一局里施工根本没花钱 ⇒ 两局的"档位集合"必然相同，
		// 但这不能证明"可复现" ⇒ 必须能说"没测到"。
		const cmp = compareMoneyLevels([100000], [100000]);
		expect(cmp.measured).toBe(true);
		expect(cmp.same).toBe(true);
		expect(cmp.powerful).toBe(false);
	});

	it("两局都发生过变化 ⇒ 比较有鉴别力", () => {
		const cmp = compareMoneyLevels([100000, 99000], [100000, 99000]);
		expect(cmp.powerful).toBe(true);
	});

	it("只有一局发生过变化 ⇒ 没有鉴别力（不能拿它比）", () => {
		const cmp = compareMoneyLevels([100000, 99000], [100000]);
		expect(cmp.measured).toBe(true);
		expect(cmp.powerful).toBe(false);
	});

	it("没测到 ≠ 相同（两局都没读到钱 ⇒ measured=false）", () => {
		// 空集合的"相同"是空洞的真 ⇒ 必须能说"没测到"。
		const cmp = compareMoneyLevels([], []);
		expect(cmp.measured).toBe(false);
		expect(cmp.same).toBe(true); // 集合确实相同
	});

	it("只有一局测到 ⇒ measured=false（不能拿半边比）", () => {
		const cmp = compareMoneyLevels([100000], []);
		expect(cmp.measured).toBe(false);
	});

	it("长度不同 ⇒ sequenceSame=false（集合相同也不等于顺序相同）", () => {
		const cmp = compareMoneyLevels([100000, 98000], [100000, 98000, 98000]);
		expect(cmp.same).toBe(true);
		expect(cmp.sequenceSame).toBe(false);
	});

	it("非有限读数被跳过（不当作 0）", () => {
		const levels = moneyLevels([
			{ day: 10, money: Number.NaN },
			{ day: 10, money: 100000 },
		]);
		expect(levels).toEqual([100000]);
	});
});
