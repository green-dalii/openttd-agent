/**
 * W2（SPEC §10.102）："世界冻住了"必须成为 run 记录里的**事实**，而不是页面上一句话。
 *
 * 事故背景（2026-09-25 取证）：agent 自己 `set_pause` 后世界冻结，进程"活着"一小时；
 * 更早一次（2026-09-12）是 OpenTTD 自己的 `pause_on_join` 静默冻住世界 ——
 * 两种原因产出同样的症状（日期不动），但处置完全相反，所以必须能分开。
 *
 * 本文件的断言全部围绕三件事：
 *   ① 只有日期**变化**才算世界推进（同一个值重复到达不算）；
 *   ② "没有人按住它"是必要前提 —— 否则那是 W1 的 blockedByPause，不是 worldFrozen；
 *   ③ 证据（worldFrozenMs）与结论（worldFrozen）分开记，事后可重判阈值。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSignalHub, type SignalHubRefs } from "../../src/agent/signal-hub.js";
import { runFinalizeAndReflect } from "../../src/agent/reflect-run.js";
import { toGameMetric, compareArms } from "../../src/evolution/metrics.js";
import type { GameEvent } from "../../src/types.js";

const PUBLIC_DIR = join(process.cwd(), "src/web/public");

/** 最小 hub 接线：只要能吐 `gamescript` 事件即可（world/routeLedger 都被空实现）。 */
function makeHub() {
	const hub = makeSignalHub({
		world: {
			snapshot: () => ({ date: null }),
			ingest: () => {},
			setTowns: () => {},
			setIndustries: () => {},
			setCargoTotals: () => {},
			setCompanyCargo: () => {},
		},
		getWeb: () => null,
		getSession: () => null,
		routeLedger: { record: () => {}, all: () => [] },
		getDecisionCount: () => 0,
		onPhaseChange: () => {},
		onNotableEvent: () => {},
	} as unknown as SignalHubRefs);
	return hub;
}

function gsState(date: number, ts: number): GameEvent {
	return {
		seq: 1,
		kind: "gamescript",
		ts,
		payload: { cmd: "state", date },
	} as unknown as GameEvent;
}

describe("W2: 世界时钟（signal-hub 是这个事实的唯一写者）", () => {
	// 墙钟事实必须用假时钟：真实时钟下这些调用发生在同一毫秒里，
	// "时间在流逝"就测不出来（第一次写测试时正是这么假的）。
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("GS 报的同一个日期重复到达，不算世界推进", () => {
		const hub = makeHub();
		hub.onEvent(gsState(1000, 1_000));
		const first = hub.getWorldClock();
		// 同一个日期又来了 3 次（真实运行里每 200 tick 就来一次）
		vi.setSystemTime(9_000);
		hub.onEvent(gsState(1000, 9_000));
		vi.setSystemTime(17_000);
		hub.onEvent(gsState(1000, 17_000));
		vi.setSystemTime(25_000);
		hub.onEvent(gsState(1000, 25_000));
		const after = hub.getWorldClock();
		expect(after.lastAdvancedAtMs).toBe(first.lastAdvancedAtMs);
		// 同一个日期重复到达正是"世界冻住"的样子，这里必须看得出时间在流逝
		expect(after.frozenForMs).toBeGreaterThan(first.frozenForMs ?? 0);
	});

	it("日期真的变了 → 推进时刻被刷新", () => {
		const hub = makeHub();
		hub.onEvent(gsState(1000, 1_000));
		vi.setSystemTime(5_000);
		hub.onEvent(gsState(1003, 5_000));
		vi.setSystemTime(9_000);
		hub.onEvent(gsState(1006, 9_000));
		const c = hub.getWorldClock();
		expect(c.rawDate).toBe(1006);
		// 最后一次推进发生在 9_000 那一刻，所以"距今"应恰好为 0
		expect(c.lastAdvancedAtMs).toBe(9_000);
		expect(c.frozenForMs).toBe(0);
	});

	it("从未见过 GS 日期 → null（不知道），不是 0（冻住）", () => {
		const hub = makeHub();
		const c = hub.getWorldClock();
		expect(c.rawDate).toBeNull();
		expect(c.lastAdvancedAtMs).toBeNull();
		expect(c.frozenForMs).toBeNull();
	});
});

