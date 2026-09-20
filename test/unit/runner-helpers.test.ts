import { describe, expect, it } from "vitest";
import * as RH from "../../src/agent/runner-helpers.js";

const { savegameName, totalsFromTelemetry } = RH as unknown as {
	savegameName: (id: string) => string;
	totalsFromTelemetry: (prev: unknown, t: unknown, events: number) => {
		usage: { peakRequestTokens?: number; peakRequestTurn?: number | null };
	};
};

/**
 * 每局结束的存档名（2026-09-16，项目所有者要求"能在 OpenTTD 里载入观看结果"）。
 * 名子来自 session id（形如 20260916-154854-seed7），必须对文件系统安全。
 */
describe("savegameName —— 存档文件名净化", () => {
	it("session id 原样可用", () => {
		expect(savegameName("20260916-154854-seed7")).toBe("20260916-154854-seed7");
	});

	it("危险字符被替换（不得路径穿越 / 空格 / 引号进入 rcon）", () => {
		expect(savegameName("../../etc/passwd")).not.toContain("/");
		expect(savegameName('a b"c')).not.toMatch(/[\s"]/);
		expect(savegameName("x; rcon evil")).not.toContain(";");
	});

	it("空/全非法输入有兜底名（不产生空文件名）", () => {
		expect(savegameName("")).toBe("game");
		expect(savegameName("///")).toBe("game");
	});
});

/**
 * G6：峰值请求大小必须从实时遥测**真的**传到会话总计里。
 *
 * 为什么用测试而不是把字段设成必填：必填只能让"没填"变成编译错误，
 * 而 `SessionTotals` 是从**磁盘上的历史 JSON** 读回来的——把字段设成必填只会让
 * 旧记录不合法（旧 metric 行本来就没有这个字段）。所以读取侧宽容、
 * **生产侧由这里的断言钉住**。
 */
describe("totalsFromTelemetry —— G6 峰值请求大小", () => {
	function snap(peak: { tokens: number; turn: number | null }) {
		return {
			usage: {
				total: {
					input: 1,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: 0,
					totalTokens: 3,
					costTotal: 0,
				},
				peakRequest: peak,
				byTurn: [],
				byTool: [],
			},
			totals: { decisions: 1, messages: 1, toolCalls: 0, toolFailures: 0 },
		};
	}

	it("把遥测里的峰值（含所在 turn）带进总计", () => {
		const t = totalsFromTelemetry(null, snap({ tokens: 41234, turn: 7 }), 3);
		expect(t.usage.peakRequestTokens).toBe(41234);
		expect(t.usage.peakRequestTurn).toBe(7);
	});

	it("没测到时为 0 / null（不是省略、也不是编造一个数）", () => {
		const t = totalsFromTelemetry(null, snap({ tokens: 0, turn: null }), 0);
		expect(t.usage.peakRequestTokens).toBe(0);
		expect(t.usage.peakRequestTurn).toBeNull();
	});
});
