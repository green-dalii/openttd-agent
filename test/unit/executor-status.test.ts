/**
 * executor-status: 把执行器的电报体阶段翻译成 agent 能理解的事实。
 *
 * 职责：锁定 {阶段字符串 → 结构化事实 + 叙述} 的映射，以及心跳折叠。
 * 禁止：在此断言"agent 该怎么做"。这里只验证**翻译是否忠实**。
 */
import { describe, expect, it } from "vitest";
import { decodeExecutorPhase, decodePhaseWindow, phaseIdentity } from "../../src/game/executor-status.js";

describe("executor-status: 阶段词汇表解码", () => {
	it("剥掉 EX 前缀与 j<job> 后缀，并认出 job", () => {
		const d = decodeExecutorPhase("EX rd s0 r0 j100");
		expect(d.phase).toBe("rd s0 r0");
		expect(d.job).toBe(100);
		expect(d.stage).toBe("road");
		expect(d.raw).toBe("EX rd s0 r0 j100");
	});

	it("每次输出都带一句可读叙述（绝不返回空叙述）", () => {
		const samples = [
			"EX boot j-1",
			"EX work j100",
			"EX stA_ok j100",
			"EX road_start j100",
			"EX rd s0 r0 j100",
			"EX rd retry3 j100",
			"EX rd layr2 j100",
			"EX road seg1 d20 j100",
			"EX road_built j100",
			"EX road_stuck j100",
			"EX road_nofront j100",
			"EX dpt_ok j100",
			"EX bus_noeng j100",
			"EX fleet_noveh j100",
			"EX done stN2 r1 bus j100",
			"EX hb road #11 j100",
			"EX exc:whatever j100",
		];
		for (const s of samples) {
			const d = decodeExecutorPhase(s);
			expect(d.description.length, s).toBeGreaterThan(10);
			expect(d.stage, s).not.toBe("unknown");
		}
	});

	it("road 阶段的分段/重试被解成数字，而不是留在字符串里", () => {
		const d = decodeExecutorPhase("EX rd s3 r7 j100");
		expect(d.detail).toEqual({ segment: 3, retry: 7 });
		// 关键：要说明"这是进行中，不是失败"，否则 agent 会把搜索当成卡死
		expect(d.description).toMatch(/search|progress/i);
		expect(d.error).toBe(false);
	});

	it("road_stuck / road_nofront 标记为错误（agent 必须能区分'卡住'与'在忙'）", () => {
		expect(decodeExecutorPhase("EX road_stuck j100").error).toBe(true);
		expect(decodeExecutorPhase("EX road_nofront j100").error).toBe(true);
		expect(decodeExecutorPhase("EX exc:boom j100").error).toBe(true);
		// 在忙 ≠ 失败
		expect(decodeExecutorPhase("EX rd s0 r0 j100").error).toBe(false);
		expect(decodeExecutorPhase("EX hb road #3 j100").error).toBe(false);
	});

	it("站点槽位与结果都解出来（stA_ok 不是 st 的某个编号）", () => {
		const a = decodeExecutorPhase("EX stA_ok j100");
		expect(a.detail).toEqual({ slot: "A", outcome: "ok" });
		expect(a.description).toMatch(/A/);
		const b = decodeExecutorPhase("EX stB_giveup j100");
		expect(b.detail).toEqual({ slot: "B", outcome: "giveup" });
	});

	it("done 报出真实计数，并说明执行器此后不再自行动作", () => {
		const d = decodeExecutorPhase("EX done stN2 r1 nobus j100");
		expect(d.detail).toEqual({ stations: 2, roadSegments: 1, vehicles: "nobus" });
		expect(d.description).toMatch(/no vehicle/i);
		// "它不会再自己开始新东西"是**事实**，不是建议 —— agent 必须知道这点才能决定要不要下指令
		expect(d.description).toMatch(/idle|further/i);
	});

	it("心跳被标成 heartbeat 且明说没有状态变化", () => {
		const d = decodeExecutorPhase("EX hb road #11 j100");
		expect(d.heartbeat).toBe(true);
		expect(d.stage).toBe("heartbeat");
		expect(d.detail).toEqual({ innerStage: "road", beat: 11 });
		expect(d.description).toMatch(/alive|no state change/i);
	});

	it("未知阶段保留原文并标 unknown —— 不猜含义", () => {
		const d = decodeExecutorPhase("EX some_future_thing j100");
		expect(d.stage).toBe("unknown");
		expect(d.phase).toBe("some_future_thing");
		expect(d.description).toContain("some_future_thing");
	});

	it("车辆遥测被解成车在干什么，不是一串数字", () => {
		// done 之后的阶段全部来自 DumpBus()。不解码的话，agent 在整个运营期
		// 看到的都是 "EX R53 d33 a24 #17 j100" 这种噪声。
		const d = decodeExecutorPhase("EX R53 d33 a24 #17 j100");
		expect(d.stage).toBe("vehicle");
		expect(d.detail).toMatchObject({ vehicleState: "running", speed: 53, tilesFromStationA: 33, waitingAtStationA: 24 });
		expect(d.description).toMatch(/running/i);
		expect(d.description).toMatch(/speed 53/);
		expect(d.description).toMatch(/24 passenger/);
		expect(d.error).toBe(false);
	});

	it("故障车被标成 error —— 它不是在忙，是不赚钱", () => {
		const b = decodeExecutorPhase("EX B0 d12 a0 #3 j100");
		expect(b.error).toBe(true);
		expect(b.description).toMatch(/broken down/i);
		const c = decodeExecutorPhase("EX X0 d1 a0 #4 j100");
		expect(c.error).toBe(true);
		expect(c.description).toMatch(/crashed/i);
	});

	it("候客数不可得时如实说，不编造 0", () => {
		const d = decodeExecutorPhase("EX R10 d5 a-1 #2 j100");
		expect(d.description).toMatch(/unavailable/i);
	});

	it("位置探针解出坐标与脚下是什么", () => {
		const d = decodeExecutorPhase("EX @62,136 station d0 j100");
		expect(d.stage).toBe("vehicle");
		expect(d.detail).toMatchObject({ x: 62, y: 136, onTile: "station" });
		// "other" 意味着车不在路网上了 —— 必须说出来
		expect(decodeExecutorPhase("EX @12,34 other d9 j100").description).toMatch(/not road/i);
	});

	it("空输入不炸，且不给假信息", () => {
		const d = decodeExecutorPhase("");
		expect(d.stage).toBe("unknown");
		expect(d.description).toMatch(/no executor phase/i);
	});
});

