/**
 * Unit tests — the benchmark matrix carries its own provider state (issue #1).
 *
 * 职责: 锁定"每一格是独立 data dir"与"key 只存在于仓库之外"这两条怎么共存:
 *   凭证必须**复制**进每一格（否则每格都因为"没有凭证"失败），而且
 *   **只复制不打印**、权限 0600、缺文件**在跑第一格之前**就说清楚。
 * 为什么存在: 每格独立目录是为了"记忆不得跨格"；而 key 不能进仓库 ⇒ 不复制
 *   进去，矩阵会跑到一半才失败，已经烧掉的 token 与时间全部白花。
 *   同理，走**目录**（catalog）provider 的模型清单存在 `<dataDir>/models-cache.json`
 *   ⇒ 新目录里没有它 ⇒ 第一格就会说"provider 不认识这个模型"。
 * 禁止: 在此断言任何 key 的内容（测试里只用假的字符串）。
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	checkCredentials,
	checkModelsCache,
	checkLlmSettings,
	installCredentials,
	installLlmSettings,
	installModelsCache,
} from "../../scripts/bench.js";
import { gamePidsToKill } from "../../scripts/lib/game-cleanup.js";

function tmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("矩阵的每一格带着自己的 provider 状态", () => {
	it("凭证被复制进那一格，权限 0600", () => {
		const src = join(tmpDir("bcred-src-"), "credentials.json");
		writeFileSync(src, '{"minimax-cn":{"type":"api_key","key":"sk-test-not-a-real-key"}}', "utf8");
		const cell = tmpDir("bcred-cell-");
		installCredentials(src, cell);
		const target = join(cell, "credentials.json");
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(target, "utf8")).toContain("sk-test-not-a-real-key");
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("两格各有一份 ⇒ 互不共享（格子之间不共享任何东西）", () => {
		const src = join(tmpDir("bcred-src-"), "credentials.json");
		writeFileSync(src, '{"p":{"key":"k"}}', "utf8");
		const a = tmpDir("bcred-a-");
		const b = tmpDir("bcred-b-");
		installCredentials(src, a);
		installCredentials(src, b);
		expect(join(a, "credentials.json")).not.toBe(join(b, "credentials.json"));
		expect(existsSync(join(a, "credentials.json"))).toBe(true);
		expect(existsSync(join(b, "credentials.json"))).toBe(true);
	});

	it("源文件权限太宽时，目标仍然是 0600", () => {
		const src = join(tmpDir("bcred-src-"), "credentials.json");
		writeFileSync(src, '{"p":{"key":"k"}}', "utf8");
		chmodSync(src, 0o644);
		const cell = tmpDir("bcred-cell-");
		installCredentials(src, cell);
		expect(statSync(join(cell, "credentials.json")).mode & 0o777).toBe(0o600);
	});

	it("缺凭证文件 ⇒ 跑矩阵**之前**就报出来", () => {
		expect(() => checkCredentials("/definitely/not/here/credentials.json")).toThrow(/not found/);
	});

	it("没给凭证文件 ⇒ 不报错（离线矩阵用 stub，不需要 key）", () => {
		expect(() => checkCredentials(undefined)).not.toThrow();
	});

	it("provider 的模型清单被复制进那一格（目录 provider 靠它认模型）", () => {
		const src = join(tmpDir("bmc-src-"), "models-cache.json");
		writeFileSync(src, '{"minimax-cn":{"models":[{"id":"m-1"}]}}', "utf8");
		const cell = tmpDir("bmc-cell-");
		installModelsCache(src, cell);
		expect(existsSync(join(cell, "models-cache.json"))).toBe(true);
		expect(readFileSync(join(cell, "models-cache.json"), "utf8")).toContain("m-1");
	});

	it("缺模型清单 ⇒ 跑矩阵之前就报出来", () => {
		expect(() => checkModelsCache("/definitely/not/here/models-cache.json")).toThrow(/not found/);
		expect(() => checkModelsCache(undefined)).not.toThrow();
	});
});

/**
 * 矩阵的清理**只杀矩阵自己起的游戏**（2026-11-16）。
 *
 * 为什么: `pkill -f openttd` 会把**用户自己的实例**一起杀掉（MEMORY §0.4）。
 * 矩阵的游戏进程命令行里带 `-D <dataDir>` ⇒ 按矩阵根目录过滤就是精确的。
 */
describe("矩阵的游戏清理不会误伤用户的实例", () => {
	const ps = [
		"  71053 node /Users/greener/project/openttd-agent/node_modules/.pnpm/typescript",
		"  81122 /Users/greener/Library/Application Support/Steam/steamapps/common/OpenTTD/OpenTTD.app/Contents/MacOS/openttd -D /tmp/pE2/MiniMax-M3.1-Flash/seed-11/rep-1",
		"  82233 /Users/greener/Library/Application Support/Steam/steamapps/common/OpenTTD/OpenTTD.app/Contents/MacOS/openttd -D /Users/greener/Documents/OpenTTD",
	].join("\n");

	it("只杀数据目录在矩阵根目录下的游戏", () => {
		expect(gamePidsToKill(ps, "/tmp/pE2")).toEqual([81122]);
	});

	it("用户的实例（别的数据目录）不被杀", () => {
		expect(gamePidsToKill(ps, "/tmp/pE2")).not.toContain(82233);
	});

	it("没有矩阵进程时什么都不杀（不是 pkill 的『没有就报错』）", () => {
		expect(gamePidsToKill("", "/tmp/pE2")).toEqual([]);
	});
});

/**
 * 矩阵每格都要有 **provider 配置**（`llm.json`）：没有它，每格的闸会说
 * "no provider/model configured" ⇒ 矩阵一格都跑不起来（实测：6 格 5 秒全败）。
 */
describe("矩阵每格的 provider 配置", () => {
	it("llm.json 被复制进每格，且权限是 0600（它可能带 key）", () => {
		const dir = tmpDir("bench-llm-");
		const src = join(dir, "source.json");
		writeFileSync(src, JSON.stringify({ providerId: "minimax-cn", apiKey: "secret" }), "utf8");
		const cell = join(dir, "cell");
		mkdirSync(cell, { recursive: true });
		installLlmSettings(src, cell);
		const copied = join(cell, "llm.json");
		expect(existsSync(copied)).toBe(true);
		expect(statSync(copied).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(copied, "utf8")).providerId).toBe("minimax-cn");
	});

	it("缺文件时**跑前**报错（不是跑到一半才失败）", () => {
		expect(() => checkLlmSettings("/nonexistent/llm.json")).toThrow(/not found/);
	});
});

/**
 * 连跑实验（E3）的清理**只杀它自己起的游戏**（2026-11-16）。
 *
 * 与矩阵同一件事：宽泛的 `pkill -f openttd` 会连**用户自己的实例**一起杀掉。
 */
describe("连跑实验的清理不会误伤用户的实例", () => {
	const ps = [
		"  71053 node /Users/greener/project/openttd-agent/node_modules/.pnpm/typescript",
		"  81122 /Users/greener/Library/Application Support/Steam/steamapps/common/OpenTTD/OpenTTD.app/Contents/MacOS/openttd -D /tmp/pE3",
		"  82233 /Users/greener/Library/Application Support/Steam/steamapps/common/OpenTTD/OpenTTD.app/Contents/MacOS/openttd -D /Users/greener/Documents/OpenTTD",
	].join("\n");

	it("只杀数据目录在实验目录下的游戏", () => {
		expect(gamePidsToKill(ps, "/tmp/pE3")).toEqual([81122]);
	});
});
