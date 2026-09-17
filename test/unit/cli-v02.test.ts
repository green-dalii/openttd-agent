import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/run.js";

describe("--freeze 解析（SPEC §10.59）", () => {
	it("--freeze → true", () => {
		expect(parseArgs(["--agent", "--freeze"]).freeze).toBe(true);
	});
	it("不给 → false（默认不暂停）", () => {
		expect(parseArgs(["--agent"]).freeze).toBe(false);
	});
});

describe("v02 --add-vehicles 解析（baseline probe 用，2026-09-17）", () => {
	it("--add-vehicles N 解析为数字", () => {
		expect(parseArgs(["--v02", "--add-vehicles", "20"]).addVehicles).toBe(20);
	});
	it("不给则不出现", () => {
		expect((parseArgs(["--v02"]) as unknown as { addVehicles?: number }).addVehicles).toBeUndefined();
	});
	it("非整数报错", () => {
		expect(() => parseArgs(["--v02", "--add-vehicles", "abc"])).toThrow();
	});
});
