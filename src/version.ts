/**
 * App version — one source of truth.
 *
 * 职责: 读 `package.json` 的 version 并对外暴露，供 CLI `--version`、
 *   session 归档与 dashboard 展示使用。
 * 为什么重要: 用户报障时需要知道"跑的是哪个版本"；归档的 session 也应自描述，
 *   否则事后无法把日志对应到代码。见 AGENTS.md §5.1（E2E/审计要求）。
 * 事实来源: package.json（唯一版本来源）；CHANGELOG 的条目必须与之匹配
 *   （由 test/unit/version.test.ts 强制）。
 * 禁止: 在此硬编码版本号（会与 package.json 漂移）；读取失败时不得抛异常。
 */

import { readFileSync } from "node:fs";

/** Fallback when package.json is unreadable (should not happen in a real install). */
const UNKNOWN = "0.0.0-unknown";

function readVersion(): string {
	try {
		// ../package.json relative to src/version.ts (and dist/version.js).
		const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" && parsed.version.trim()
			? parsed.version.trim()
			: UNKNOWN;
	} catch {
		return UNKNOWN;
	}
}

/** The application version (e.g. "0.6.0"). Never throws. */
export const APP_VERSION: string = readVersion();
