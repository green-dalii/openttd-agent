import { describe, expect, it as it_, vi } from "vitest";
// 本文件把 `it` 重命名为 it_（为了和 sandbox 里的 it 区分），新测试用回原名。
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
	setIndustries: vi.fn(),
	// 真实 WorldState 的方法之一（GS 时钟通道，2026-09-25）。测试替身必须与生产
	// 契约一致：缺方法会让 hub 在这里抛错，而那一抛会连坐同一条 state 里的
	// 城镇/产业事实 —— 守卫本身就是这条耦合的证据。
	setDateFromRaw: vi.fn(),
	setCargoTotals: vi.fn(),
	setCompanyCargo: vi.fn(),
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
		// 第二个实参是 GS 报的**总数**（`towns: 20`）：取样列表只是前 10，
		// 页面要能说"最大的 10 个 / 共 20 个"（2026-09-25）。
		expect(w.setTowns).toHaveBeenCalledWith(
			[
				{ id: 9, population: 1500, x: 100, y: 200 },
				{ id: 12, population: 800, x: 150, y: 180 },
			],
			20,
		);
	});

	it_("GS state 不带总数时传 undefined（不覆盖已已知的总数）", () => {
		const w = fakeWorld();
		const hub = makeSignalHub({
			world: w as never, getWeb: () => null, getSession: () => null,
			routeLedger: fakeLedger() as never, getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
		hub.onEvent({
			kind: "gamescript",
			payload: { cmd: "state", date: 1, town_list: [{ id: 1, pop: 2, x: 3, y: 4 }] },
		} as unknown as GameEvent);
		expect(w.setTowns).toHaveBeenCalledWith([{ id: 1, population: 2, x: 3, y: 4 }], undefined);
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

describe("GS state：产业/货种/公司口径（P1+P2）", () => {
	function hub(w: unknown) {
		return makeSignalHub({
			world: w as never, getWeb: () => null, getSession: () => null,
			routeLedger: fakeLedger() as never, getDecisionCount: () => 0,
			onPhaseChange: () => {}, onNotableEvent: () => {},
		});
	}

	it_("industry_list/cargo_totals 写入 world（GS 原始计数，比率不在这里算）", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: {
				cmd: "state", date: 1, industries: 37,
				industry_list: [{ id: 5, cargo: "COAL", name: "Coal Mine", produced: 900, transported: 600, stock: 120 }],
				cargo_totals: [{ label: "COAL", produced: 900, transported: 600 }],
			},
		} as unknown as GameEvent);
		expect(w.setIndustries).toHaveBeenCalledWith(
			[{ id: 5, cargo: "COAL", name: "Coal Mine", produced: 900, transported: 600, stock: 120 }],
			37,
		);
		expect(w.setCargoTotals).toHaveBeenCalledWith([{ label: "COAL", produced: 900, transported: 600 }]);
	});

	it_("transported 的 -1 是「不适用」→ null（D60：折成 0 是搰造「运了 0 吨」）", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: {
				cmd: "state", date: 1, industries: 1,
				industry_list: [{ id: 5, cargo: "COAL", name: "Coal Mine", produced: 900, transported: -1, stock: -1 }],
				cargo_totals: [{ label: "COAL", produced: 900, transported: -1 }],
			},
		} as unknown as GameEvent);
		expect(w.setIndustries).toHaveBeenCalledWith(
			[{ id: 5, cargo: "COAL", name: "Coal Mine", produced: 900, transported: null, stock: null }],
			1,
		);
		expect(w.setCargoTotals).toHaveBeenCalledWith([{ label: "COAL", produced: 900, transported: null }]);
	});

	it_("transported/produced 缺席 → null（缺席 ≠ 0）", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: { cmd: "state", date: 1, industries: 1,
				industry_list: [{ id: 5, cargo: "COAL", name: "Coal Mine", stock: 120 }] },
		} as unknown as GameEvent);
		expect(w.setIndustries).toHaveBeenCalledWith(
			[expect.objectContaining({ produced: null, transported: null })], 1,
		);
	});

	it_("城镇 tc 的 transported -1 → null（不是 0）", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: { cmd: "state", date: 1, towns: 1,
				town_list: [{ id: 2, pop: 100, x: 1, y: 2, name: "Foo", tc: [{ label: "PASS", produced: 30, transported: -1 }] }] },
		} as unknown as GameEvent);
		expect(w.setTowns).toHaveBeenCalledWith(
			[expect.objectContaining({ name: "Foo", cargo: [{ label: "PASS", produced: 30, transported: null }] })],
			1,
		);
	});

	it_("own_delivered/own_quarter/own_monitored 写入公司口径（缺失时为 null，不编 0）", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: {
				cmd: "state", date: 1,
				own_delivered: [{ label: "PASS", amount: 120 }],
				own_quarter: 5000,
				own_monitored: { towns: 10, industries: 0 },
			},
		} as unknown as GameEvent);
		expect(w.setCompanyCargo).toHaveBeenCalledWith({
			byCargo: [{ label: "PASS", amount: 120 }],
			quarterDelivered: 5000,
			monitored: { towns: 10, industries: 0 },
		});
	});

	it_("完全没有这些字段时不调用 setter（老 GS/新 harness 混跑也不能清空已有事实）", () => {
		const w = fakeWorld();
		hub(w).onEvent({ kind: "gamescript", payload: { cmd: "state", date: 1, towns: 1, town_list: [] } } as unknown as GameEvent);
		expect(w.setIndustries).not.toHaveBeenCalled();
		expect(w.setCargoTotals).not.toHaveBeenCalled();
		expect(w.setCompanyCargo).not.toHaveBeenCalled();
	});

	it_("城镇带主货种 tc 时解析成 cargo 数组", () => {
		const w = fakeWorld();
		hub(w).onEvent({
			kind: "gamescript",
			payload: { cmd: "state", date: 1, towns: 1,
				town_list: [{ id: 2, pop: 100, x: 1, y: 2, tc: [{ label: "PASS", produced: 30, transported: 12 }] }] },
		} as unknown as GameEvent);
		// 第二个实参是 GS 报的城镇总数（载荷里 towns: 1）
		expect(w.setTowns).toHaveBeenCalledWith([
			{ id: 2, population: 100, x: 1, y: 2, cargo: [{ label: "PASS", produced: 30, transported: 12 }] },
		], 1);
	});
});

