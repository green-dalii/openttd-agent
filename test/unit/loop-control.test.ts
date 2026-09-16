import { describe, expect, it } from "vitest";
import {
	shouldBreakOnDeadline,
	shouldBreakOnCap,
	waitUntilExpired,
	waitConditionMatches,
	isPhaseWorthRecording,
	emptyTrackerAfter,
} from "../../src/agent/loop-control.js";

/**
 * B-4a TDD: 决策循环里的纯判断器。
 *   acceptance = 这些函数抽出后 runner.ts 行为不变（gate 全绿）。
 *   不发明规则——边界都来自 runner.ts 当前的真机实测（§10.30 截止日、
 *   §10.35 heartbeat、§10.38 horizon、§10.39 FIFO）。
 */

describe("shouldBreakOnDeadline", () => {
	it("无 deadline、永不停止", () => {
		expect(shouldBreakOnDeadline({ deadline: null, seconds: 0 }, 1000, false)).toBe(false);
	});
	it("到点即停", () => {
		expect(shouldBreakOnDeadline({ deadline: 1000, seconds: 0 }, 1000, false)).toBe(true);
		expect(shouldBreakOnDeadline({ deadline: 1000, seconds: 0 }, 999, false)).toBe(false);
	});
	it("stopRequested 立即停", () => {
		expect(shouldBreakOnDeadline({ deadline: null, seconds: 0 }, 0, true)).toBe(true);
	});
});

describe("shouldBreakOnCap", () => {
	it("无 cap（<=0）= 永不封顶", () => {
		expect(shouldBreakOnCap(1000, 0)).toBe(false);
		expect(shouldBreakOnCap(1000, -1)).toBe(false);
	});
	it("count >  cap 停止", () => {
		expect(shouldBreakOnCap(11, 10)).toBe(true);
		expect(shouldBreakOnCap(10, 10)).toBe(false);
	});
});

describe("waitUntilExpired", () => {
	it("未设 wait → 不过期", () => {
		expect(waitUntilExpired({ waitUntil: null }, 100)).toBe(false);
	});
	it("达到 gameDays 后过期", () => {
		expect(waitUntilExpired({ waitUntil: { gameDays: 30, from: 0 } }, 30)).toBe(true);
		expect(waitUntilExpired({ waitUntil: { gameDays: 30, from: 0 } }, 29)).toBe(false);
		expect(waitUntilExpired({ waitUntil: { gameDays: 30, from: 50 } }, 80)).toBe(true);
	});
});

describe("waitConditionMatches", () => {
	it("空 condition 不匹配", () => {
		expect(waitConditionMatches("EX done stN2 r75 bus j100", null)).toBe(false);
		expect(waitConditionMatches("EX done stN2 r75 bus j100", "")).toBe(false);
	});
	it("大小写不敏感子串匹配", () => {
		expect(waitConditionMatches("EX done stN2 r75 bus j100", "done")).toBe(true);
		expect(waitConditionMatches("EX work j100", "work")).toBe(true);
		expect(waitConditionMatches("EX work j100", "done")).toBe(false);
	});
});

describe("isPhaseWorthRecording", () => {
	it("空串 / unknown 不记", () => {
		expect(isPhaseWorthRecording("")).toBe(false);
		expect(isPhaseWorthRecording("unknown")).toBe(false);
	});
	it("真机 raw 字符串都记", () => {
		expect(isPhaseWorthRecording("EX boot j-1")).toBe(true);
		expect(isPhaseWorthRecording("EX hb road #1 s3 j100")).toBe(true);
		expect(isPhaseWorthRecording("EX done stN2 r75 bus j100")).toBe(true);
	});
});

describe("emptyTrackerAfter", () => {
	it("重建 baseline + 清空列表", () => {
		const baseline = { money: 100, income: 0, vehicles: 0, stations: 0, gameDay: 0 };
		const t = emptyTrackerAfter(baseline);
		expect(t).toEqual({ baseline, phases: [], actions: [], notableEvents: [] });
	});
});