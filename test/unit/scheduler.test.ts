/**
 * Unit tests — decision scheduler (when the framework asks the LLM to decide).
 *
 * 职责: 锁定触发与节流规则。这是 v0.5.0「只决策一次」缺陷的修复核心
 *   （docs/AGENT-LOOP-AND-CONTROL.md §2.1）。
 * 禁止: 在此断言任何策略（框架只决定"何时问"，不决定"该做什么"）。
 */

import { describe, expect, it } from "vitest";
import { DecisionScheduler } from "../../src/agent/scheduler.js";

/** Deterministic clock for tests. */
function clock(start = 1_000_000) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => (t += ms),
	};
}

describe("decision scheduler", () => {
	it("fires immediately for the opening decision", () => {
		const s = new DecisionScheduler({ minGapMs: 5000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		const d = s.take(c.now(), 0);
		expect(d).toEqual({ trigger: "start" });
	});

	it("never fires twice for the same request", () => {
		const s = new DecisionScheduler({ minGapMs: 5000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		expect(s.take(c.now(), 0)).not.toBeNull();
		// Taking again without a new request yields nothing.
		expect(s.take(c.now(), 0)).toBeNull();
	});

	it("throttles: a new request is withheld until the gap has passed", () => {
		const s = new DecisionScheduler({ minGapMs: 5000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		s.take(c.now(), 0);
		s.request("phase_change");
		// Too soon: the model would be spammed by a construction burst.
		expect(s.take(c.now(), 0)).toBeNull();
		c.advance(4999);
		expect(s.take(c.now(), 0)).toBeNull();
		c.advance(1);
		expect(s.take(c.now(), 0)).toEqual({ trigger: "phase_change" });
	});

	it("coalesces several requests during the throttle window into one decision", () => {
		const s = new DecisionScheduler({ minGapMs: 1000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		s.take(c.now(), 0);
		s.request("phase_change");
		s.request("phase_change");
		s.request("event");
		c.advance(1000);
		const d = s.take(c.now(), 0);
		expect(d).not.toBeNull();
		// One decision, not three: the queued triggers collapse.
		expect(s.take(c.now(), 0)).toBeNull();
	});

	it("fires on the game-month interval even without an explicit request", () => {
		const s = new DecisionScheduler({ minGapMs: 1000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		s.take(c.now(), 0); // baseline gameDay 0
		c.advance(2000);
		// 89 days: not yet (income moves monthly, but re-asking every day burns tokens)
		expect(s.take(c.now(), 89)).toBeNull();
		c.advance(60000);
		expect(s.take(c.now(), 90)).toEqual({ trigger: "interval" });
	});

	it("keeps asking periodically for the whole run (not just once)", () => {
		// The v0.5.0 defect: maxTurns = 1 meant exactly one decision ever.
		const s = new DecisionScheduler({ minGapMs: 1000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		const triggers: string[] = [];
		for (let day = 0; day <= 900; day += 10) {
			c.advance(10000);
			const d = s.take(c.now(), day);
			if (d) triggers.push(d.trigger);
		}
		// 900 game days / 90-day interval => ~10 decisions, and the first is "start".
		expect(triggers[0]).toBe("start");
		expect(triggers.filter((t) => t === "interval").length).toBeGreaterThanOrEqual(8);
	});

	it("explicit requests take priority over the interval", () => {
		const s = new DecisionScheduler({ minGapMs: 1000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		s.take(c.now(), 0);
		c.advance(60000);
		s.request("event");
		expect(s.take(c.now(), 500)).toEqual({ trigger: "event" });
	});

	it("reports whether a decision is pending or due", () => {
		const s = new DecisionScheduler({ minGapMs: 1000, intervalGameDays: 90 });
		const c = clock();
		expect(s.pending()).toBe(false);
		s.request("start");
		expect(s.pending()).toBe(true);
		s.take(c.now(), 0);
		expect(s.pending()).toBe(false);
	});

	it("stops scheduling while paused and resumes without a burst", () => {
		const s = new DecisionScheduler({ minGapMs: 1000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		s.take(c.now(), 0);
		s.pause();
		c.advance(500000);
		s.request("interval");
		expect(s.take(c.now(), 5000)).toBeNull(); // paused: nothing fires
		s.resume();
		// Resuming must not fire every interval that elapsed while paused.
		const d = s.take(c.now(), 5000);
		expect(d).not.toBeNull();
		expect(s.take(c.now(), 5000)).toBeNull();
	});

	it("reset() returns to a fresh state for a new run", () => {
		const s = new DecisionScheduler({ minGapMs: 1000, intervalGameDays: 90 });
		const c = clock();
		s.request("start");
		s.take(c.now(), 0);
		s.reset();
		expect(s.pending()).toBe(false);
		s.request("start");
		expect(s.take(c.now(), 0)).toEqual({ trigger: "start" });
	});

	it("exposes a count of decisions made (for the dashboard)", () => {
		const s = new DecisionScheduler({ minGapMs: 1000, intervalGameDays: 90 });
		const c = clock();
		expect(s.count()).toBe(0);
		s.request("start");
		s.take(c.now(), 0);
		expect(s.count()).toBe(1);
	});
});
