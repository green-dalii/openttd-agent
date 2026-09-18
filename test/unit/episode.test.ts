/**
 * Tests for the episode clock: the episode is measured in SIMULATED days, not
 * wall-clock seconds.
 *
 * Evidence behind this (SPEC §10.68): six runs with an identical
 * `--demo-seconds 900` simulated 449, 445, 273, 445, 0 and 448 game days. The
 * wall clock only decides how long we are willing to wait; how much WORLD
 * happened is decided by the machine, by the agent's own `set_pause` calls and
 * by any freeze mechanism. Averaging those runs averages different-length
 * worlds, and the 0-day run was recorded as `deliveredRun=0` - a stalled world
 * that looks exactly like a bad result.
 */
import { describe, expect, it } from "vitest";
import { createEpisode } from "../../src/agent/episode.js";

const base = { startGameDay: 712240, startedAtMs: 1_000_000 };

describe("episode clock", () => {
	it("never stops when neither a horizon nor a cap is set", () => {
		const ep = createEpisode(base);
		const st = ep.check({ gameDay: 999_999, nowMs: base.startedAtMs + 86_400_000 });
		expect(st.stopReason).toBeNull();
		expect(st.simulatedDays).toBe(999_999 - base.startGameDay);
		expect(st.daysRemaining).toBeNull();
	});

	it("stops on the simulated horizon, not on wall clock", () => {
		const ep = createEpisode({ ...base, horizonDays: 100, capMs: 7_200_000 });
		// Two simulated days in, an hour of wall clock has passed: the cap is not
		// the measurement, so the episode must NOT be over yet.
		const early = ep.check({ gameDay: base.startGameDay + 2, nowMs: base.startedAtMs + 3_600_000 });
		expect(early.stopReason).toBeNull();
		expect(early.daysRemaining).toBe(98);

		const at = ep.check({ gameDay: base.startGameDay + 100, nowMs: base.startedAtMs + 5_000 });
		expect(at.stopReason).toBe("horizon");
		expect(at.simulatedDays).toBe(100);
		expect(at.daysRemaining).toBe(0);
		expect(at.reachedHorizon).toBe(true);
	});

	it("fires the wall-clock safety cap and reports the horizon as NOT reached", () => {
		// The stalled-world case: the date never advances, so the horizon can
		// never be reached. That must be a distinguishable outcome, not a 0 result.
		const ep = createEpisode({ ...base, horizonDays: 400, capMs: 900_000 });
		const st = ep.check({ gameDay: base.startGameDay, nowMs: base.startedAtMs + 900_000 });
		expect(st.stopReason).toBe("wall_cap");
		expect(st.simulatedDays).toBe(0);
		expect(st.reachedHorizon).toBe(false);
	});

	it("does not go backwards if the reported day is stale or reset", () => {
		const ep = createEpisode({ ...base, horizonDays: 50 });
		ep.check({ gameDay: base.startGameDay + 30, nowMs: base.startedAtMs });
		const st = ep.check({ gameDay: base.startGameDay - 5, nowMs: base.startedAtMs });
		expect(st.simulatedDays).toBe(30);
		expect(st.daysRemaining).toBe(20);
	});

	it("horizon wins over the cap when both are satisfied", () => {
		const ep = createEpisode({ ...base, horizonDays: 10, capMs: 1000 });
		const st = ep.check({ gameDay: base.startGameDay + 10, nowMs: base.startedAtMs + 5000 });
		expect(st.stopReason).toBe("horizon");
		expect(st.reachedHorizon).toBe(true);
	});
});
