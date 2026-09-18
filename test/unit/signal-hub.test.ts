import { describe, expect, it as it_, vi } from "vitest";
import { makeSignalHub } from "../../src/agent/signal-hub.js";
import type { GameEvent } from "../../src/types.js";

/**
 * B-3 TDD: signal-hub 的契约测试。
 *   golden 样张全部来自真机日志（/tmp/calA3.log，SPEC §10.46），
 *   不发明格式（AGENTS §5）。
 *   acceptance：runner.ts 改完后这些测试仍绿 + 全量 gate 不退。
 */

const fakeWorld = () => ({
	ingest: vi.fn(),
	setTowns: vi.fn(),
	// G2: the hub now reads the clock to time construction progress.
	snapshot: () => ({ date: { year: 1950, month: 1, day: 1 } }),
});
const fakeWeb = () => ({ publishEvent: vi.fn() });
const fakeSession = () => ({
	appendEvent: vi.fn(),
	current: () => ({ checkpoints: [{ gameDate: "1950-03-14" }, { gameDate: "1950-04-01" }] }),
});
const fakeLedger = () => ({ markDone: vi.fn(), record: vi.fn() });

describe("signal-hub —— B-3 单元契约（golden from /tmp/calA3.log）", () => {
	it_("company_stats：fleet 变化唤醒 onNotableEvent", () => {
		const onNotable = vi.fn();
		const hub = makeSignalHub({
			world: fakeWorld() as never,
			getWeb: () => null,
			getSession: () => null,
			routeLedger: fakeLedger() as never,
			getDecisionCount: () => 0,
			onPhaseChange: () => {},
			onNotableEvent: onNotable,
		});
		hub.onEvent({ kind: "company_stats", payload: { vehicles: 0, stations: 0 } } as unknown as GameEvent);
		hub.onEvent({ kind: "company_stats", payload: { vehicles: 1, stations: 0 } } as unknown as GameEvent);
		hub.onEvent({ kind: "company_stats", payload: { vehicles: 3, stations: 2 } } as unknown as GameEvent);
		// first call seeds prevStats (no notable); second +2 vehicles; third +2/+2
		expect(onNotable).toHaveBeenCalledTimes(2);
		// deltas from {0,0} -> {1,0} = +1 vehicles; -> {3,2} = +2 vehicles +2 stations
		expect(onNotable.mock.calls[0]?.[0]).toMatch(/vehicles \+1/);
		expect(onNotable.mock.calls[1]?.[0]).toMatch(/vehicles \+2.*stations \+2|stations \+2.*vehicles \+2/);
	});

	it_("company_stats：无变化不唤醒（噪声门）", () => {
		const onNotable = vi.fn();
		const hub = makeSignalHub({
			world: fakeWorld() as never, getWeb: () => null, getSession: () => null,
			routeLedger: fakeLedger() as never, getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent: onNotable,
		});
		hub.onEvent({ kind: "company_stats", payload: { vehicles: 0, stations: 0 } } as unknown as GameEvent);
		hub.onEvent({ kind: "company_stats", payload: { vehicles: 0, stations: 0 } } as unknown as GameEvent);
		expect(onNotable).not.toHaveBeenCalled();
	});

	it_("GS state：town_list 写到 world（形状取自真机：id/pop/x/y）", () => {
		const w = fakeWorld();
		const hub = makeSignalHub({
			world: w as never, getWeb: () => null, getSession: () => null,
			routeLedger: fakeLedger() as never, getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
		hub.onEvent({
			kind: "gamescript",
			payload: {
				cmd: "state",
				date: 712225, towns: 20, signs: 0,
				town_list: [
					{ id: 9, pop: 1500, x: 100, y: 200 },
					{ id: 12, pop: 800, x: 150, y: 180 },
				],
			},
		} as unknown as GameEvent);
		expect(w.setTowns).toHaveBeenCalledWith([
			{ id: 9, population: 1500, x: 100, y: 200 },
			{ id: 12, population: 800, x: 150, y: 180 },
		]);
	});

	it_("GS exec 事件：stage 变化唤醒 onPhaseChange；hb=true 不唤醒", () => {
		const onPhase = vi.fn();
		const hub = makeSignalHub({
			world: fakeWorld() as never, getWeb: () => null, getSession: () => null,
			routeLedger: fakeLedger() as never, getDecisionCount: () => 0,
			onPhaseChange: onPhase, onNotableEvent: () => {},
		});
		// boot → wake
		hub.onEvent({ kind: "gamescript", payload: { kind: "exec", stage: "boot", job: -1, hb: false, raw: "EX boot j-1" } } as unknown as GameEvent);
		// heartbeat → must NOT wake
		hub.onEvent({ kind: "gamescript", payload: { kind: "exec", stage: "heartbeat", job: -1, hb: true, raw: "EX hb boot #1 s0 j-1" } } as unknown as GameEvent);
		// road change → wake
		hub.onEvent({ kind: "gamescript", payload: { kind: "exec", stage: "road", job: 1, hb: false, raw: "EX rd s0 r0 d65 p0 j1" } } as unknown as GameEvent);
		expect(onPhase).toHaveBeenCalledTimes(2);
		expect(hub.getStage()).toBe("road");
		expect(hub.getPhase()).toBe("EX rd s0 r0 d65 p0 j1");
	});

	it_("GS exec done → ledger.markDone 带 checkpoints 末次日期", () => {
		const ledger = fakeLedger();
		const session = fakeSession();
		const hub = makeSignalHub({
			world: fakeWorld() as never,
			getWeb: () => null,
			getSession: () => session as never,
			routeLedger: ledger as never,
			getDecisionCount: () => 3,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
		hub.onEvent({
			kind: "gamescript",
			payload: { kind: "exec", stage: "done", job: 100, hb: false, raw: "EX done stN2 r75 bus j100" },
		} as unknown as GameEvent);
		expect(ledger.markDone).toHaveBeenCalledWith(100, "1950-04-01");
		expect(hub.getReachedDone()).toBe(true);
	});

	it_("GS build_bus_route ack → ledger.record 携带当前决策号", () => {
		const ledger = fakeLedger();
		const hub = makeSignalHub({
			world: fakeWorld() as never, getWeb: () => null, getSession: () => null,
			routeLedger: ledger as never, getDecisionCount: () => 7,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
		const ack = {
			kind: "ack", cmd: "build_bus_route", job: 101,
			townA: 9, townB: 12, popA: 1500, popB: 800,
			tileA: 12345, frontA: 12346, tileB: 12600, frontB: 12601,
			depot: 38479, company: 0, company_signs: 6, names: ["NUTZ:bp:101:D:fr=38480"],
		};
		hub.onEvent({ kind: "gamescript", payload: ack } as unknown as GameEvent);
		expect(ledger.record).toHaveBeenCalledWith({
			job: 101, fromTown: 9, toTown: 12, decision: 7, orderedAt: expect.any(Number),
		});
		expect(hub.getLastRoute()).toEqual(ack);
	});

	it_("web.publishEvent 始终被调用；session 缺失时事件被缓冲", () => {
		const web = fakeWeb();
		const hub = makeSignalHub({
			world: fakeWorld() as never,
			getWeb: () => web as never,
			getSession: () => null,
			routeLedger: fakeLedger() as never,
			getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
		const ev = { kind: "company_stats", payload: { vehicles: 0, stations: 0 } } as unknown as GameEvent;
		hub.onEvent(ev);
		expect(web.publishEvent).toHaveBeenCalledWith(ev);
		// session buffered
		const session = fakeSession();
		hub.replayBootEvents(session as never);
		expect(session.appendEvent).toHaveBeenCalledWith(ev);
	});

	it_("session 已就绪时事件不缓冲、直写", () => {
		const session = fakeSession();
		const hub = makeSignalHub({
			world: fakeWorld() as never, getWeb: () => null,
			getSession: () => session as never,
			routeLedger: fakeLedger() as never, getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
		const ev = { kind: "company_stats", payload: { vehicles: 0, stations: 0 } } as unknown as GameEvent;
		hub.onEvent(ev);
		expect(session.appendEvent).toHaveBeenCalledWith(ev);
		hub.replayBootEvents(session as never);
		// no buffered events to drain
		expect(session.appendEvent).toHaveBeenCalledTimes(1);
	});
});

/**
 * NEXT-2 N2-1：线路经济进入 hub。GS 每 200 tick 发一次，harness 保留**最新**
 * 读数（按 job）。不唤醒决策（读数每 200 tick 都变 → 那是噪声源，不是新闻；
 * 触发设计等看到真实数据再定，见 MEMORY §0b）。
 */
describe("signal-hub —— route-stats 摄取", () => {
	const makeHub = () => makeSignalHub({
		world: fakeWorld() as never, getWeb: () => null, getSession: () => null,
		routeLedger: fakeLedger() as never, getDecisionCount: () => 0,
		onPhaseChange: () => {}, onNotableEvent: () => {},
	});
	const routeStats = (p: Record<string, unknown>) =>
		({ kind: "gamescript", payload: { kind: "route-stats", ...p } }) as unknown as GameEvent;

	it_("按 job 保留最新读数", () => {
		const hub = makeHub();
		hub.onEvent(routeStats({ job: 101, vehicles: 1, profit: 100, waiting: 3, gameDate: 1000 }));
		hub.onEvent(routeStats({ job: 102, vehicles: 2, profit: 900, waiting: 8, gameDate: 1000 }));
		hub.onEvent(routeStats({ job: 101, vehicles: 2, profit: 4000, waiting: 1, gameDate: 1150 }));
		const all = hub.getRouteStats();
		expect(all).toHaveLength(2);
		const r101 = all.find((r) => r.job === 101)!;
		expect(r101.profit).toBe(4000); // 覆盖旧读数，不叠加
		expect(r101.vehicles).toBe(2);
		expect(all.find((r) => r.job === 102)!.profit).toBe(900); // 互不干扰
	});

	it_("无 route-stats 时为空数组（不是 undefined——调用方不必防空洞）", () => {
		expect(makeHub().getRouteStats()).toEqual([]);
	});

	it_("route-stats 不唤醒决策（噪声门：200 tick 一条，变化是常态）", () => {
		const onNotable = vi.fn();
		const onPhase = vi.fn();
		const hub = makeSignalHub({
			world: fakeWorld() as never, getWeb: () => null, getSession: () => null,
			routeLedger: fakeLedger() as never, getDecisionCount: () => 0,
			onPhaseChange: onPhase, onNotableEvent: onNotable,
		});
		hub.onEvent(routeStats({ job: 101, vehicles: 1, profit: 100, waiting: 3, gameDate: 1000 }));
		expect(onNotable).not.toHaveBeenCalled();
		expect(onPhase).not.toHaveBeenCalled();
	});
});

/**
 * 通道健康计数（2026-09-18，SPEC §10.66）。
 *
 * 为什么必须记录：GS 通道的失效是**部分且逐局不同**的——一个错误的 GS API
 * 调用只让**那一种**请求返回 `kind:"err"`，其余照常工作。ab900/cal900 全部
 * 17 局都命中 `IsStationTile` 错误（2–152 次不等），verdict 里**一行都看不到**，
 * 比较就这样吸收了"某几局 agent 在失明状态下操作"。计数器让它在结果旁边可见。
 */
describe("signal-hub —— GS 错误计数（通道健康）", () => {
	const mkHub = () =>
		makeSignalHub({
			world: fakeWorld() as never,
			getWeb: () => null,
			getSession: () => null,
			routeLedger: fakeLedger() as never,
			getDecisionCount: () => 0,
			onPhaseChange: () => {},
			onNotableEvent: () => {},
		});

	it_("从 0 开始", () => {
		expect(mkHub().getGsErrors()).toBe(0);
	});

	it_("每个 kind:'err' 计一次，正常事件不计", () => {
		const hub = mkHub();
		// 真机形状：外层 ev.kind = "gamescript"，错误在 payload.kind（来自 dm3 日志）
		hub.onEvent({
			kind: "gamescript",
			payload: { kind: "err", cmd: "route_stats", detail: { reason: "the index 'IsStationTile' does not exist" } },
		} as unknown as GameEvent);
		hub.onEvent({
			kind: "gamescript",
			payload: { kind: "route_stats", job: 1, vehicles: 0, profit: 0, waiting: 0, gameDate: 712500 },
		} as unknown as GameEvent);
		hub.onEvent({
			kind: "gamescript",
			payload: { kind: "err", cmd: "build", detail: { reason: "refused" } },
		} as unknown as GameEvent);
		expect(hub.getGsErrors()).toBe(2);
	});
});
