import { describe, expect, it } from "vitest";
import { savegameName } from "../../src/agent/runner-helpers.js";

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
