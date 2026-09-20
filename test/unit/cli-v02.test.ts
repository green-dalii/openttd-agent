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

	/**
	 * M3-1（2026-09-19）：`--shrink-to` 是双向探针的入口。
	 *
	 * 这里只锁**解析**（行为由真机探针量）。理由：本项目为"门禁看得到、runner 收不到"
	 * 付过代价（MEMORY A5）——新 flag 必须同时被解析**并**被转发到 v02 参数对象。
	 */
	it("--shrink-to 被解析", () => {
		expect(parseArgs(["--v02", "--add-vehicles", "12", "--shrink-to", "4"]).shrinkTo).toBe(4);
	});
	it("--shrink-to 不给则不出现", () => {
		expect((parseArgs(["--v02"]) as unknown as { shrinkTo?: number }).shrinkTo).toBeUndefined();
	});
	it("--shrink-to 非整数报错", () => {
		expect(() => parseArgs(["--v02", "--shrink-to", "abc"])).toThrow();
	});
});
