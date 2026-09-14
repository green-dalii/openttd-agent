/**
 * Unit tests — decision context (the feedback payload handed to the LLM).
 *
 * 职责: 锁定「框架给 LLM 的是事实 + 因果，不是建议」这一契约
 *   （docs/AGENT-LOOP-AND-CONTROL.md §2.2/§2.4）。
 * 事实来源: docs/AGENT-LOOP-AND-CONTROL.md §1/§2。
 * 禁止: 在此断言任何策略性文案（框架不得引导）。
 */

import { describe, expect, it } from "vitest";
import {
	buildDecisionContext,
	emptyTracker,
	recordAction,
	recordEvent,
	recordPhase,
	summarizeDelta,
} from "../../src/agent/decision-context.js";

describe("decision context", () => {
	it("always carries the trigger that caused this decision", () => {
		const ctx = buildDecisionContext({
			trigger: "phase_change",
			now: { date: "1950-04-01", companies: [] },
			since: emptyTracker(),
		});
		expect(ctx.trigger).toBe("phase_change");
		expect(ctx.now.date).toBe("1950-04-01");
	});

	it("reports what changed since the last decision (the causal link)", () => {
		// Without deltas the model sees isolated snapshots and cannot tell whether
		// its previous action helped. This is the whole point of the payload.
		const tracker = emptyTracker();
		tracker.baseline = { money: 300000, income: -8000, vehicles: 0, stations: 0, gameDay: 0 };
		recordPhase(tracker, "EX stA_ok j100");
		recordPhase(tracker, "EX hb road #1 j100");
		recordAction(tracker, { tool: "add_vehicles", ok: true, summary: "3 buses" });

		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: "1950-07-01", companies: [{ id: 0, money: 250000, income: -4000, vehicles: 3, stations: 2 }] },
			since: tracker,
			gameDay: 180,
		});

		expect(ctx.sinceLastDecision.moneyDelta).toBe(-50000);
		expect(ctx.sinceLastDecision.incomeDelta).toBe(4000);
		expect(ctx.sinceLastDecision.vehiclesDelta).toBe(3);
		expect(ctx.sinceLastDecision.elapsedGameDays).toBe(180);
		// 阶段必须交给模型**解码后**的事实，而不是执行器的电报体。
		// 之前这里断言的是原始串 "EX stA_ok j100" / "EX hb road #1 j100" ——
		// 那等于把语法只存在于 Squirrel 源码里的噪声丢给模型。
		expect(ctx.sinceLastDecision.phases).toHaveLength(1);
		const p0 = ctx.sinceLastDecision.phases[0]!;
		expect(p0.phase).toBe("stA_ok");
		expect(p0.description).toMatch(/station A/i);
		expect(p0.error).toBe(false);
		// 心跳被折叠进上一条，而不是单独占一行
		expect(p0.description).toMatch(/heartbeat/i);
		// 原始串不再出现在给模型的文本里
		expect(p0.description).not.toContain("EX ");
		expect(p0.description).not.toContain("j100");
		expect(ctx.sinceLastDecision.actions[0]).toMatchObject({ tool: "add_vehicles", ok: true });
	});

	it("records failed actions so the model can see its own mistakes", () => {
		const t = emptyTracker();
		recordAction(t, { tool: "build_bus_route", ok: false, summary: "town not found" });
		expect(t.actions).toHaveLength(1);
		expect(t.actions[0]!.ok).toBe(false);
		// A failure must never be silently dropped (docs §2.4).
		expect(t.actions[0]!.summary).toContain("town not found");
	});

	it("keeps notable events and caps them so context cannot explode", () => {
		const t = emptyTracker();
		for (let i = 0; i < 50; i++) recordEvent(t, `event ${i}`);
		expect(t.notableEvents.length).toBeLessThanOrEqual(12);
		// Newest events survive the cap.
		expect(t.notableEvents[t.notableEvents.length - 1]).toBe("event 49");
	});

	it("caps phases and actions independently", () => {
		const t = emptyTracker();
		for (let i = 0; i < 40; i++) recordPhase(t, `EX p${i}`);
		for (let i = 0; i < 40; i++) recordAction(t, { tool: `t${i}`, ok: true, summary: "" });
		expect(t.phases.length).toBeLessThanOrEqual(12);
		expect(t.actions.length).toBeLessThanOrEqual(12);
	});

	it("treats a missing baseline as zero change rather than NaN", () => {
		// The first decision of a run has nothing to compare against.
		const ctx = buildDecisionContext({
			trigger: "start",
			now: { date: "1950-01-01", companies: [{ id: 0, money: 100000, income: 0, vehicles: 0, stations: 0 }] },
			since: emptyTracker(),
		});
		expect(ctx.sinceLastDecision.moneyDelta).toBe(0);
		expect(ctx.sinceLastDecision.elapsedGameDays).toBe(0);
		expect(Number.isFinite(ctx.sinceLastDecision.incomeDelta)).toBe(true);
	});

	it("survives a company that has no economy data yet", () => {
		const ctx = buildDecisionContext({
			trigger: "start",
			now: { date: null, companies: [{ id: 0, money: null, income: null, vehicles: null, stations: null }] },
			since: emptyTracker(),
		});
		expect(Number.isFinite(ctx.sinceLastDecision.moneyDelta)).toBe(true);
		expect(ctx.now.companies[0]!.id).toBe(0);
	});

	it("carries the compressed stage-summary history as long-term memory", () => {
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: "1950-10-01", companies: [] },
			since: emptyTracker(),
			history: ["1950-01-01: built line", "1950-04-01: added 3 buses"],
		});
		expect(ctx.history).toEqual(["1950-01-01: built line", "1950-04-01: added 3 buses"]);
	});

	it("bounds the history it injects", () => {
		const many = Array.from({ length: 40 }, (_, i) => `note ${i}`);
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: "1950-10-01", companies: [] },
			since: emptyTracker(),
			history: many,
		});
		expect(ctx.history.length).toBeLessThanOrEqual(12);
		// Most recent memory is kept
		expect(ctx.history[ctx.history.length - 1]).toBe("note 39");
	});

	it("states facts without giving the model advice", () => {
		// The framework must never steer: no "you should", no "try", no ordering.
		const ctx = buildDecisionContext({
			trigger: "interval",
			now: { date: "1950-05-01", companies: [{ id: 0, money: 1, income: -9, vehicles: 0, stations: 0 }] },
			since: emptyTracker(),
		});
		const text = JSON.stringify(ctx).toLowerCase();
		for (const banned of ["you should", "recommend", "suggest", "try to", "make sure to", "best to"]) {
			expect(text, `framework advice leaked: "${banned}"`).not.toContain(banned);
		}
	});

	it("summarizeDelta reports signed changes and direction", () => {
		const d = summarizeDelta(
			{ money: 100, income: -5, vehicles: 1, stations: 1, gameDay: 0 },
			{ money: 250, income: 5, vehicles: 3, stations: 1, gameDay: 30 },
		);
		expect(d.moneyDelta).toBe(150);
		expect(d.incomeDelta).toBe(10);
		expect(d.vehiclesDelta).toBe(2);
		expect(d.stationsDelta).toBe(0);
		expect(d.elapsedGameDays).toBe(30);
	});

	it("reset() clears per-window data but keeps the new baseline", () => {
		const t = emptyTracker();
		t.baseline = { money: 10, income: 1, vehicles: 0, stations: 0, gameDay: 0 };
		recordPhase(t, "EX x");
		recordAction(t, { tool: "observe", ok: true, summary: "" });
		const next = emptyTracker({ money: 20, income: 2, vehicles: 1, stations: 1, gameDay: 30 });
		expect(next.phases).toEqual([]);
		expect(next.actions).toEqual([]);
		expect(next.baseline!.money).toBe(20);
	});
});