function fakeSession() {
	return {
		id: "s-w2",
		current: () => ({
			checkpoints: [],
			totals: { events: 0, decisions: 0, toolCalls: 0, toolFailures: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costTotal: 0 } },
			startedAt: Date.now(),
		}),
		saveTelemetry: vi.fn(),
		update: vi.fn(),
		addCheckpoint: vi.fn(),
		finalize: vi.fn(),
	} as never;
}

function fakeWorld() {
	return {
		snapshot: () => ({
			date: { year: 1950, month: 12, day: 1, raw: 1 },
			companies: new Map(),
			totalEvents: 0,
		}),
	} as never;
}

async function finalizeWith(dir: string, session: ReturnType<typeof fakeSession>, worldFrozen: { frozenForMs: number | null; harnessHeld: boolean } | null) {
	const { createFauxCore, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
	const core = createFauxCore({});
	core.setResponses([fauxAssistantMessage("no lessons")]);
	await runFinalizeAndReflect({
		cfg: { dataDir: dir, seed: 7 } as never,
		world: fakeWorld(),
		session,
		telemetry: { snapshot: () => ({ usage: { total: { input: 0, output: 0, reasoning: 0, totalTokens: 0, costTotal: 0 } }, totals: { toolCalls: 0, toolFailures: 0, decisions: 2 } }) } as never,
		executorPhase: "hb road #3 s3",
		reachedDone: false,
		scheduler: { count: () => 2 },
		pendingActions: [],
		routeLedger: { all: () => [], record: () => {} } as never,
		getRouteStats: () => [],
		gsErrors: 0,
		worldFrozen,
		scenario: "freeform",
		episode: { simulatedDays: 0, horizonDays: null, reachedHorizon: false, stopReason: null },
		arm: "control" as const,
		reflectLlm: core,
	} as never);
	const fin = (session as unknown as { finalize: { mock: { calls: unknown[][] } } }).finalize;
	return (fin.mock.calls[0]?.[0] as { outcome?: Record<string, unknown> }).outcome ?? {};
}

describe("W2: 阈值常量本身", () => {
	it("45 s：健康世界实测 6.0 s 推进一次（max），事故是 1 小时", async () => {
		const { WORLD_FROZEN_AFTER_MS } = await import("../../src/agent/reflect-run.js");
		// 实测依据（2026-09-25 隔离真机）：健康期相邻推进 max 6.0 s（41 个样本），
		// 外部暂停后的冻结段 64~66 s，事故现场是 1 小时。45 s 落在健康与冻结之间，
		// 约为健康 max 的 7.5 倍 —— 改这个数必须重新量，不能凭感觉。
		expect(WORLD_FROZEN_AFTER_MS).toBe(45_000);
	});
});

describe("W2: 写进 run outcome", () => {
	it("世界不推进 + 没有人按住 → worldFrozen:true，且证据 worldFrozenMs 一起记下", async () => {
		const dir = mkdtempSync(join(tmpdir(), "w2-"));
		const o = await finalizeWith(dir, fakeSession(), { frozenForMs: 3_600_000, harnessHeld: false });
		expect(o.worldFrozen).toBe(true);
		expect(o.worldFrozenMs).toBe(3_600_000);
		rmSync(dir, { recursive: true, force: true });
	});

	it("harness 正按着世界（那就是 W1，不是 W2）→ 不写 worldFrozen，但证据照记", async () => {
		const dir = mkdtempSync(join(tmpdir(), "w2-"));
		const o = await finalizeWith(dir, fakeSession(), { frozenForMs: 3_600_000, harnessHeld: true });
		expect(o.worldFrozen).toBeUndefined();
		expect(o.worldFrozenMs).toBe(3_600_000);
		rmSync(dir, { recursive: true, force: true });
	});

	it("没超过阈值（抖动）→ 不写 worldFrozen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "w2-"));
		const o = await finalizeWith(dir, fakeSession(), { frozenForMs: 1_000, harnessHeld: false });
		expect(o.worldFrozen).toBeUndefined();
		expect(o.worldFrozenMs).toBe(1_000);
		rmSync(dir, { recursive: true, force: true });
	});

	it("从未见过 GS 日期（null）→ 两个字段都不写（不知道 ≠ 冻住）", async () => {
		const dir = mkdtempSync(join(tmpdir(), "w2-"));
		const o = await finalizeWith(dir, fakeSession(), { frozenForMs: null, harnessHeld: false });
		expect(o.worldFrozen).toBeUndefined();
		expect(o.worldFrozenMs).toBeUndefined();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("W2: 进化账本与 A/B", () => {
	const meta = (over: Record<string, unknown>) => ({
		id: "m1", mode: "agent", status: "completed", startedAt: 1_000, seed: 1,
		llm: { providerId: "p", model: "m", kind: "real" },
		outcome: { constructionDone: true, money: "100", income: 10, delivered: 5, stations: 2 },
		...over,
	});

	it("toGameMetric 带上 worldFrozen / worldFrozenMs", () => {
		const m = toGameMetric(meta({ outcome: { constructionDone: true, worldFrozen: true, worldFrozenMs: 900_000 } }));
		expect(m.worldFrozen).toBe(true);
		expect(m.worldFrozenMs).toBe(900_000);
	});

	it("正常局是 undefined / 0，而不是 false（区分没发生与没记录）", () => {
		const m = toGameMetric(meta({}));
		expect(m.worldFrozen).toBeUndefined();
		expect(m.worldFrozenMs).toBeNull();
	});

	it("compareArms 剔除冻住的局，并在披露串里报出数量与原因", () => {
		const rows = [
			toGameMetric(meta({ id: "ok1" })),
			toGameMetric(meta({ id: "ok2" })),
			toGameMetric(meta({ id: "frz", outcome: { constructionDone: false, worldFrozen: true, worldFrozenMs: 3_600_000 } })),
		];
		const c = compareArms(rows, "memory");
		const counted = c.withLessons.count + c.withoutLessons.count;
		expect(counted).toBe(2);
		expect(c.note).toMatch(/1 that ended with the world frozen/);
	});

	it("被人停的局与冻住的局是两个原因，披露里不合并", () => {
		const rows = [
			toGameMetric(meta({ id: "ok1" })),
			toGameMetric(meta({ id: "paused", outcome: { constructionDone: false, blockedByPause: true, pausedBy: "agent" } })),
			toGameMetric(meta({ id: "frz", outcome: { constructionDone: false, worldFrozen: true } })),
		];
		const c = compareArms(rows, "memory");
		// blockedByPause 在 comparableMetrics 就剔了，所以披露里只剩"世界冻住"这一条
		expect(c.note).toMatch(/1 that ended with the world frozen/);
		expect(c.note).not.toMatch(/ended while paused/);
	});
});

describe("W2: /sessions 审核页（页面脚本用源码守卫，与仓库其它页面一致）", () => {
	const src = readFileSync(join(PUBLIC_DIR, "assets/js/sessions.js"), "utf8");

	it("worldFrozen 分支存在，且排在其它测量项之前", () => {
		expect(src).toMatch(/o\.worldFrozen === true/);
		expect(src).toMatch(/Ended with the world frozen/);
		const fn = src.slice(src.indexOf("outcomeRows()"), src.indexOf("brainText()"));
		expect(fn.indexOf("o.worldFrozen")).toBeLessThan(fn.indexOf("Construction done"));
	});

	it("写明不是 agent 的学习结果（不能让人误读成学得太慢）", () => {
		expect(src).toMatch(/the environment stopped, not the agent/);
	});
});
