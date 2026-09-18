/**
 * Tests for the delivery meter: the cumulative cargo counter that survives
 * OpenTTD's quarterly reset of `deliveredCargo`.
 *
 * The fixture VALUES are synthetic (this is pure arithmetic, not a protocol
 * fixture), but the BEHAVIOUR is taken from the real wire field: SPEC 10.65
 * records that `ServerCompanyEconomy.deliveredCargo` is `cur_economy`'s
 * per-quarter counter (u16, resets to 0 every ~90 game days), which is why a
 * run that happened to end just after a reset reported 0 deliveries.
 */
import { describe, expect, it } from "vitest";
import { createDeliveryMeter } from "../../src/game/delivery-meter.js";

describe("delivery meter", () => {
	it("accumulates within a single quarter without inventing deliveries", () => {
		const m = createDeliveryMeter();
		m.observe(0, 0);
		m.observe(10, 5);
		m.observe(20, 9);
		expect(m.total()).toBe(9);
		expect(m.stats().quarterChanges).toBe(0);
	});

	it("carries the quarter's total across a reset instead of losing it", () => {
		const m = createDeliveryMeter();
		m.observe(80, 30);
		m.observe(89, 40); // last reading of the quarter
		m.observe(90, 0); // reset: new quarter
		m.observe(91, 3);
		expect(m.total()).toBe(43); // 40 (finished quarter) + 3 (current)
		expect(m.stats().quarterChanges).toBe(1);
	});

	it("sums every completed quarter in a long run", () => {
		const m = createDeliveryMeter();
		m.observe(0, 0);
		m.observe(89, 50);
		m.observe(90, 0);
		m.observe(179, 60);
		m.observe(180, 0);
		m.observe(200, 7);
		expect(m.total()).toBe(117); // 50 + 60 + 7
		expect(m.stats().quarterChanges).toBe(2);
	});

	it("reports a sampling gap as incomplete instead of silently undercounting", () => {
		const m = createDeliveryMeter();
		m.observe(0, 0);
		m.observe(300, 20); // three quarters passed unseen
		expect(m.total()).toBe(20);
		expect(m.stats().gaps).toBe(1);
		expect(m.stats().complete).toBe(false);
	});

	it("ignores missing readings and counts them", () => {
		const m = createDeliveryMeter();
		m.observe(0, 0);
		m.observe(5, null);
		m.observe(10, undefined);
		m.observe(15, 4);
		expect(m.total()).toBe(4);
		expect(m.stats().missing).toBe(2);
		expect(m.stats().complete).toBe(true);
	});

	it("takes the maximum within a quarter (never double counts a replayed reading)", () => {
		const m = createDeliveryMeter();
		m.observe(10, 20);
		m.observe(11, 20); // same value re-delivered by a poll
		m.observe(12, 25);
		expect(m.total()).toBe(25);
		expect(m.stats().quarterChanges).toBe(0);
	});

	it("treats a value drop inside one quarter as a resync, not as new cargo", () => {
		const m = createDeliveryMeter();
		m.observe(10, 20);
		m.observe(10, 2); // same date, smaller value: the counter restarted
		expect(m.total()).toBe(22);
		expect(m.stats().resyncs).toBe(1);
	});

	it("returns null total before any usable reading (missing stays missing)", () => {
		const m = createDeliveryMeter();
		expect(m.total()).toBeNull();
		m.observe(0, null);
		expect(m.total()).toBeNull();
		expect(m.stats().complete).toBe(false);
	});
});
