/**
 * Tests for the delivery meter: the cumulative cargo counter that survives
 * OpenTTD's quarterly reset of `deliveredCargo`.
 *
 * The fixture VALUES are synthetic (this is pure arithmetic, not a protocol
 * fixture), but the BEHAVIOUR is taken from the real wire field: SPEC 10.65
 * records that `ServerCompanyEconomy.deliveredCargo` is `cur_economy`'s
 * per-quarter counter (u16, resets to 0 every ~90 game days), which is why a
 * run that happened to end just after a reset reported 0 deliveries.
 *
 * The meter is fed a **quarter index** (the engine's calendar quarters, see
 * `src/game/calendar.ts`), not a day count: a calendar quarter is 90-92 days,
 * so only the boundary is certain. The index in these tests is arbitrary -
 * what matters is that it grows by one when a quarter passed.
 */
import { describe, expect, it } from "vitest";
import { createDeliveryMeter } from "../../src/game/delivery-meter.js";
import { quarterIndex, ymdToRaw } from "../../src/game/calendar.js";

describe("delivery meter", () => {
	it("accumulates within a single quarter without inventing deliveries", () => {
		const m = createDeliveryMeter();
		m.observe(0, 0);
		m.observe(0, 5);
		m.observe(0, 9);
		expect(m.total()).toBe(9);
		expect(m.stats().quarterChanges).toBe(0);
	});

	it("carries the quarter's total across a reset instead of losing it", () => {
		const m = createDeliveryMeter();
		m.observe(0, 30);
		m.observe(0, 40); // last reading of the quarter
		m.observe(1, 0); // reset: new quarter
		m.observe(1, 3);
		expect(m.total()).toBe(43); // 40 (finished quarter) + 3 (current)
		expect(m.stats().quarterChanges).toBe(1);
	});

	it("sums every completed quarter in a long run", () => {
		const m = createDeliveryMeter();
		m.observe(0, 0);
		m.observe(0, 50);
		m.observe(1, 0);
		m.observe(1, 60);
		m.observe(2, 0);
		m.observe(2, 7);
		expect(m.total()).toBe(117); // 50 + 60 + 7
		expect(m.stats().quarterChanges).toBe(2);
	});

	it("reports a sampling gap as incomplete instead of silently undercounting", () => {
		const m = createDeliveryMeter();
		m.observe(0, 0);
		m.observe(3, 20); // three quarters passed unseen
		expect(m.total()).toBe(20);
		expect(m.stats().gaps).toBe(1);
		expect(m.stats().complete).toBe(false);
	});

	it("ignores missing readings and counts them", () => {
		const m = createDeliveryMeter();
		m.observe(0, 0);
		m.observe(0, null);
		m.observe(0, undefined);
		m.observe(0, 4);
		expect(m.total()).toBe(4);
		expect(m.stats().missing).toBe(2);
		expect(m.stats().complete).toBe(true);
	});

	it("takes the maximum within a quarter (never double counts a replayed reading)", () => {
		const m = createDeliveryMeter();
		m.observe(1, 20);
		m.observe(1, 20); // same value re-delivered by a poll
		m.observe(1, 25);
		expect(m.total()).toBe(25);
		expect(m.stats().quarterChanges).toBe(0);
	});

	it("treats a value drop inside one quarter as a resync, not as new cargo", () => {
		const m = createDeliveryMeter();
		m.observe(1, 20);
		m.observe(1, 2); // same quarter, smaller value: the counter restarted
		expect(m.total()).toBe(22);
		expect(m.stats().resyncs).toBe(1);
	});

	it("the quarter index comes from the engine calendar (1/4/7/10 月 1 日为界)", () => {
		const q1 = quarterIndex(ymdToRaw(1950, 1, 1));
		expect(quarterIndex(ymdToRaw(1950, 4, 1))).toBe(q1 + 1);
		expect(quarterIndex(ymdToRaw(1950, 12, 31))).toBe(q1 + 3);
		expect(quarterIndex(ymdToRaw(1951, 1, 1))).toBe(q1 + 4);
	});

	it("returns null total before any usable reading (missing stays missing)", () => {
		const m = createDeliveryMeter();
		expect(m.total()).toBeNull();
		m.observe(0, null);
		expect(m.total()).toBeNull();
		expect(m.stats().complete).toBe(false);
	});
});
