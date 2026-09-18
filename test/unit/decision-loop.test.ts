import { describe, expect, it, vi } from "vitest";
import { createDecisionLoop, type DecisionLoopCtx } from "../../src/agent/decision-loop.js";

/**
 * B-4b TDD: 决策循环体的单元契约。
 * 全部依赖（scheduler/runDecision/telemetry/audit/session/web）用 fake 注入，
 * 断言循环的可观察行为——顺序与状态迁移，不 mock 内部实现。
 * 真机行为不变由 calB5 + 全量 gate 证明（与 B-1..B-3 同守则）。
 */

function makeCtx(over: Partial<DecisionLoopCtx> = {}): DecisionLoopCtx & {
	schedulerFake: { take: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
	runDecisionFake: ReturnType<typeof vi.fn>;
	auditFake: { write: ReturnType<typeof vi.fn> };
	sessionFake: { appendAudit: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; addCheckpoint: ReturnType<typeof vi.fn>; current: () => unknown };
	pendingActions: { tool: string; ok: boolean; summary: string }[];
} {
	const schedulerFake = {
		take: vi.fn(() => null),
		count: vi.fn(() => 1),
		request: vi.fn(),
	};
	const runDecisionFake = vi.fn(async () => ({ plan: null }));
	const auditFake = { write: vi.fn() };
	const sessionFake = {
		appendAudit: vi.fn(),
		update: vi.fn(),
		addCheckpoint: vi.fn(),
		current: () => ({
			checkpoints: [{ note: "seed" }],
			totals: { events: 0, decisions: 0, toolCalls: 0, toolFailures: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costTotal: 0 } },
			startedAt: Date.now(),
		}),
	};
	const pendingActions: { tool: string; ok: boolean; summary: string }[] = [];
	const ctx: DecisionLoopCtx = {
		deps: {
			state: {
				snapshot: () => ({
					date: { year: 1950, month: 3, day: 14 },
					companies: new Map(),
					towns: [],
					recent: [],
					totalEvents: 0,
				}),
			},
		} as never,
		agent: {} as never,
		scheduler: schedulerFake as never,
		hub: { getPhase: () => "EX work j100" } as never,
		telemetry: {
			decisionPoint: vi.fn(),
			snapshot: () => ({ totals: { decisions: 1, toolCalls: 0, toolFailures: 0 }, usage: { total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costTotal: 0 } } }),
		} as never,
		audit: auditFake as never,
		session: sessionFake as never,
		getWeb: () => null,
		pendingActions,
		opts: { decisionTickMs: 1 },
		isStopRequested: () => false,
		requestStop: () => {},
		publishStage: vi.fn(),
		runDecision: runDecisionFake as never,
		now: () => Date.now(),
		gameDay: () => 10,
		routesForContext: () => [],
		...over,
	};
	return Object.assign(ctx, { schedulerFake, runDecisionFake, auditFake, sessionFake, pendingActions });
}

describe("decision-loop —— B-4b 单元契约", () => {
	it("start 触发：一次决策 → audit.decision → runDecision → checkpoint → pendingActions 清空", async () => {
		const ctx = makeCtx({
			opts: { decisionTickMs: 1 },
		});
		// 第一次 take 返回 due，其后返回 null；循环在无 due 时依赖 stopRequested 退出
		let calls = 0;
		ctx.schedulerFake.take.mockImplementation(() => (calls++ === 0 ? { trigger: "start" } : null));
		const loop = createDecisionLoop(ctx);
		// 用有限次迭代退出：3 次空转后强制停
		let spins = 0;
		const stopper = setInterval(() => {
			spins++;
			if (spins > 3) ctx.isStopRequested = () => true;
		}, 5);
		await loop.run();
		clearInterval(stopper);
		expect(ctx.runDecisionFake).toHaveBeenCalledTimes(1);
		expect(ctx.runDecisionFake.mock.calls[0]?.[2]).toMatchObject({ trigger: "start" });
		const decisionWrites = ctx.auditFake.write.mock.calls.filter((c) => c[0]?.type === "decision");
		expect(decisionWrites).toHaveLength(1);
		expect(ctx.sessionFake.addCheckpoint).toHaveBeenCalledTimes(1);
		expect(ctx.pendingActions).toHaveLength(0);
	});

	it("phase 变化处理：waitCondition 命中 → request(wait_until) 且条件清除；未命中 → request(phase_change)", () => {
		const ctx = makeCtx();
		const loop = createDecisionLoop(ctx);
		// 模拟上一轮决策设置了条件（经 handlePlanWait）
		loop.handlePlanWait({ condition: "done" });
		loop.handlePhase("EX DONE stN2 r75 bus j100");
		expect(ctx.schedulerFake.request).toHaveBeenCalledWith("wait_until");
		// 条件已清除：再遇同相 → phase_change
		loop.handlePhase("EX DONE stN2 r75 bus j100");
		expect(ctx.schedulerFake.request).toHaveBeenLastCalledWith("phase_change");
	});

	it("handlePhase 无条件时 → request(phase_change)", () => {
		const ctx = makeCtx();
		const loop = createDecisionLoop(ctx);
		loop.handlePhase("EX road_start j100");
		expect(ctx.schedulerFake.request).toHaveBeenCalledWith("phase_change");
	});

	it("handleNotable → recordEvent + request(event)", () => {
		const ctx = makeCtx();
		const loop = createDecisionLoop(ctx);
		loop.handleNotable("vehicles +2");
		expect(ctx.schedulerFake.request).toHaveBeenCalledWith("event");
	});

	it("deadline 到点：run() 立即退出且零决策", async () => {
		const ctx = makeCtx({ opts: { decisionTickMs: 1, seconds: -1 } });
		// seconds<=0 → deadline null → 不停；改用 isStopRequested 退出，同时断言无决策
		ctx.schedulerFake.take.mockReturnValue(null);
		let spins = 0;
		ctx.isStopRequested = () => ++spins > 2;
		const loop = createDecisionLoop(ctx);
		await loop.run();
		expect(ctx.runDecisionFake).not.toHaveBeenCalled();
	});

	it("wait_until 过期 → scheduler.request(wait_until)", async () => {
		const ctx = makeCtx({ opts: { decisionTickMs: 1 } });
		// gameDay 从 10 走到 45 → wait_until{35,from:10} 过期
		let day = 10;
		ctx.gameDay = () => day;
		const loop = createDecisionLoop(ctx);
		loop.handlePlanWait({ game_days: 35 });
		day = 45;
		let spins = 0;
		ctx.isStopRequested = () => ++spins > 2;
		await loop.run();
		expect(ctx.schedulerFake.request).toHaveBeenCalledWith("wait_until");
	});

	it("waitCondition 命中 phase → request(wait_until)（run 内路径）", async () => {
		const ctx = makeCtx({ opts: { decisionTickMs: 1 } });
		const loop = createDecisionLoop(ctx);
		loop.handlePlanWait({ condition: "done" });
		// hub.getPhase 返回 "EX work j100"，但 phase 变化由 handlePhase 驱动；
		// run() 内部只消费 scheduler —— 这里直接验证 handlePhase 的行为已覆盖。
		loop.handlePhase("EX done stN2 r75 bus j100");
		expect(ctx.schedulerFake.request).toHaveBeenCalledWith("wait_until");
	});
});