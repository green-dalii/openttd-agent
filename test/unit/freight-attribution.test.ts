/**
 * 货运 F4 / A4：把「送到某产业的货」归到**我们的一条线**上。
 *
 * 背景（Issue #13 的最后一块）：
 *   - GS 的 cargo monitor 只知道"本公司往某个产业送了 N 吨"（`GetIndustryDeliveryAmount`），
 *     **它不知道是哪条线送的**（引擎没有这个粒度，见 `docs/PER-LINE-DELIVERY-FEASIBILITY.md` §4.1）。
 *   - 但**我们知道**每条货运线服务哪个产业（GS 现在报了线路两端的产业 id，A3）⇒
 *     归因可以由**我们自己**推导，规则必须写死并可被质疑（§4.2）。
 *
 * 归因规则（唯一的口径）：
 *   - 某个 **(货种, 收方产业)** 只被**我们的一条**线服务 ⇒ 那批货归这条线；
 *   - 被**多条**线服务 ⇒ **不可分摊** ⇒ 记 `null` + 说明（不许按比例猜）；
 *   - **我们没有线**服务它 ⇒ 归不了（那不是我们任何一条线的成果）。
 *
 * 铁律：
 *   - 归因值是**推导值**，不是引擎读数 ⇒ 报告/页面必须标明它是推导的；
 *   - **0 交付 ≠ 没有归因**：0 是真的读数（这条线一吨也没送）；
 *   - 不可分摊 ≠ 0（那是"分不出来"，不是"分到 0"）。
 *
 * 事实来源: `docs/PER-LINE-DELIVERY-FEASIBILITY.md` §4.2；SPEC §10.126。
 */

import { describe, expect, it } from "vitest";
import { attributeFreightDeliveries } from "../../src/agent/freight-attribution.js";
import type { FreightLine, FreightDeliveryReading } from "../../src/agent/freight-attribution.js";

/** 一条货运线：货种 + 两端产业（产方 / 收方）。 */
function line(job: number, cargo: string, from: number, to: number): FreightLine {
	return { job, cargo, fromIndustry: from, toIndustry: to };
}

describe("归因：唯一服务该 (货种, 产业) 的线 ⇒ 货归它", () => {
	it("一条线服务该收方 ⇒ 全部归它", () => {
		const readings: FreightDeliveryReading[] = [{ label: "COAL", industry: 53, amount: 120 }];
		const out = attributeFreightDeliveries(readings, [line(1000, "COAL", 28, 53)]);
		expect(out.routes).toHaveLength(1);
		expect(out.routes[0]!.job).toBe(1000);
		expect(out.routes[0]!.cargo).toBe("COAL");
		expect(out.routes[0]!.amount).toBe(120);
		expect(out.routes[0]!.reason).toBeNull();
		expect(out.unattributed).toEqual([]);
	});

	it("多条线服务**不同**的收方 ⇒ 各自归各自", () => {
		const readings: FreightDeliveryReading[] = [
			{ label: "COAL", industry: 53, amount: 120 },
			{ label: "COAL", industry: 71, amount: 40 },
		];
		const out = attributeFreightDeliveries(readings, [
			line(1000, "COAL", 28, 53),
			line(1001, "COAL", 30, 71),
		]);
		expect(out.routes.map((o) => [o.job, o.amount])).toEqual([
			[1000, 120],
			[1001, 40],
		]);
		expect(out.unattributed).toEqual([]);
	});

	it("不同货种去同一个收方 ⇒ 按货种分开归（货种是区分依据）", () => {
		const readings: FreightDeliveryReading[] = [
			{ label: "COAL", industry: 53, amount: 120 },
			{ label: "GRAIN", industry: 53, amount: 30 },
		];
		const out = attributeFreightDeliveries(readings, [
			line(1000, "COAL", 28, 53),
			line(1001, "GRAIN", 40, 53),
		]);
		expect(out.routes.map((o) => [o.job, o.cargo, o.amount])).toEqual([
			[1000, "COAL", 120],
			[1001, "GRAIN", 30],
		]);
	});
});

