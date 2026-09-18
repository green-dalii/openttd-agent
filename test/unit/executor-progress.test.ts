/**
 * Tests for the construction-progress meter (G2, SPEC §10.67 layer 3).
 *
 * Why: the agent could not see the resource that decides the episode. It ordered
 * routes of 68, 110, 161, 239 and 271 tiles in one run while the executor was
 * still laying the first one, and it filled the blind spot by polling - 193 tool
 * calls in a single episode. `estimate_route` reports tiles and cost but never
 * TIME, and the decision context carried no progress, queue or ETA at all.
 *
 * Field semantics come from the Squirrel source, not from the field names:
 * `rd s<seg> r<step> d<dist> p<fails>` emits `dist = AIMap.DistanceManhattan(
 * roadCur, farStation)` - i.e. `d` is the tiles STILL TO GO, and it falls as the
 * road advances (executor-ai/main.nut:420,462).
 */
import { describe, expect, it } from "vitest";
import { createExecutorProgress } from "../../src/agent/executor-progress.js";

describe("construction progress meter", () => {
	it("computes tiles per game day from a decrease in remaining tiles", () => {
		const m = createExecutorProgress();
		m.observe({ gameDay: 100, job: 1, segment: 0, remainingTiles: 120, step: 0 });
		m.observe({ gameDay: 200, job: 1, segment: 0, remainingTiles: 70, step: 4 });
		const r = m.report(200);
		// 50 tiles in 100 game days
		expect(r.tilesPerDay).toBeCloseTo(0.5, 5);
		expect(r.remainingTiles).toBe(70);
		// 70 tiles at 0.5/day = 140 game days
		expect(r.etaDays).toBeCloseTo(140, 5);
		expect(r.job).toBe(1);
	});

	it("reports no rate while the road has not advanced (searching only)", () => {
		const m = createExecutorProgress();
		m.observe({ gameDay: 100, job: 1, segment: 0, remainingTiles: 115, step: 0 });
		m.observe({ gameDay: 130, job: 1, segment: 0, remainingTiles: 115, step: 9 });
		m.observe({ gameDay: 160, job: 1, segment: 0, remainingTiles: 115, step: 17 });
		const r = m.report(160);
		expect(r.tilesPerDay).toBeNull();
		expect(r.etaDays).toBeNull();
		// The search IS progressing, but the road is not: that distinction matters.
		expect(r.stalledDays).toBe(60);
		expect(r.searchStep).toBe(17);
	});

	it("resets the measurement when the job changes (per-route evidence)", () => {
		const m = createExecutorProgress();
		m.observe({ gameDay: 10, job: 1, remainingTiles: 100, step: 0 });
		m.observe({ gameDay: 60, job: 1, remainingTiles: 50, step: 0 }); // 1.0 tile/day on job 1
		m.observe({ gameDay: 70, job: 2, remainingTiles: 200, step: 0 });
		const r = m.report(70);
		expect(r.job).toBe(2);
		expect(r.remainingTiles).toBe(200);
		expect(r.tilesPerDay).toBeNull(); // job 2 has no history yet
		expect(r.jobsSeen).toBe(2);
	});

	it("keeps the last known tiles when a heartbeat carries no distance", () => {
		const m = createExecutorProgress();
		m.observe({ gameDay: 10, job: 1, remainingTiles: 90, step: 0 });
		m.observe({ gameDay: 20, job: 1, remainingTiles: 60, step: 0 });
		m.observe({ gameDay: 30, job: 1 }); // heartbeat: no road fields
		const r = m.report(30);
		expect(r.remainingTiles).toBe(60);
		// 30 tiles over 10 game days (day 10 -> 20); the heartbeat at day 30
		// carries no road fields and must not disturb the measurement.
		expect(r.tilesPerDay).toBeCloseTo(3, 5);
	});

	it("is empty before any sample (absence is not zero)", () => {
		const m = createExecutorProgress();
		const r = m.report(0);
		expect(r.job).toBeNull();
		expect(r.remainingTiles).toBeNull();
		expect(r.tilesPerDay).toBeNull();
		expect(r.etaDays).toBeNull();
		expect(r.stalledDays).toBeNull();
		expect(r.jobsSeen).toBe(0);
	});
});
