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