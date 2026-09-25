/**
 * 世界时钟的**通道**（2026-09-25 真机取证后修的既有缺陷）。
 *
 * 现象：页面 health 条长期显示 `WORLD frozen — no new game date in the last 90s`，
 * 而事件流证明世界每 ~6 秒推进一次（截图 + events.jsonl 双向确认）。
 *
 * 根因（不是猜的，是量出来的）：admin port 的 DATE 包按 **Monthly** 订阅
 * （`admin-client.ts` 的 `DEFAULT_SUBSCRIBE`），真实 90 秒的一局只收到 **1** 个
 * date 事件。而页面 `worldRate()` 的判据就是"最近 90 s 内有没有新 date 事件" ——
 * 于是它**结构性地**永远为假。一个按月刷新的通道被当成了"当前时间"。
 *
 * 同一个字段还喂给 agent 自己的 `observe` 工具（`tools/index.ts` 读
 * `snap.date`），所以模型看到的世界时间也停在连接那一刻 —— 这是**给智能体的事实
 * 错误**，不只是页面瑕疵。
 *
 * 修法：Bridge GS 的 `GSDate` 每 200 script tick（约 6 s）报一次真实日期，它才是
 * 可用的细粒度来源；hub 在日期**变化**时把它变成一个真正的 `date` 事件，走与
 * 收包完全相同的三条路径（world / page / 归档）。WorldState 侧只有一个写者，
 * 且**单调**：较旧的读数（含月度 admin 包）不得把日期往回滚。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorldState } from "../../src/game/world-state.js";
import { makeSignalHub, type SignalHubRefs } from "../../src/agent/signal-hub.js";
import type { GameEvent } from "../../src/types.js";

function dateEvent(raw: number, year: number, month: number, day: number, ts: number): GameEvent {
	return { seq: 1, kind: "date", ts, payload: { raw, year, month, day } } as unknown as GameEvent;
}

function gsState(raw: number): GameEvent {
	return { seq: 2, kind: "gamescript", ts: Date.now(), payload: { cmd: "state", date: raw } } as unknown as GameEvent;
}

describe("世界时钟：WorldState 是 date 的唯一写者，且单调", () => {
	it("setDateFromRaw 换算并写入 y/m/d（GS 通道只给 raw 天数）", () => {
		const w = new WorldState();
		// 真机读数（2026-09-25，seed 7 的第 6 个游戏日附近）：GS 报 raw=712231
		// 换算为 1950-01-09。`convertDateToYmd` 的 year 是"距 1920 纪元的整年数"，
		// 在 1950 开局恰好等于日历年（1920 开局会显示 0 —— 既有边界，不在本次范围）。
		w.setDateFromRaw(712_231);
		expect(w.snapshot().date).toMatchObject({ raw: 712_231, year: 1950, month: 1, day: 9 });
		// 加 30 天必须落到下个月同一日（换算而非原样透传）
		w.setDateFromRaw(712_231 + 30);
		expect(w.snapshot().date).toMatchObject({ raw: 712_261, year: 1950, month: 2, day: 8 });
	});

	it("较旧的读数被丢弃：月度 admin 包不得把日期往回滚", () => {
		const w = new WorldState();
		w.ingest(dateEvent(100, 1920, 4, 11, 1_000));
		expect(w.snapshot().date?.raw).toBe(100);
		// 乱序到达的旧包（真实网络里会发生）
		w.ingest(dateEvent(40, 1920, 2, 11, 2_000));
		expect(w.snapshot().date?.raw).toBe(100);
		// 同样旧的值走 GS 通道也不行
		w.setDateFromRaw(40);
		expect(w.snapshot().date?.raw).toBe(100);
	});

	it("非有限值被忽略（不写坏事实）", () => {
		const w = new WorldState();
		w.ingest(dateEvent(100, 1920, 4, 11, 1_000));
		w.setDateFromRaw(Number.NaN);
		w.setDateFromRaw(Number.POSITIVE_INFINITY);
		expect(w.snapshot().date?.raw).toBe(100);
	});
});

describe("世界时钟：hub 把 GS 时钟变成真正的 date 事件", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function makeHub() {
		const world = new WorldState();
		const published: GameEvent[] = [];
		const archived: GameEvent[] = [];
		const hub = makeSignalHub({
			world,
			getWeb: () => ({ publishEvent: (e: GameEvent) => published.push(e) }),
			getSession: () => ({ appendEvent: (e: GameEvent) => archived.push(e) }),
			routeLedger: { record: () => {}, all: () => [], markDone: () => {} },
			getDecisionCount: () => 0,
			onPhaseChange: () => {},
			onNotableEvent: () => {},
		} as unknown as SignalHubRefs);
		return { hub, world, published, archived };
	}

	it("GS 日期变化 → world.date 更新 + 页面收到 date 事件 + 归档里有它", () => {
		const { hub, world, published, archived } = makeHub();
		hub.onEvent(gsState(712_231));
		expect(world.snapshot().date?.raw).toBe(712_231);
		const dates = published.filter((e) => e.kind === "date");
		expect(dates).toHaveLength(1);
		expect((dates[0]!.payload as { source?: string }).source).toBe("gs");
		expect(archived.filter((e) => e.kind === "date")).toHaveLength(1);
	});

	it("同一个日期重复上报 → 不再产生事件（否则 4/s 的 state 会把事件流灌满）", () => {
		const { hub, published } = makeHub();
		hub.onEvent(gsState(712_231));
		hub.onEvent(gsState(712_231));
		hub.onEvent(gsState(712_231));
		expect(published.filter((e) => e.kind === "date")).toHaveLength(1);
	});

	it("日期推进 → 事件流里的 date 事件像真实世界时钟一样前进（页面的速率判据靠它）", () => {
		const { hub, published } = makeHub();
		vi.setSystemTime(1_000_000);
		hub.onEvent(gsState(712_231));
		vi.setSystemTime(1_006_000);
		hub.onEvent(gsState(712_232));
		const dates = published.filter((e) => e.kind === "date") as Array<GameEvent & { ts: number }>;
		expect(dates).toHaveLength(2);
		// 相邻 6 s —— 正是真机实测的节奏（健康世界 max 6.0 s）
		expect(dates[1]!.ts - dates[0]!.ts).toBe(6_000);
	});

	it("世界时钟与 W2 的冻结时钟是同一事实：最后一次推进时刻随之更新", () => {
		const { hub } = makeHub();
		hub.onEvent(gsState(712_231));
		const first = hub.getWorldClock().lastAdvancedAtMs;
		vi.setSystemTime(1_030_000);
		hub.onEvent(gsState(712_231)); // 没变
		expect(hub.getWorldClock().lastAdvancedAtMs).toBe(first);
		vi.setSystemTime(1_036_000);
		hub.onEvent(gsState(712_232)); // 变了
		expect(hub.getWorldClock().lastAdvancedAtMs).toBe(1_036_000);
	});
});
