/**
 * Game version — which OpenTTD build a run actually used.
 *
 * 职责: 读出本机 OpenTTD 二进制报告的版本号（`--version` 的第一行），供这次运行
 *   记录到会话与度量行。
 * 为什么是必须记录的事实: 同一个 seed 在 15.0 与 15.3 上不是同一个世界 —— 施工、
 *   经济、AI 行为都可能变。没有版本号，"两次运行可比"就少了一个前提；而且它无法
 *   从任何配置里推断（配置里只有二进制路径）。
 * 事实来源: 真机实测 `openttd --version` → `OpenTTD 15.3`。
 * 禁止: 抛异常（版本读不到时返回 null：**未知**，不是"和上次一样"）；
 *   禁止把整段 usage 文本写进记录（只留版本号）。
 */

import { execFile } from "node:child_process";

/** Parse a version out of `openttd --version` output. Pure; unit-tested. */
export function parseGameVersion(output: string): string | null {
	const m = /OpenTTD\s+(\d+\.\d+(?:\.\d+)?)/i.exec(output);
	return m?.[1] ?? null;
}

/**
 * Read the version of the configured binary.
 *
 * Returns `null` when the binary is missing or does not answer in time; a run
 * with an unknown version is still a run, but its provenance is incomplete.
 */
export async function readGameVersion(binary: string, timeoutMs = 5_000): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(binary, ["--version"], { timeout: timeoutMs }, (err, stdout, stderr) => {
			// OpenTTD prints its version and then the option list, and exits non-zero
			// when given only `--version`; the text is what matters, not the code.
			const text = `${stdout ?? ""}\n${stderr ?? ""}`;
			const parsed = parseGameVersion(text);
			if (parsed) return resolve(parsed);
			void err;
			resolve(null);
		});
	});
}
