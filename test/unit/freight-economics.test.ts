/**
 * 货运线路经济学的**方向**（Issue #105）。
 *
 * 这些数字都是估计 ⇒ 方向（upper/lower）比数值本身更重要：
 *   - 收入是**上界**（满载 + 最快在途）；
 *   - 成本是**下界**（车龄、利息、站与车库都没算）。
 * 方向错了，模型就会按错的数做决定 ⇒ 单测锁住方向，而不是锁住某个具体金额。
 *
 * 运价来自**真机探针**（`GSCargo.GetCargoIncome`）⇒ fixture 是真实读数，
 * 不是手写臆想的数（AGENTS §5）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	DAYS_PER_ECONOMY_YEAR,
	estimateFreightEconomics,
	transitDaysFor,
	type EngineEconomics,
} from "../../src/agent/estimate.js";

interface IncomeReading {
	/** 直线（曼哈顿）格数 */
	distance: number;
	/** 在途天数 */
	days: number;
	/** 引擎为每单位货付的运价（Money） */
	income: number;
}

interface IncomeFixture {
	cargo: string;
	readings: IncomeReading[];
}

/** 真机探针的读数（Issue #105，SPEC §10.127）。 */
const FIXTURE = JSON.parse(
	readFileSync(new URL("../fixtures/freight-income.json", import.meta.url), "utf8"),
) as IncomeFixture;

const SHORT = FIXTURE.readings.find((r) => r.distance === 100);
const LONG = FIXTURE.readings.find((r) => r.distance === 200);

/** 一个"小车"和一个"大车"：大车在**每一项**上都更贵（载量、价格、运行成本）。 */
const SMALL: EngineEconomics = {
	id: 1,
	name: "Small Truck",
	speed: 60,
	capacity: 15,
	price: 10_000,
	runningCostPerYear: 1_000,
	cargo: "COAL",
};

const BIG: EngineEconomics = {
	id: 2,
	name: "Big Truck",
	speed: 80,
	capacity: 30,
	price: 30_000,
	runningCostPerYear: 3_000,
	cargo: "COAL",
};

function estimate(incomePerUnit: number, distanceTiles: number, engines = [SMALL, BIG]) {
	return estimateFreightEconomics({
		cargo: "COAL",
		distanceTiles,
		incomePerUnit,
		engines,
		roadCostLowerBound: distanceTiles * 307,
	});
}

describe("货运经济学：方向标签", () => {
	it("每个数字都带机器可读的方向", () => {
		const est = estimate(45, 120);
		expect(est.bounds.revenue).toBe("upper");
		expect(est.bounds.operatingCost).toBe("lower");
		expect(est.bounds.capex).toBe("lower");
		expect(est.bounds.incomePerUnit).toBe("upper");
	});

	it("notes 说清收入是上界、成本是下界，且工具不下结论", () => {
		const notes = estimate(45, 120).notes.join(" ");
		expect(notes).toMatch(/UPPER bound/);
		expect(notes).toMatch(/LOWER bound/);
		expect(notes).toMatch(/does not say whether the line pays off/);
	});
});

describe("验收：更长的距离不会降低收入估计", () => {
	it("引擎的运价与距离成正比（真机读数）", () => {
		expect(SHORT).toBeDefined();
		expect(LONG).toBeDefined();
		expect(LONG!.income).toBeGreaterThan(SHORT!.income);
	});

	it("距离更长 ⇒ 收入估计不降", () => {
		const short = estimate(SHORT!.income, SHORT!.distance);
		const long = estimate(LONG!.income, LONG!.distance);
		for (const a of short.engines) {
			const b = long.engines.find((e) => e.id === a.id)!;
			expect(b.revenuePerTripUpperBound).toBeGreaterThanOrEqual(a.revenuePerTripUpperBound);
			expect(b.revenuePerDayUpperBound).toBeGreaterThanOrEqual(a.revenuePerDayUpperBound);
		}
	});
});

describe("验收：更大的车型不会降低成本估计", () => {
	it("更大的车（每一项都更贵）⇒ 造价下界与运行成本下界都不降", () => {
		const est = estimate(45, 120);
		const small = est.engines.find((e) => e.id === SMALL.id)!;
		const big = est.engines.find((e) => e.id === BIG.id)!;
		expect(big.capexLowerBound).toBeGreaterThan(small.capexLowerBound);
		expect(big.operatingCostPerDayLowerBound).toBeGreaterThan(
			small.operatingCostPerDayLowerBound,
		);
	});

	it("造价下界 = 路 + 车（站与车库另算 ⇒ 仍是下界）", () => {
		const est = estimate(45, 120);
		const small = est.engines.find((e) => e.id === SMALL.id)!;
		expect(small.capexLowerBound).toBe(120 * 307 + SMALL.price);
	});
});

describe("收入 = 载量 × 每单位运价（满载 ⇒ 上界）", () => {
	it("一趟的收入 = 载量 × 每单位运价", () => {
		const est = estimate(45, 120);
		const small = est.engines.find((e) => e.id === SMALL.id)!;
		expect(small.revenuePerTripUpperBound).toBe(SMALL.capacity * 45);
	});

	it("每天的趟数 = 1 / (2 × 单程在途天数)（不含装卸与等待 ⇒ 上界）", () => {
		const est = estimate(45, 120);
		const small = est.engines.find((e) => e.id === SMALL.id)!;
		expect(small.tripsPerDay).toBeCloseTo(1 / (2 * small.transitDays));
	});
});

describe("在途天数：速度 → 每天走过的格数（SPEC §10.127 的推导）", () => {
	it("格/天 = 速度 × 0.43359375", () => {
		// 80 km-ish/h ⇒ 34.6875 格/天 ⇒ 120 格要 4 天。
		expect(transitDaysFor(120, 80)).toBe(4);
		expect(transitDaysFor(34, 80)).toBe(1);
		expect(transitDaysFor(35, 80)).toBe(2);
		expect(transitDaysFor(0, 80)).toBe(1);
	});

	it("速度未知 ⇒ null，不编一个数", () => {
		expect(transitDaysFor(120, 0)).toBeNull();
		expect(transitDaysFor(120, Number.NaN)).toBeNull();
	});
});

describe("运行成本：引擎按经济年给出 ⇒ 除以 365", () => {
	it("每天的运行成本 = 年成本 / 365（下界）", () => {
		const est = estimate(45, 120);
		const small = est.engines.find((e) => e.id === SMALL.id)!;
		expect(small.operatingCostPerDayLowerBound).toBeCloseTo(
			SMALL.runningCostPerYear / DAYS_PER_ECONOMY_YEAR,
		);
	});
});