describe("towns 必须在每轮决策上下文里（SPEC §10.34 的教训）", () => {
	// 实测：towns 只有 observe() 才有，模型整局可能都看不到自己的选址选项，
	// 于是"按人口取前二"成为唯一策略，选了 104 格远的线建不完。
	// 选址是本游戏的核心决策，候选必须在唤醒时就在眼前。
	it("buildDecisionContext 透传 towns", () => {
		const ctx = buildDecisionContext({
			trigger: "start",
			now: { date: "1950-01-01", companies: [] },
			towns: [{ id: 9, pop: 2279, x: 97, y: 162 }],
			since: emptyTracker(),
		});
		expect(ctx.towns).toEqual([{ id: 9, pop: 2279, x: 97, y: 162 }]);
	});

	it("没有 towns 时不出现在上下文里（不伪造空数组）", () => {
		const ctx = buildDecisionContext({
			trigger: "start",
			now: { date: "1950-01-01", companies: [] },
			since: emptyTracker(),
		});
		expect("towns" in ctx).toBe(false);
	});
});

describe("session horizon 是决策上下文的一部分（2026-09-12, /tmp/cal1 实测）", () => {
	// 实测：模型第一次决策全部用于探索，然后 wait_until 让自己睡到 1950-04-01，
	// 而 200 秒的局在那之前就结束了 —— plan 里"先建一条便宜的线"从未执行。
	// 会话还剩多久是**事实**（人知道这场要打多久），不是策略。
	it("透传 secondsRemaining", () => {
		const ctx = buildDecisionContext({
			trigger: "start",
			now: { date: "1950-01-01", companies: [] },
			since: emptyTracker(),
			session: { secondsRemaining: 130 },
		});
		expect(ctx.session).toEqual({ secondsRemaining: 130 });
	});

	it("没有 session 字段时不伪造", () => {
		const ctx = buildDecisionContext({
			trigger: "start",
			now: { date: "1950-01-01", companies: [] },
			since: emptyTracker(),
		});
		expect("session" in ctx).toBe(false);
	});
});
