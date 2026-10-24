/**
 * Game version parsing: the binary's version is run provenance.
 *
 * 为什么值得锁：同一个 seed 在不同 OpenTTD 版本上不是同一个世界，而版本号无法从
 * 配置推断（配置里只有二进制路径）。解析失败必须是 `null`（未知），不能是空串或
 * 上一局的版本——那会把"没测到"伪装成"一样"。
 */

import { describe, expect, it } from "vitest";
import { parseGameVersion } from "../../src/game/version.js";

describe("parseGameVersion", () => {
	it("reads the version from the real first line", () => {
		// 真机样本（OpenTTD 15.3, macOS Steam build）
		expect(parseGameVersion("OpenTTD 15.3\n\n\nCommand line options:\n")).toBe("15.3");
	});

	it("accepts a three-part version", () => {
		expect(parseGameVersion("OpenTTD 15.3.1\n")).toBe("15.3.1");
	});

	it("tolerates the version appearing later in the output", () => {
		expect(parseGameVersion("noise\nOpenTTD 14.0\nmore\n")).toBe("14.0");
	});

	it("returns null when there is no version to read", () => {
		// Unknown is a legitimate outcome: the run's provenance is incomplete, and
		// pretending otherwise is worse than saying so.
		expect(parseGameVersion("")).toBeNull();
		expect(parseGameVersion("Command line options:\n  -v drv = Set video driver\n")).toBeNull();
		expect(parseGameVersion("OpenTTD (no version)")).toBeNull();
	});
});