describe("归因：分不出来就说分不出来（不许猜）", () => {
	it("多条线服务**同一个 (货种, 产业)** ⇒ 不可分摊（null + 说明）", () => {
		const readings: FreightDeliveryReading[] = [{ label: "COAL", industry: 53, amount: 120 }];
		const out = attributeFreightDeliveries(readings, [
			line(1000, "COAL", 28, 53),
			line(1001, "COAL", 30, 53),
		]);
		expect(out.routes).toHaveLength(2);
		for (const o of out.routes) {
			expect(o.amount).toBeNull();
			expect(o.reason).toMatch(/2/);
		}
		// 共用 ⇒ 那批货**不能**被任何一条线领走（否则就是编）。
		expect(out.unattributed).toHaveLength(1);
		expect(out.unattributed[0]!.amount).toBe(120);
		expect(out.unattributed[0]!.industry).toBe(53);
	});

	it("我们没有线服务它 ⇒ 不归给任何线（但要报告出来）", () => {
		const readings: FreightDeliveryReading[] = [{ label: "COAL", industry: 99, amount: 70 }];
		const out = attributeFreightDeliveries(readings, [line(1000, "COAL", 28, 53)]);
		// 我们这条线（服务产业 53）确实没送货 ⇒ 0（真的读数）。
		expect(out.routes).toHaveLength(1);
		expect(out.routes[0]!.amount).toBe(0);
		// 那 70 吨送到了**我们没有线服务**的产业 99 ⇒ 归不了任何线，
		// 但**不许静默丢掉**（否则归因总和看起来像公司总量）。
		expect(out.unattributed).toHaveLength(1);
		expect(out.unattributed[0]!.amount).toBe(70);
		expect(out.unattributed[0]!.industry).toBe(99);
		expect(out.unattributed[0]!.reason).toMatch(/no route of ours/i);
	});
});

describe("归因：读数缺失与 0 交付不是一回事", () => {
	it("没有逐产业读数 ⇒ 没有归因结果（不是「每条线都是 0」）", () => {
		const out = attributeFreightDeliveries([], [line(1000, "COAL", 28, 53)]);
		expect(out.routes).toEqual([]);
		expect(out.unattributed).toEqual([]);
	});

	it("一条线一吨也没送 ⇒ 归因值是 0（真的读数），不是 null", () => {
		// 有读数，但这条线服务的收方没有增量 ⇒ 它确实没送。
		const readings: FreightDeliveryReading[] = [{ label: "COAL", industry: 71, amount: 40 }];
		const out = attributeFreightDeliveries(readings, [
			line(1000, "COAL", 28, 53),
			line(1001, "COAL", 30, 71),
		]);
		const ours = out.routes.find((o) => o.job === 1000);
		expect(ours?.amount).toBe(0);
		expect(ours?.reason).toBeNull();
	});

	it("只有客运线（没有两端产业 id）⇒ 不参与归因", () => {
		const readings: FreightDeliveryReading[] = [{ label: "COAL", industry: 53, amount: 120 }];
		const out = attributeFreightDeliveries(readings, [{ job: 900, cargo: "PASS" }]);
		expect(out.routes).toHaveLength(1);
		expect(out.routes[0]!.amount).toBeNull();
		expect(out.routes[0]!.reason).toMatch(/not a freight line/i);
	});
});

describe("归因：口径写在结果里（它是推导值，不是引擎读数）", () => {
	it("每条结果都带着口径说明", () => {
		const readings: FreightDeliveryReading[] = [{ label: "COAL", industry: 53, amount: 120 }];
		const out = attributeFreightDeliveries(readings, [line(1000, "COAL", 28, 53)]);
		expect(out.routes[0]!.derived).toBe(true);
		expect(out.routes[0]!.basis).toMatch(/unique/i);
	});

	it("不可分摊的那条也给出口径说明", () => {
		const readings: FreightDeliveryReading[] = [{ label: "COAL", industry: 53, amount: 120 }];
		const out = attributeFreightDeliveries(readings, [
			line(1000, "COAL", 28, 53),
			line(1001, "COAL", 30, 53),
		]);
		expect(out.routes[0]!.basis).toMatch(/shared/i);
	});
});
