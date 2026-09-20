/**
 * executor-status: 把执行器的电报体阶段翻译成 agent 能理解的事实。
 *
 * 职责：锁定 {阶段字符串 → 结构化事实 + 叙述} 的映射，以及心跳折叠。
 * 禁止：在此断言"agent 该怎么做"。这里只验证**翻译是否忠实**。
 */
import { describe, expect, it } from "vitest";
import {
	decodeExecutorPhase,
	decodePhaseWindow,
	isErrorPhase,
	phaseStage,
} from "../../src/game/executor-status.js";

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
			"EX fleet_nodepot j100",
			"EX fleet_wait4 j100",
			"EX retire7C14 j100",
			"EX fleet_unknown102 j100",
			"EX fleet_retired101 j100",
			"EX retire_unknown102 j100",
			"EX fleetg12L12C14 j100",
			"EX fleets4L4s8f0C7 j100",
			"EX fleetok4C4 j100",
			"EX fleetsend8C14 j100",
			"EX fleetsold1g4w3b0C9 j100",
			"EX fleet_wait4c12L12 j100",
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

describe("phaseStage/isErrorPhase — 新闻门（2026-09-12，代价：整整一轮 M3）", () => {
	// 三轮实测（SPEC §10.34/§10.35/§10.35.1）：任何对 phase **字符串**的等值比较，
	// 最终都会被"永远在变的字段"击穿 —— 心跳序号、重试计数、花钱都会改变字符串。
	// 唯一稳定的语义单位是**阶段**（stage）：boot → work → road → done。
	//
	// 真实序列（/tmp/hbfix3）：119 个 phase 字符串只对应 7 个真实局面。
	// fixture 全部取自真实日志，不用臆想格式（A9 的教训：臆想格式让第一版修复静默失效）。
	const real = {
		bootBeat1: "EX hb boot #1 s0 j-1",
		bootBeat2: "EX hb boot #2 s0 j-1",
		roadBeat1: "EX hb road #5 s3 j100",
		roadBeat2: "EX hb road #28 s3 j100",
		lay0: "EX rd s0 r0 d144 p0 j100",
		lay40: "EX rd s0 r40 d144 p0 j100",
		lay1: "EX rd s1 r0 d104 p0 j100",
		stuck: "EX road_stuck j100",
		done: "EX done stN2 r63 bus j100",
	};

	it("同一阶段内的计数器变化 → 同一 stage（不是新闻）", () => {
		expect(phaseStage(real.roadBeat1!)).toBe(phaseStage(real.roadBeat2!));
		// 同一段路重试 40 次是**一个**局面（卡住了），不是 40 条新闻
		expect(phaseStage(real.lay0!)).toBe(phaseStage(real.lay40!));
		// 心跳与进度交替，也不该互相触发
		expect(phaseStage(real.roadBeat2!)).toBe(phaseStage(real.lay0!));
	});

	it("阶段真的变了 → 新闻", () => {
		expect(phaseStage(real.bootBeat1!)).not.toBe(phaseStage(real.roadBeat1!));
		// rd 归并进 road：铺路进度（换段）仍是同阶段，不唤醒
		expect(phaseStage(real.lay1!)).toBe(phaseStage(real.lay0!));
		expect(phaseStage(real.done!)).toBe("done");
		expect(phaseStage(real.done!)).not.toBe(phaseStage(real.roadBeat1!));
	});

	it("失败阶段总是新闻（即使 stage 没变）", () => {
		expect(isErrorPhase(real.stuck!)).toBe(true);
		expect(isErrorPhase("EX dpt_nowhere j100")).toBe(true);
		expect(isErrorPhase("EX exc:pathfinder blew up")).toBe(true);
		expect(isErrorPhase("EX bus_buy_e: no money")).toBe(true);
	});

	it("正常阶段不是错误", () => {
		expect(isErrorPhase(real.done!)).toBe(false);
		expect(isErrorPhase(real.roadBeat1!)).toBe(false);
		expect(isErrorPhase(real.lay0!)).toBe(false);
	});
});

/**
 * G3（可归因）：`add_vehicles` 静默无效必须变成**可观测的拒绝**。
 *
 * 实测（SPEC §10.67 第 4 层）：agent 请求车队 10/15（同一请求重复 8 次），
 * 而 6 局里 5 局最终车队仍是 6。原因是 executor 的 `CheckAddVehicles` 只对自己
 * **当前 job** 应用 `V` 请求（`if (job != this._job) continue;`），**跳过时一句
 * 话都不说**。这违反本项目自己的铁律："工具必须能观测自身效果或明确拒绝"。
 * 修法：executor 在跳过时给出诚实信号 `fleet_otherjob`，harness 解码后送到 agent。
 */
/**
 * M3-1b（SPEC §10.84）：请求被**推迟**（执行器正在施工）与"没有头车可克隆"
 * 都必须是具名信号。否则模型只能看到"我请求了、什么都没变"，并据此学到
 * "请求车队没用"这种**错误因果**（D20 同源）。
 */