describe("executor-status: 心跳折叠（防止 40 条相同事实淹没变化）", () => {
	it("连续心跳折叠成一句，附在它前面那个真实阶段上", () => {
		const out = decodePhaseWindow([
			"EX work j100",
			"EX road_start j100",
			"EX hb road #1 j100",
			"EX hb road #2 j100",
			"EX hb road #3 j100",
			"EX road seg1 d20 j100",
		]);
		// work / road_start / seg1 —— 三条心跳不单独成条
		expect(out).toHaveLength(3);
		expect(out[1]!.phase).toBe("road_start");
		expect(out[1]!.description).toMatch(/3 heartbeat/);
		expect(out[2]!.phase).toBe("road seg1 d20");
	});

	it("全是心跳时仍要报一条，让调用方知道执行器还活着", () => {
		const out = decodePhaseWindow(["EX hb boot #1 j100", "EX hb boot #2 j100"]);
		expect(out).toHaveLength(1);
		expect(out[0]!.heartbeat).toBe(true);
	});

	it("空窗口返回空数组", () => {
		expect(decodePhaseWindow([])).toEqual([]);
	});

	it("没有心跳时不改动任何叙述", () => {
		const out = decodePhaseWindow(["EX boot j-1", "EX work j100"]);
		expect(out.map((p) => p.phase)).toEqual(["boot", "work"]);
		expect(out[0]!.description).not.toMatch(/heartbeat/);
	});
});

describe("phaseIdentity — 心跳不是「变化」（2026-09-12，代价：整整一轮 M3）", () => {
	// 真实事故：执行器把状态汇报写在**公司名**里，而 runner 用
	// `p.name !== executorPhase` 判断"阶段变了没有"。
	//
	// 心跳格式是 `hb <stage> #<seq> s<signs>`，seq **每轮自增** ——
	// 于是每一拍都是一个"新字符串"，每一次心跳都触发一次决策。
	//
	// 实测（/tmp/m3b）：212 次决策里 **197 次由 heartbeat 触发**，
	// 每局约 36 次决策，其中 83% 的间隔里 money 一分钱没动。
	// 后果：87% 的工具调用是 observe、218 次重复同一句 plan、5 次重复下发
	// build_bus_route（因为 agent 不知道上一次成功了没有）。
	//
	// 心跳的语义**恰恰是**"什么都没发生，我还活着"。把它当成变化信号，
	// 等于用"没有新闻"去触发一次新闻发布。
	it("同一阶段的心跳序列号递增 → 同一个 identity", () => {
		expect(phaseIdentity("EX hb road #28 s3 j1")).toBe(phaseIdentity("EX hb road #29 s3 j1"));
		expect(phaseIdentity("EX hb boot #1 s0 j-1")).toBe(phaseIdentity("EX hb boot #2 s0 j-1"));
	});

	it("阶段真的变了 → identity 不同", () => {
		expect(phaseIdentity("EX hb boot #9 s0 j1")).not.toBe(phaseIdentity("EX hb road #9 s3 j1"));
	});

	it("标牌数变化是有意义的，不能被抹掉", () => {
		expect(phaseIdentity("EX hb road #9 s3 j1")).not.toBe(phaseIdentity("EX hb road #9 s4 j1"));
	});

	it("非心跳阶段原样保留", () => {
		// 重试计数器 r<k> 也是计数器：同一段路重试 40 次是**一个**局面（卡住了），
// 不是 40 条新闻。
		expect(phaseIdentity("EX rd s1 r0 d104 p0 j1")).toBe(phaseIdentity("EX rd s1 r40 d104 p0 j1"));
		expect(phaseIdentity("EX rd s1 r0 d104 p0 j1")).toBe("EX rd s1 d104 p0 j1");
		expect(phaseIdentity("EX done stN2 r63 bus j1")).toBe("EX done stN2 r63 bus j1");
	});

	it("不同阶段的进度变化仍然是变化", () => {
		expect(phaseIdentity("EX rd s0 r0 d104 j1")).not.toBe(phaseIdentity("EX rd s1 r0 d104 j1"));
	});

	it("测试必须用真实观测到的字符串（带尾部 j<money>）", () => {
		// 教训：第一版测试用的是我自己**臆想**的格式 `EX hb road #28 s3`，
		// 而真实格式是 `EX hb road #28 s3 j1`。测试全绿，修复却毫无作用
		// （复测：心跳仍触发 28 次）。**断言必须建立在真实样本上。**
		const real = [
			"EX hb boot #1 s0 j-1",
			"EX hb road #28 s3 j1",
			"EX hb road #29 s3 j1",
			"EX rd s1 r0 d104 p0 j1",
			"EX done stN2 r63 bus j1",
		];
		expect(phaseIdentity(real[1]!)).toBe(phaseIdentity(real[2]!));
		expect(phaseIdentity(real[3]!)).toBe("EX rd s1 d104 p0 j1");
		expect(phaseIdentity(real[4]!)).toBe(real[4]);
	});
});
