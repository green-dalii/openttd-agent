/**
 * Tests for the prebuilt scenario (S1/G4).
 *
 * Why: in the freeform episode the outcome is dominated by whether the executor
 * managed to finish a road inside the window - measured spreads of 0..527
 * delivered with the same fleet, and horizons that varied 0..449 game days. The
 * agent's actual management decisions (how many vehicles, when to extend) only
 * become measurable once a route EXISTS, which is exactly what S0 confirmed: the
 * fleet lever is real and steep between 3 and 15 vehicles.
 *
 * So the scenario builds a deterministic route BEFORE the measurement window
 * opens, waits until it is OPERABLE, and only then hands control to the agent.
 * The measurement then covers the management window only.
 */
import { describe, expect, it, vi } from "vitest";
import { isPrebuiltReady, runPrebuiltScenario } from "../../src/agent/prebuilt.js";

describe("prebuilt scenario readiness", () => {
	it("is not ready while the route cannot carry anything", () => {
		// Stations built but no vehicle: nothing moves yet.
		expect(isPrebuiltReady({ stations: 2, vehicles: 0 })).toBe(false);
		// A vehicle exists but the second station is missing: no route.
		expect(isPrebuiltReady({ stations: 1, vehicles: 1 })).toBe(false);
		expect(isPrebuiltReady({ stations: 0, vehicles: 0 })).toBe(false);
	});

	it("is ready once the route can move cargo", () => {
		expect(isPrebuiltReady({ stations: 2, vehicles: 1 })).toBe(true);
		expect(isPrebuiltReady({ stations: 2, vehicles: 3 })).toBe(true);
	});
});

describe("prebuilt scenario run", () => {
	const fake = (samples: { stations: number; vehicles: number }[], orderAck = true) => {
		let i = 0;
		return {
			sendOrder: vi.fn(() => orderAck),
			snapshot: vi.fn(() => samples[Math.min(i++, samples.length - 1)]!),
			sleep: vi.fn(async () => {}),
			now: vi.fn(() => 0),
			log: vi.fn(),
		};
	};

	it("sends the blueprint once and waits until the route is operable", async () => {
		const io = fake([
			{ stations: 0, vehicles: 0 },
			{ stations: 1, vehicles: 0 },
			{ stations: 2, vehicles: 0 },
			{ stations: 2, vehicles: 1 },
		]);
		const r = await runPrebuiltScenario(io, { timeoutMs: 10_000 });
		expect(io.sendOrder).toHaveBeenCalledTimes(1);
		expect(r.ready).toBe(true);
		expect(r.reason).toBe("ready");
		expect(r.waitedSamples).toBe(4);
	});

	it("reports a timeout instead of pretending the scenario is set up", async () => {
		// The route never becomes operable: this run must be flagged, never counted
		// as a measurement of management decisions.
		const io = fake([{ stations: 2, vehicles: 0 }]);
		io.now = vi.fn()
			.mockReturnValueOnce(0)
			.mockReturnValue(20_000);
		const r = await runPrebuiltScenario(io, { timeoutMs: 10_000 });
		expect(r.ready).toBe(false);
		expect(r.reason).toBe("timeout");
	});

	it("reports a refused order (no GS ack) rather than waiting forever", async () => {
		const io = fake([{ stations: 0, vehicles: 0 }], false);
		const r = await runPrebuiltScenario(io, { timeoutMs: 10_000 });
		expect(r.ready).toBe(false);
		expect(r.reason).toBe("order_refused");
		expect(r.waitedSamples).toBe(0);
	});
});