/**
 * 线路读数的**去重字段**必须活着传到 harness（2026-09-25 真机：25 辆车被报成 129）。
 *
 * 机制：GS 按"停在这条线两端站上的车"计数，而车站服务多条线路 ⇒ 同一辆车被每条线各数
 * 一次。只有车辆 id 与站号到了 harness，页面才可能去重；这里锁住"字段没在管道里被丢掉"。
 */
describe("route-stats 去重字段（vehiclesIds / endsA / endsB / waitA / waitB）", () => {
	function feed(fields: Record<string, unknown>) {
		const hub = makeSignalHub({
			world: fakeWorld() as never,
			getWeb: () => null,
			getSession: () => null,
			routeLedger: fakeLedger() as never,
			getDecisionCount: () => 0,
			onPhaseChange: () => {},
			onNotableEvent: () => {},
		});
		hub.onEvent({
			seq: 1,
			kind: "gamescript",
			ts: 1,
			payload: { kind: "route-stats", job: 100, vehicles: 3, profit: 10, waiting: 30, gameDate: 712300, ...fields },
		} as never);
		return hub.getRouteStats()[0];
	}

	it_("新 GS：id 与站号原样保留", () => {
		const r = feed({ vehiclesIds: [11, 12, 13], endsA: 4, endsB: 8, waitA: 20, waitB: 10 });
		expect(r!.vehiclesIds).toEqual([11, 12, 13]);
		expect(r!.endsA).toBe(4);
		expect(r!.endsB).toBe(8);
		expect(r!.waitA).toBe(20);
		expect(r!.waitB).toBe(10);
	});

	it_("旧 GS（没有这些字段）→ 字段缺席，vehicles/waiting 照旧可用（兼容老 GS/新 harness 混跑）", () => {
		const r = feed({});
		expect(r!.vehicles).toBe(3);
		expect(r!.waiting).toBe(30);
		expect(r!.vehiclesIds).toBeUndefined();
		expect(r!.endsA).toBeUndefined();
	});
});