describe("M3-1b: 卖出相位要把「卖出」与「消失」分开", () => {
	it("fleetsold1g4w3b0C9：卖出 1 辆、4 辆消失、3 辆还在路上、公司 9 辆", () => {
		const d = decodeExecutorPhase("EX fleetsold1g4w3b0C9 j101");
		expect(d.stage).toBe("fleet");
		expect(d.description).toMatch(/sold 1/);
		expect(d.description).toMatch(/4 disappeared/);
		expect(d.description).toMatch(/owns 9/);
	});

	it("没有消失时不提消失（g0 不该被读成异常）", () => {
		const d = decodeExecutorPhase("EX fleetsold2g0w0b0C4 j101");
		expect(d.description).toMatch(/sold 2/);
		expect(d.description).not.toMatch(/disappeared/);
	});
});

describe("M3-2c: 车队请求对「未知/已退役」线路必须具名拒绝", () => {
	it("fleet_unknown102：执行器不认识这条线路（本局没建过）", () => {
		const d = decodeExecutorPhase("EX fleet_unknown102 j101");
		expect(d.stage).toBe("fleet");
		expect(d.description).toMatch(/no record|built itself|unknown/i);
		expect(d.description).not.toMatch(/state "/);
	});

	it("fleet_retired101：线路已退役，调车队没有意义", () => {
		const d = decodeExecutorPhase("EX fleet_retired101 j101");
		expect(d.stage).toBe("fleet");
		expect(d.description).toMatch(/retired/i);
		expect(d.description).not.toMatch(/state "/);
	});
});

describe("M3-2a: 退役相位", () => {
	it("retire7C14：说明退役已开始、几辆车被送去车库", () => {
		const d = decodeExecutorPhase("EX retire7C14 j101");
		expect(d.description).toMatch(/retire/i);
		expect(d.description).toMatch(/7/);
		expect(d.description).toMatch(/owns 14/);
		expect(d.description).not.toMatch(/state "/);
	});

	it("retire_unknown102：未知线路必须具名拒绝（不能说成已退役）", () => {
		const d = decodeExecutorPhase("EX retire_unknown102 j101");
		expect(d.description).toMatch(/no record|unknown|not.*known/i);
		expect(d.description).not.toMatch(/state "/);
	});
});

describe("M3-1b: 车队相位必须区分「克隆」与「卖出」两种行为", () => {
	it("fleetg12L12：说明是克隆到 12，并报出本线路车队条目数", () => {
		const d = decodeExecutorPhase("EX fleetg12L12 j101");
		expect(d.stage).toBe("fleet");
		expect(d.description).toMatch(/cloned/i);
		expect(d.description).not.toMatch(/sold/i);
	});

	it("fleets4L4s8f0C7：说明卖出到 4、卖出/被拒数量，以及引擎里的公司车辆数", () => {
		const d = decodeExecutorPhase("EX fleets4L4s8f0C7 j101");
		expect(d.stage).toBe("fleet");
		expect(d.description).toMatch(/sold/i);
		expect(d.description).toMatch(/8/);
		// 引擎真值必须出现：它是"卖车是否真的生效"的唯一权威读数
		expect(d.description).toMatch(/owns 7/);
		expect(d.description).not.toMatch(/state "/);
	});

	it("fleetok4C4：已满足也要说话（静默与没处理无法区分）", () => {
		const d = decodeExecutorPhase("EX fleetok4C4 j101");
		expect(d.description).toMatch(/already satisfied/i);
		expect(d.description).toMatch(/owns 4/);
	});

	it("fleet_wait4c12L12：推迟时带上我们数到几辆", () => {
		const d = decodeExecutorPhase("EX fleet_wait4c12L12 j101");
		expect(d.description).toMatch(/deferred/i);
	});
});

describe("M3-1b: 车队请求被推迟 / 缺车库时也要说出来", () => {
	it("fleet_wait4：说明请求已被收到、只是要等到能应用的时候", () => {
		const d = decodeExecutorPhase("EX fleet_wait4 j101");
		expect(d.stage).toBe("fleet");
		expect(d.detail).toMatchObject({ outcome: "wait4" });
		// 必须让读者知道：请求**没有丢**，只是被推迟（与"拒绝"不同）。
		expect(d.description).toMatch(/deferred|not applied yet|waiting/i);
		// 关键：不能是泛型兜底（`vehicles: state "wait4".`）——那只是把 token 抄了一遍，
		// 对模型毫无因果信息。这条断言是本节存在的理由。
		expect(d.description).not.toMatch(/state "/);
	});

	it("fleet_nodepot：说明克隆需要车库，而车库还没建好", () => {
		const d = decodeExecutorPhase("EX fleet_nodepot j101");
		expect(d.stage).toBe("fleet");
		expect(d.description).toMatch(/depot/i);
		expect(d.description).not.toMatch(/state "/);
	});
});

describe("G3: 车队请求被跳过时必须说出来", () => {
	it("fleet_otherjob：报出请求针对的不是当前施工的线路", () => {
		const d = decodeExecutorPhase("EX fleet_otherjob j101");
		expect(d.stage).toBe("fleet");
		expect(d.description).toMatch(/different (job|route)|not the job/i);
		// 这是拒绝信号，不是错误崩溃：UI 需要能区分"被拒绝"与"坏了"。
		expect(d.description.length).toBeGreaterThan(20);
	});
});
