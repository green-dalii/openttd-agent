import { describe, expect, it } from "vitest";
import {
	ExecEventSchema,
	GsEventSchema,
	isGsEvent,
	type ExecEvent,
} from "../../src/game/gs-events.js";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import { decodeExecutorPhase } from "../../src/game/executor-status.js";

/**
 * Golden 样张 —— 全部来自真机运行日志（cal6/cal7/cal8/m3c-ctl2/m3c-trt1/trt3，
 * SPEC §10.40–§10.42），不做任何发明（AGENTS §5：invented format 曾让修复
 * 静默失败）。这是 A1 契约与 A2 GS 中继实现之间的对照基准。
 */

// 真机去重全集（grep phase="..." | sort -u）
const REAL_PHASES = [
	"EX boot j-1",
	"EX hb road #13 s6 j2",
	"EX rd s0 r0 d65 p0 j3",
	"EX rd s0 r0 d33 p1 j102",
	"EX @95,167 road d2 j2",
	"EX road seg1 d56 j3",
	"EX R56 d7 a4 #9 j101",
];

/** 过渡 shim 已随 A3 退役；golden 走 decodeExecutorPhase + schema 校验。 */
const expectExec = (raw: string): ExecEvent => {
	const d = decodeExecutorPhase(raw);
	const e = {
		kind: "exec" as const,
		stage: d.stage,
		job: d.job ?? -1,
		hb: d.heartbeat,
		raw,
		detail: d.detail ?? {},
	};
	if (!Check(GsEventSchema, e)) throw new Error(`schema rejected: ${JSON.stringify(e)}`);
	return e as ExecEvent;
};

describe("GS 事件契约 A1 —— golden 样张全部来自真机", () => {
	it("boot：job=-1，非心跳", () => {
		const e = expectExec("EX boot j-1");
		expect(e.stage).toBe("boot");
		expect(e.job).toBe(-1);
		expect(e.hb).toBe(false);
	});

	it("心跳：hb=true（决策门不得当新闻）", () => {
		const e = expectExec("EX hb road #13 s6 j2");
		expect(e.hb).toBe(true);
		expect(e.stage).toBe("heartbeat");
		expect(e.job).toBe(2);
		expect(e.detail).toMatchObject({ innerStage: "road", beat: 13, signs: 6 });
	});

	it("road 搜索/铺设计数器完整透传", () => {
		const e = expectExec("EX rd s0 r0 d65 p0 j3");
		expect(e.stage).toBe("road");
		expect(e.detail).toMatchObject({ segment: 0, retry: 0, distance: 65, probes: 0 });
	});

	it("车辆遥测（R56 d7 a4 #9）", () => {
		const e = expectExec("EX R56 d7 a4 #9 j101");
		expect(e.stage).toBe("vehicle");
		expect(e.job).toBe(101);
	});

	it("全部 7 条真机样张都通过 schema 且字段自洽", () => {
		for (const raw of REAL_PHASES) {
			const e = expectExec(raw);
			expect(e.raw).toBe(raw);
			expect(e.kind).toBe("exec");
			expect(typeof e.job).toBe("number");
			expect(typeof e.detail).toBe("object");
		}
	});

	it("done 事件：job 必填，gameDate 可选（账本回填）", () => {
		expect(Check(GsEventSchema, { kind: "done", job: 2, detail: {} })).toBe(true);
		expect(Check(GsEventSchema, { kind: "done", job: 2, gameDate: "1950-03-14" })).toBe(true);
		expect(Check(GsEventSchema, { kind: "done" })).toBe(false);
	});

	it("exec 事件拒绝未知 stage（契约不允许漂移）", () => {
		const bad = { kind: "exec", stage: "flying", job: 1, hb: false, raw: "x", detail: {} };
		expect(Check(ExecEventSchema, bad)).toBe(false);
	});

	it("isGsEvent type guard 拒绝任意垃圾", () => {
		expect(isGsEvent({ kind: "exec", stage: "road", job: 1, hb: false, raw: "x", detail: {} })).toBe(
			true,
		);
		expect(isGsEvent("hello")).toBe(false);
		expect(isGsEvent({ kind: "unknown-kind" })).toBe(false);
	});


	it("解码器修复锁定：hb/rd 新字段在旧格式下可选（向后兼容）", () => {
		// 旧格式无 s/d/p 后缀 —— detail 不得多出未观测字段
		const hbOld = expectExec("EX hb road #7 j2");
		expect(hbOld.detail).toEqual({ innerStage: "road", beat: 7 });
		const rdOld = expectExec("EX rd s1 r2 j100");
		expect(rdOld.detail).toEqual({ segment: 1, retry: 2 });
	});


	it("A3：GS 实发形状（无 detail）通过契约", () => {
		// 真机 calA2 实测 GS 发出的就是这五个字段（SPEC §10.45）
		expect(
			isGsEvent({ kind: "exec", stage: "heartbeat", job: -1, hb: true, raw: "EX hb boot #1 s0 j-1" }),
		).toBe(true);
	});
});

/**
 * NEXT-2 N2-1：线路经济事件。
 * golden 格式在实现时与 GS 发送端一一对应（首次真机运行后以真串复核，
 * 与 A1 同样的纪律：契约先立，真串回填）。
 */
describe("route-stats —— 线路经济事件契约", () => {
	it("接受 GS 将发送的扁平载荷（原始事实，无派生量）", () => {
		const ev = { kind: "route-stats", job: 101, vehicles: 2, profit: 5000, waiting: 7, gameDate: 1150 };
		expect(Check(GsEventSchema as TSchema, ev)).toBe(true);
		expect(isGsEvent(ev)).toBe(true);
	});

	it("负利润合法（亏钱线路必须能上报，否则只能看见好消息）", () => {
		expect(isGsEvent({ kind: "route-stats", job: 101, vehicles: 1, profit: -240, waiting: 0, gameDate: 1150 })).toBe(true);
	});

	it("缺字段被拒（无名线路经济不可用）", () => {
		expect(isGsEvent({ kind: "route-stats", job: 101, vehicles: 2 })).toBe(false);
	});

	it("类型错误被拒（字符串冒充数字）", () => {
		expect(isGsEvent({ kind: "route-stats", job: "101", vehicles: 2, profit: 1, waiting: 0, gameDate: 1 })).toBe(false);
	});
});
